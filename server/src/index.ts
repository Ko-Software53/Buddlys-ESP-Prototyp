import dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';

// .env-Hot-Reload: bei Änderungen sofort neu einlesen (override),
// damit Modell-/Sprach-Wechsel ohne Server-Restart greifen.
// fs.watchFile (Polling, 500 ms) statt fs.watch — überlebt atomare
// Datei-Replaces, mit denen viele Editoren speichern (macOS-Klassiker).
const envPath = path.resolve(process.cwd(), '.env');
fs.watchFile(envPath, { interval: 500 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  const result = dotenv.config({ override: true });
  if (result.error) {
    console.log('[env] reload fehlgeschlagen:', result.error.message);
  } else {
    console.log('[env] .env neu geladen');
  }
});

import { WebSocketServer, WebSocket } from 'ws';
import { ConversationSession, buildSystemPrompt, type ChildProfile } from './mistralChat.js';
import { classifyConversation } from './analytics.js';
import { transcribeAudio } from './mistralStt.js';
import { openCartesiaSession } from './cartesiaTts.js';
import { openMistralTtsSession } from './mistralTts.js';
import { openOmniVoiceSession } from './omnivoiceTts.js';
import { SentenceChunker } from './chunker.js';
import { preloadFillers, pickFiller } from './fillerCache.js';
import { spellOutNumbers } from './numberToWords.js';
import { getDeviceConfig, touchDevice, updateDeviceBattery, createConversation, appendMessage, finalizeConversation, tagConversation, flagConversation } from './supabase.js';

const PORT = Number(process.env.PORT) || 3001;

const app = express();

// CORS für Browser-Client auf 5173 → 3001
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: process.env.MISTRAL_MODEL || 'mistral-small-2506' });
});

