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
import { SentenceChunker } from './chunker.js';
import { preloadFillers, pickFiller } from './fillerCache.js';

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

type TtsMode = 'streaming' | 'full';
type ReasoningMode = 'auto' | 'always' | 'never';
type ClientMsg =
  | { type: 'user_text'; text: string; mode?: TtsMode; reasoning?: ReasoningMode }
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

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  // Eine Konversations-Session pro WebSocket = Gedächtnis über die ganze
  // Verbindung. Neuer Tab / Reload = neue Session.
  const session = new ConversationSession();

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
      safeSend(ws, { type: 'done' });
      return;
    }
    if (msg?.type !== 'user_text' || typeof msg.text !== 'string' || !msg.text.trim()) {
      return;
    }

    const mode: TtsMode = msg.mode === 'streaming' ? 'streaming' : 'full';
    const reasoning: ReasoningMode =
      msg.reasoning === 'always' || msg.reasoning === 'never' ? msg.reasoning : 'auto';
    const t0 = Date.now();
    let firstTokenLogged = false;
    let firstAudioLogged = false;
    let cartesia: Awaited<ReturnType<typeof openCartesiaSession>> | null = null;

    const logFirstAudio = () => {
      if (firstAudioLogged) return;
      firstAudioLogged = true;
      sendLatency(ws, 'first audio out', Date.now() - t0);
    };

    /** Spielt einen vorgerenderten Filler an den Client.
     *  Nutzt NICHT die laufende Cartesia-Session — direkt PCM aus Cache,
     *  damit es sofort losgeht (~0 ms). */
    const playFiller = () => {
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

    try {
      const ttsT0 = Date.now();
      cartesia = await openCartesiaSession();
      sendLatency(ws, 'tts session open', Date.now() - ttsT0);

      // Cartesia → Client: PCM-Chunks der eigentlichen Antwort
      cartesia.onChunk((pcm) => {
        if (!pcm.length) return;
        logFirstAudio();
        safeSend(ws, {
          type: 'audio_chunk',
          encoding: cartesia!.encoding,
          sampleRate: cartesia!.sampleRate,
          audioBase64: pcm.toString('base64'),
        });
      });

      // Streaming-Modus: Satz-Chunker zwischen LLM und Cartesia
      // Full-Modus: Text komplett einsammeln, ein einziger Cartesia-Push
      const chunker =
        mode === 'streaming'
          ? new SentenceChunker({ minLen: 24, maxLen: 120 })
          : null;
      let fullText = '';
      let pushedToCartesia = false;

      for await (const ev of session.send(msg.text, { reasoning })) {
        if (ev.type === 'delta') {
          if (!firstTokenLogged) {
            firstTokenLogged = true;
            sendLatency(ws, 'first text token', Date.now() - t0);
          }
          safeSend(ws, { type: 'text_delta', text: ev.text });
          if (chunker) {
            const chunks = chunker.push(ev.text);
            for (const c of chunks) {
              if (!isSpeakable(c)) continue;
              cartesia.send(c, false);
              pushedToCartesia = true;
            }
          } else {
            fullText += ev.text;
          }
        } else if (ev.type === 'tool_call_pending') {
          sendLatency(ws, `tool start (${ev.name})`, Date.now() - t0);
          playFiller();
        } else if (ev.type === 'tool_result') {
          sendLatency(ws, `tool done (${ev.name})`, ev.ms);
          console.log(`[tool] ${ev.name} → ${ev.preview}`);
        } else if (ev.type === 'done') {
          // ignore — wir finalisieren unten
        }
      }

      // TTS finalisieren
      if (chunker) {
        const tail = chunker.flush();
        if (tail && isSpeakable(tail)) {
          cartesia.send(tail, true);
          pushedToCartesia = true;
        } else if (pushedToCartesia) {
          cartesia.send('', true);
        } else {
          cartesia.send(' ', true);
        }
      } else {
        const clean = fullText.trim();
        sendLatency(ws, `tts push (${clean.length} chars)`, Date.now() - t0);
        cartesia.send(clean && isSpeakable(clean) ? clean : ' ', true);
      }

      await cartesia.done;
      sendLatency(ws, 'tts done', Date.now() - t0);
      sendLatency(ws, 'total', Date.now() - t0);
      safeSend(ws, { type: 'done' });
    } catch (err) {
      console.error('[err]', err);
      safeSend(ws, { type: 'error', message: (err as Error).message });
    } finally {
      cartesia?.close();
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
