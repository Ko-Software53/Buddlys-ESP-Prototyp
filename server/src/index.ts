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
import { ConversationSession } from './mistralChat.js';
import { transcribeAudio } from './mistralStt.js';
import { openCartesiaSession } from './cartesiaTts.js';
import { openMistralTtsSession } from './mistralTts.js';
import { openOmniVoiceSession } from './omnivoiceTts.js';
import { SentenceChunker } from './chunker.js';
import { preloadFillers, pickFiller } from './fillerCache.js';
import { spellOutNumbers } from './numberToWords.js';
import { getDeviceConfig, touchDevice, createConversation, appendMessage } from './supabase.js';

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

type ReasoningMode = 'auto' | 'always' | 'never';
type TtsProvider = 'cartesia' | 'mistral' | 'omnivoice';

interface TtsSession {
  send(text: string, isFinal: boolean): void;
  onChunk(cb: (pcm: Buffer) => void): void;
  done: Promise<void>;
  close(): void;
  sampleRate: number;
  encoding: 'pcm_s16le';
}
type ClientMsg =
  | { type: 'user_text'; text: string; reasoning?: ReasoningMode; model?: string; tts?: boolean; temperature?: number; ttsProvider?: TtsProvider; device_id?: string }
  | { type: 'reset' };

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
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

  const session = new ConversationSession();
  const sessionStart = Date.now();
  let sessionPromptTokens = 0;
  let sessionCompletionTokens = 0;
  let sessionTurns = 0;

  // Supabase state: set on first user_text with a device_id
  let currentConversationId: string | null = null;
  let deviceRowId: string | null = null;
  let deviceOwnerId: string | null = null;

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      safeSend(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }
    if (msg?.type === 'reset') {
      session.reset();
      sessionPromptTokens = 0;
      sessionCompletionTokens = 0;
      sessionTurns = 0;
      currentConversationId = null;
      safeSend(ws, { type: 'done' });
      return;
    }
    if (msg?.type !== 'user_text' || typeof msg.text !== 'string' || !msg.text.trim()) {
      return;
    }

    // Resolve device config from Supabase if a hardware device_id was sent
    if (msg.device_id && !deviceRowId) {
      const dev = await getDeviceConfig(msg.device_id!);
      if (dev) {
        deviceRowId = dev.id;
        deviceOwnerId = dev.owner_id;
        void touchDevice(msg.device_id!);
        console.log(`[supabase] device resolved: ${dev.id}`);
      }
    }

    // Start a new conversation in Supabase for this turn session
    if (!currentConversationId && deviceRowId && deviceOwnerId) {
      currentConversationId = await createConversation(deviceRowId, deviceOwnerId);
    }

    const reasoning: ReasoningMode =
      msg.reasoning === 'always' || msg.reasoning === 'never' ? msg.reasoning : 'auto';
    const ttsEnabled = msg.tts !== false;
    const ttsProvider: TtsProvider =
      msg.ttsProvider === 'omnivoice' || msg.ttsProvider === 'mistral'
        ? msg.ttsProvider
        : 'cartesia';
    const model = msg.model || undefined;
    const temperature = typeof msg.temperature === 'number' ? Math.min(1.5, Math.max(0, msg.temperature)) : undefined;
    const t0 = Date.now();
    let firstTokenLogged = false;
    let firstAudioLogged = false;

    let tts: TtsSession | null = null;

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
      safeSend(ws, {
        type: 'audio_chunk',
        encoding: f.encoding,
        sampleRate: f.sampleRate,
        audioBase64: f.pcm.toString('base64'),
      });
      safeSend(ws, { type: 'text_delta', text: f.text + ' ' });
    };

    // Start TTS session immediately in the background — don't await here so the
    // LLM fetch can start in parallel. By the time the first sentence is ready
    // (~300 ms+), the WS handshake (~100 ms) is already done.
    const ttsT0 = Date.now();
    const ttsPromise: Promise<TtsSession | null> = ttsEnabled
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
      if (tts) return true;
      tts = await ttsPromise;
      if (!tts) return false;
      tts.onChunk((pcm) => {
        if (!pcm.length) return;
        logFirstAudio();
        safeSend(ws, {
          type: 'audio_chunk',
          encoding: tts!.encoding,
          sampleRate: tts!.sampleRate,
          audioBase64: pcm.toString('base64'),
        });
      });
      return true;
    };

    // Persist user message
    void appendMessage(currentConversationId!, 'user', msg.text);

    let assistantText = '';

    try {
      const chunker = ttsEnabled ? new SentenceChunker({ minLen: 10, maxLen: 120 }) : null;
      let llmOutputThisRound = false;

      const pushChunk = async (text: string, isFinal: boolean) => {
        if (!ttsEnabled || !await ensureTts()) return;
        const cleaned = fixTtsNumbers(text);
        if (isSpeakable(cleaned)) tts!.send(cleaned, isFinal);
        else if (isFinal) tts!.send(' ', true);
      };

      for await (const ev of session.send(msg.text, { reasoning, model, temperature })) {
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
          tts!.send(' ', true);
        }
        const doneTts = tts as TtsSession | null;
        if (doneTts) {
          await doneTts.done;
          sendLatency(ws, 'tts done', Date.now() - t0);
        }
      }

      // Persist assistant reply
      if (assistantText.trim()) {
        void appendMessage(currentConversationId!, 'assistant', assistantText.trim());
      }

      sendLatency(ws, 'total', Date.now() - t0);
      safeSend(ws, { type: 'done' });
    } catch (err) {
      console.error('[err]', err);
      safeSend(ws, { type: 'error', message: (err as Error).message });
    } finally {
      (tts as TtsSession | null)?.close();
    }
  });

  ws.on('close', () => console.log('[ws] client disconnected'));
});

server.listen(PORT, () => {
  console.log(
    `Buddlys server: http://localhost:${PORT}  |  ws: ws://localhost:${PORT}/ws`,
  );
  // Filler-Audios im Hintergrund vorrendern (blockiert nichts).
  void preloadFillers();
});