// STT: Audio-Blob rein, Transkript raus.
app.post(
  '/stt',
  express.raw({ type: '*/*', limit: '25mb' }),
  async (req, res) => {
    try {
      const mimeType = req.headers['content-type'] || 'audio/webm';
      const buf = req.body as Buffer;
      if (!buf || !buf.length) {
        res.status(400).json({ error: 'leerer Audio-Body' });
        return;
      }
      const t0 = Date.now();
      const text = await transcribeAudio(buf, mimeType);
      console.log(`[stt] ${Date.now() - t0}ms  "${text}"`);
      res.json({ text });
    } catch (err) {
      console.error('[stt]', err);
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Process-level safety net ───────────────────────────────────────────────
// This is a multi-client realtime server: every connected toy shares ONE Node
// process. On modern Node an unhandled promise rejection terminates the process
// by default — so a single rejected fire-and-forget promise (e.g. a Supabase
// write in `void appendMessage(...)`, a TTS/STT fetch) would crash the server
// and drop EVERY toy's WebSocket at once (the toys then see a 1006 close and
// reconnect). One bad background write must never do that. Log and keep serving
// instead. (uncaughtException is logged too; we deliberately do NOT exit, since
// exiting is exactly the "drop everyone" failure we're preventing — the known
// risks here are async rejections, where process state stays intact.)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

type ReasoningMode = 'auto' | 'always' | 'never';
type TtsProvider = 'cartesia' | 'mistral' | 'omnivoice';

interface TtsSession {
  send(transcript: string, isFinal: boolean): void;
  onChunk(cb: (pcm: Buffer) => void): void;
  done: Promise<void>;
  close(): void;
  sampleRate: number;
  encoding: 'pcm_s16le';
  isClosed?(): boolean;
}
type ClientMsg =
  | { type: 'user_text'; text: string; reasoning?: ReasoningMode; model?: string; tts?: boolean; temperature?: number; ttsProvider?: TtsProvider; device_id?: string }
  | { type: 'config'; device_id?: string; model?: string; reasoning?: ReasoningMode; tts?: boolean; ttsProvider?: TtsProvider; audioBinary?: boolean }
  | { type: 'battery'; device_id: string; level: number }
  | { type: 'audio_start' }
  | { type: 'audio_end' }
  | { type: 'audio_cancel' }
  | { type: 'reset' };

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Wrap raw PCM (default 16 kHz mono s16le, what the device streams) in a 44-byte
 *  WAV header so the existing STT path can treat it like any other audio file. */
function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);          // fmt chunk size
  h.writeUInt16LE(1, 20);           // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function sendLatency(ws: WebSocket, label: string, ms: number) {
  console.log(`[lat] ${label}: ${ms}ms`);
  safeSend(ws, { type: 'latency', label, ms });
}

/** True, wenn der Text mindestens einen Buchstaben oder eine Ziffer enthält. */
function isSpeakable(text: string): boolean {
  return /\p{L}|\p{N}/u.test(text);
}

/** Bereitet Text für TTS vor: Satzende-Punkt nach Ziffern entfernen,
 *  dann alle Zahlen auf Deutsch ausschreiben ("42" → "zweiundvierzig"). */
function fixTtsNumbers(text: string): string {
  const stripped = text.replace(/(\d)\.(\s|$)/g, '$1$2');
  return spellOutNumbers(stripped);
}

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  // Keep the connection alive with pings every 5 seconds.
  // This prevents the ESP32's 20-second network_timeout_ms from dropping the connection
  // if the STT or LLM takes longer than 20 seconds to respond.
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
      safeSend(ws, { type: 'ping' });
    }
  }, 2000);

  const session = new ConversationSession();
  const sessionStart = Date.now();
  let sessionPromptTokens = 0;
  let sessionCompletionTokens = 0;
  let sessionTurns = 0;

  // Supabase state: set on first user_text with a device_id
  let currentConversationId: string | null = null;
  let deviceRowId: string | null = null;
  let deviceOwnerId: string | null = null;

  // Per-device overrides from the Supabase `devices` row (set by the app).
  // These take priority over the device-sent `config` frame so the app — not the
  // hardcoded firmware settings.h — controls the toy's tts/model. Cached for
  // the connection; the toy picks up app changes on its next (re)connect.
  let deviceTtsProvider: TtsProvider | undefined;
  let deviceModel: string | undefined;

  // The hardware device sets config.audioBinary=true to receive TTS as raw-binary
  // WS frames (16 kHz mono s16le, no base64/JSON wrapper) — ~33% less downlink and
  // no per-chunk decode on the toy. Negotiated per connection: the web client and
  // any pre-flash firmware omit the flag and keep the JSON audio_chunk path.
  let wantsBinaryAudio = false;

  // Emit one PCM audio chunk to this client in its negotiated framing. For binary
  // clients the metadata (sampleRate/encoding) is implicit (always 16 kHz s16le,
  // which the device assumes anyway); JSON clients still get it in the frame.
  const emitAudio = (pcm: Buffer, sampleRate: number, encoding: 'pcm_s16le') => {
    if (ws.readyState !== ws.OPEN) return;
    const MAX_CHUNK = 4096;
    for (let offset = 0; offset < pcm.length; offset += MAX_CHUNK) {
      const chunk = pcm.subarray(offset, offset + MAX_CHUNK);
      if (wantsBinaryAudio) {
        ws.send(chunk);
      } else {
        ws.send(JSON.stringify({
          type: 'audio_chunk',
          encoding,
          sampleRate,
          audioBase64: chunk.toString('base64')
        }));
      }
    }
  };

  // Per-conversation analytics state
  let convStartedAt = 0;
  let lastActivityAt = 0;
  let convMessageCount = 0;
  // Set when a turn expected speech but emitted no audio (TTS provider failed).
  // Used by finalizeCurrent's heuristic to auto-flag a broken dialog.
  let convHadTtsError = false;

  // Finalize the current conversation: persist duration + message count, then
  // tag it with topics/summary (best-effort, fire-and-forget). Reads the session
  // transcript, so call BEFORE session.reset() clears history.
  const finalizeCurrent = () => {
    if (!currentConversationId) return;
    const id = currentConversationId;
    const startedAt = convStartedAt || sessionStart;
    const durationSeconds = Math.max(0, ((lastActivityAt || Date.now()) - startedAt) / 1000);
    const messageCount = convMessageCount;
    const transcript = session.history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !!m.content)
      .map((m) => `${m.role === 'user' ? 'Kind' : 'Buddly'}: ${m.content}`)
      .join('\n');

    void finalizeConversation(id, { durationSeconds, messageCount });
    if (transcript.trim()) {
      void classifyConversation(transcript).then((ins) => {
        if (ins) void tagConversation(id, ins.topics, ins.summary, ins.useCase);
      });
    }

    // Auto-flag broken dialogs so educators can spot them. Heuristics:
    //  - a TTS failure left the toy mute this conversation, or
    //  - the child spoke but got essentially no exchange (≤1 message), or
    //  - a real exchange happened yet was extremely short (likely a misfire).
    const reasons: string[] = [];
    if (convHadTtsError) reasons.push('TTS lieferte kein Audio (Spielzeug stumm)');
    if (messageCount <= 1) reasons.push('Kein echter Dialog (≤1 Nachricht)');
    else if (durationSeconds < 5) reasons.push('Sehr kurzer Dialog (<5s)');
    if (reasons.length) void flagConversation(id, reasons.join('; '));

    currentConversationId = null;
    convMessageCount = 0;
    convHadTtsError = false;
  };

  // Per-connection turn defaults, set by a 'config' message from the device.
  // Binary audio frames carry no metadata, so we remember model/reasoning/etc.
  // here and apply them to every transcribed turn.
  let turnCfg: {
    model?: string;
    reasoning?: ReasoningMode;
    ttsProvider?: TtsProvider;
    tts?: boolean;
    device_id?: string;
  } = {};

  // Streamed audio upload: the device streams raw PCM (16 kHz mono s16le) frames
  // while the child is still talking, bracketed by audio_start/audio_end control
  // frames, so the upload overlaps speech instead of blocking after it. Buffer
  // the chunks and assemble a WAV on audio_end, then run the normal STT turn.
  let audioStreaming = false;
  let audioChunks: Buffer[] = [];

  interface TurnParams {
    text: string;
    reasoning?: ReasoningMode;
    model?: string;
    temperature?: number;
    tts?: boolean;
    ttsProvider?: TtsProvider;
    device_id?: string;
  }

  const handleTurn = async (p: TurnParams) => {
    // Resolve device config from Supabase if a hardware device_id was sent
    if (p.device_id && !deviceRowId) {
      const dev = await getDeviceConfig(p.device_id!);
      if (dev) {
        deviceRowId = dev.id;
        deviceOwnerId = dev.owner_id;
        session.setSystemPrompt(buildSystemPrompt(dev as ChildProfile));
        // App-selected overrides (devices.tts_provider / model columns).
        const tp = dev.tts_provider as string | undefined;
        if (tp === 'cartesia' || tp === 'mistral' || tp === 'omnivoice') deviceTtsProvider = tp;
        if (typeof dev.model === 'string' && dev.model.trim()) deviceModel = dev.model.trim();
        void touchDevice(p.device_id!);
        console.log(`[supabase] device resolved: ${dev.id} (profile applied, tts=${deviceTtsProvider ?? '—'} model=${deviceModel ?? '—'})`);
      }
    }

    // Start a new conversation in Supabase for this turn session
    if (!currentConversationId && deviceRowId && deviceOwnerId) {
      currentConversationId = await createConversation(deviceRowId, deviceOwnerId);
      convStartedAt = Date.now();
      convMessageCount = 0;
      convHadTtsError = false;
    }

    const reasoning: ReasoningMode =
      p.reasoning === 'always' || p.reasoning === 'never' ? p.reasoning : 'auto';
    const ttsEnabled = p.tts !== false;
    // App selection (Supabase) wins over the device-sent config frame.
    const requestedProvider = deviceTtsProvider ?? p.ttsProvider;
    const ttsProvider: TtsProvider =
      requestedProvider === 'omnivoice' || requestedProvider === 'mistral'
        ? requestedProvider
        : 'cartesia';
    const model = deviceModel ?? p.model ?? undefined;
    const temperature = typeof p.temperature === 'number' ? Math.min(1.5, Math.max(0, p.temperature)) : undefined;
    const t0 = Date.now();
    let firstTokenLogged = false;
    let firstAudioLogged = false;

    let tts: TtsSession | null = null;

    // Paced audio emit. TTS produces audio FASTER than realtime, but the toy can
    // only buffer ~8s (jitter ring `s_jbuf` + 32-block intake queue). Dumping a
    // long reply at once overruns it → "pcm queue full — dropped chunk" on the
    // device → audio cuts out mid-sentence. So we throttle sends to stay at most
    // AUDIO_LEAD_MS ahead of realtime playback: in-flight audio is bounded well
    // under the toy's buffer (no drops) while a multi-second lead keeps a big
    // jitter cushion (no underrun). First-audio latency is unchanged — only the
    // later chunks are delayed. Chunks are serialized on a promise chain so they
    // keep order and the accumulated delay is correct regardless of how fast the
    // TTS onChunk callback fires.
    const AUDIO_LEAD_MS = 6500;
    let emittedAudioMs = 0;          // total audio duration enqueued this turn (ms)
    let firstEmitAt = 0;             // wall-clock of the first emitted chunk
    let paceChain: Promise<void> = Promise.resolve();

    const pacedEmit = (pcm: Buffer, sampleRate: number, encoding: 'pcm_s16le') => {
      const durMs = (pcm.length / 2 / sampleRate) * 1000; // s16le mono: 2 bytes/sample
      const myAudioMs = emittedAudioMs;                   // this chunk's start offset
      emittedAudioMs += durMs;
      paceChain = paceChain.then(async () => {
        if (ws.readyState !== ws.OPEN) return;
        if (!firstEmitAt) firstEmitAt = Date.now();
        const aheadMs = myAudioMs - (Date.now() - firstEmitAt);
        if (aheadMs > AUDIO_LEAD_MS) {
          await new Promise((r) => setTimeout(r, aheadMs - AUDIO_LEAD_MS));
          if (ws.readyState !== ws.OPEN) return;
        }
        emitAudio(pcm, sampleRate, encoding);
      });
    };

    const logFirstAudio = () => {
      if (firstAudioLogged) return;
      firstAudioLogged = true;
      sendLatency(ws, 'first audio out', Date.now() - t0);
    };

    /** Pre-rendered Filler-Audio (Cartesia-PCM aus dem Cache). */
    const playFiller = () => {
      if (!ttsEnabled) return;
      const f = pickFiller();
      if (!f) return;
      logFirstAudio();
      pacedEmit(f.pcm, f.sampleRate, f.encoding);
      safeSend(ws, { type: 'text_delta', text: f.text + ' ' });
    };

    // Start TTS session immediately in the background — don't await here so the
    // LLM fetch can start in parallel. By the time the first sentence is ready
    // (~300 ms+), the WS handshake (~100 ms) is already done.
    const ttsT0 = Date.now();
    let ttsPromise: Promise<TtsSession | null> | null = ttsEnabled
      ? (ttsProvider === 'mistral'
          ? openMistralTtsSession()
          : ttsProvider === 'omnivoice'
          ? openOmniVoiceSession()
          : openCartesiaSession()
        ).then((s) => {
          sendLatency(ws, `tts session open (${ttsProvider})`, Date.now() - ttsT0);
          return s;
        }).catch((err) => {
          console.error('[tts open]', err);
          return null;
        })
      : Promise.resolve(null);

    // Lazily await TTS and register the chunk callback exactly once.
    const ensureTts = async (): Promise<boolean> => {
      if (tts) {
        if (tts.isClosed && tts.isClosed()) {
          console.log('[tts] Session closed (likely timeout), recreating...');
          tts = null;
          ttsPromise = (ttsProvider === 'mistral'
              ? openMistralTtsSession()
              : ttsProvider === 'omnivoice'
              ? openOmniVoiceSession()
              : openCartesiaSession()
            ).catch(() => null);
        } else {
          return true;
        }
      }
      tts = await ttsPromise;
      if (!tts) return false;
      tts.onChunk((pcm) => {
        if (!pcm.length) return;
        logFirstAudio();
        pacedEmit(pcm, tts!.sampleRate, tts!.encoding);
      });
      return true;
    };

    // Persist user message
    void appendMessage(currentConversationId!, 'user', p.text);
    if (currentConversationId) { convMessageCount++; lastActivityAt = Date.now(); }

    let assistantText = '';

    try {
      const chunker = ttsEnabled ? new SentenceChunker({ minLen: 10, maxLen: 120 }) : null;
      let llmOutputThisRound = false;

      const pushChunk = async (text: string, isFinal: boolean) => {
        if (!ttsEnabled || !await ensureTts()) return;
        const cleaned = fixTtsNumbers(text);
        if (isSpeakable(cleaned)) tts!.send(cleaned, isFinal);
        else if (isFinal) tts!.send('', true);
      };

      for await (const ev of session.send(p.text, { reasoning, model, temperature })) {
        if (ev.type === 'delta') {
          if (!firstTokenLogged) {
            firstTokenLogged = true;
            sendLatency(ws, 'first text token', Date.now() - t0);
          }
          safeSend(ws, { type: 'text_delta', text: ev.text });
          assistantText += ev.text;
          llmOutputThisRound = true;
          if (chunker) {
            for (const c of chunker.push(ev.text)) await pushChunk(c, false);
          }
        } else if (ev.type === 'tool_call_pending') {
          sendLatency(ws, `tool start (${ev.name})`, Date.now() - t0);
          // Rest aus dem Chunker raus — kann der LLM-Intro-Satz sein
          if (chunker) {
            const tail = chunker.flush();
            if (tail) await pushChunk(tail, false);
          }
          if (!llmOutputThisRound) {
            // LLM hat nichts gesagt vor dem Tool-Call → canned Filler als Brücke
            playFiller();
          }
          llmOutputThisRound = false;
        } else if (ev.type === 'tool_result') {
          sendLatency(ws, `tool done (${ev.name})`, ev.ms);
          console.log(`[tool] ${ev.name} → ${ev.preview}`);
        } else if (ev.type === 'usage') {
          sessionTurns++;
          sessionPromptTokens += ev.promptTokens;
          sessionCompletionTokens += ev.completionTokens;
          const sessionMinutes = (Date.now() - sessionStart) / 60000;
          const sessionTotal = sessionPromptTokens + sessionCompletionTokens;
          const perMin = sessionMinutes > 0 ? Math.round(sessionTotal / sessionMinutes) : 0;
          console.log(
            `[tokens] turn #${sessionTurns}: ${ev.promptTokens}p + ${ev.completionTokens}c` +
            ` | session: ${sessionPromptTokens}p + ${sessionCompletionTokens}c = ${sessionTotal}` +
            ` | ${sessionMinutes.toFixed(1)}min | ø ${perMin} tok/min`,
          );
          safeSend(ws, {
            type: 'usage',
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            sessionPromptTokens,
            sessionCompletionTokens,
            sessionTurns,
            sessionMinutes: Math.round(sessionMinutes * 10) / 10,
          });
        } else if (ev.type === 'done') {
          // ignore — finalisieren unten
        }
      }

      // Finalisieren: letzten Chunk mit isFinal=true rausgeben
      if (ttsEnabled) {
        const tail = chunker?.flush() ?? null;
        if (tail) {
          await pushChunk(tail, true);
        } else if (await ensureTts()) {
          tts!.send('', true);
        }
        const doneTts = tts as TtsSession | null;
        if (doneTts) {
          await Promise.race([
            doneTts.done,
            new Promise((r) => setTimeout(r, 10000))
          ]);
          sendLatency(ws, 'tts done', Date.now() - t0);
        }
      }

      // Persist assistant reply
      if (assistantText.trim()) {
        void appendMessage(currentConversationId!, 'assistant', assistantText.trim());
        if (currentConversationId) { convMessageCount++; lastActivityAt = Date.now(); }
      }

      // Surface silent TTS failures: if speech was expected but no audio frame
      // ever went out, the provider failed/was swallowed. Tell the device so it
      // shows an error (red) instead of sitting mute — this is what made "toy
      // won't talk" undiagnosable before.
      if (ttsEnabled && !firstAudioLogged && assistantText.trim()) {
        console.error(`[tts] no audio emitted for provider=${ttsProvider} — text was "${assistantText.slice(0, 60)}"`);
        convHadTtsError = true;
        safeSend(ws, { type: 'error', message: `tts produced no audio (${ttsProvider})` });
      }

      // All chunks are enqueued, but pacing may still be holding back the tail.
      // Wait for the paced queue to flush before `done` — `done` tells the toy
      // the stream is over (s_stream_active=false), so it must not race ahead of
      // the throttled final chunks or the end of the reply gets cut.
      await paceChain;

      sendLatency(ws, 'total', Date.now() - t0);
      safeSend(ws, { type: 'done' });
    } catch (err) {
      console.error('[err]', err);
      safeSend(ws, { type: 'error', message: (err as Error).message });
    } finally {
      (tts as TtsSession | null)?.close();
    }
  };

  // STT for device audio sent over the WebSocket as a binary WAV frame. Reuses
  // the persistent connection, so the device pays no per-turn TLS handshake
  // (the old HTTPS /stt POST opened a fresh TLS connection on every turn).
  const handleAudio = async (wav: Buffer) => {
    const t0 = Date.now();
    let text = '';
    try {
      text = await transcribeAudio(wav, 'audio/wav');
    } catch (err) {
      console.error('[stt-ws]', err);
      safeSend(ws, { type: 'error', message: (err as Error).message });
      return;
    }
    console.log(`[stt-ws] ${Date.now() - t0}ms  "${text}"`);
    if (!text.trim()) { safeSend(ws, { type: 'done' }); return; }
    await handleTurn({ text, ...turnCfg });
  };

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {
      // While streaming, binary frames are raw-PCM chunks; otherwise it's a
      // single complete WAV (legacy path used by the web client / probes).
      if (audioStreaming) { audioChunks.push(raw as Buffer); return; }
      await handleAudio(raw as Buffer);
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      safeSend(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }
    if (msg?.type === 'reset') {
      finalizeCurrent();
      session.reset();
      sessionPromptTokens = 0;
      sessionCompletionTokens = 0;
      sessionTurns = 0;
      currentConversationId = null;
      safeSend(ws, { type: 'done' });
      return;
    }
    if (msg?.type === 'audio_start') {
      audioStreaming = true;
      audioChunks = [];
      return;
    }
    if (msg?.type === 'audio_cancel') {
      audioStreaming = false;
      audioChunks = [];
      return;
    }
    if (msg?.type === 'audio_end') {
      audioStreaming = false;
      const pcm = Buffer.concat(audioChunks);
      audioChunks = [];
      if (pcm.length) await handleAudio(pcmToWav(pcm));
      else safeSend(ws, { type: 'done' });
      return;
    }
    if (msg?.type === 'battery') {
      if (msg.device_id && typeof msg.level === 'number' && Number.isFinite(msg.level)) {
        void updateDeviceBattery(msg.device_id, msg.level);
        console.log(`[battery] ${msg.device_id}: ${msg.level}%`);
      }
      return;
    }
    if (msg?.type === 'config') {
      turnCfg = {
        model: msg.model,
        reasoning: msg.reasoning,
        ttsProvider: msg.ttsProvider,
        tts: msg.tts,
        device_id: msg.device_id,
      };
      wantsBinaryAudio = msg.audioBinary === true;
      console.log(`[config] device=${msg.device_id ?? '?'} model=${msg.model ?? 'default'} tts=${msg.ttsProvider ?? 'cartesia'} audio=${wantsBinaryAudio ? 'binary' : 'json'}`);
      return;
    }
    if (msg?.type !== 'user_text' || typeof msg.text !== 'string' || !msg.text.trim()) {
      return;
    }
    await handleTurn({
      text: msg.text,
      reasoning: msg.reasoning,
      model: msg.model,
      temperature: msg.temperature,
      tts: msg.tts,
      ttsProvider: msg.ttsProvider,
      device_id: msg.device_id,
    });
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    finalizeCurrent();
    console.log('[ws] client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(
    `Buddlys server: http://localhost:${PORT}  |  ws: ws://localhost:${PORT}/ws`,
  );
  // Filler-Audios im Hintergrund vorrendern (blockiert nichts).
  void preloadFillers();
});
