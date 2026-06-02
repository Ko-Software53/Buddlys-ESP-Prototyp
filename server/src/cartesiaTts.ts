import 'dotenv/config';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

/**
 * Cartesia Sonic TTS — Streaming-WebSocket.
 *
 *   wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01
 *   Header: X-API-Key: <key>
 *
 *   Request-Frame (JSON):
 *     { model_id, transcript, context_id, voice:{mode:'id', id},
 *       output_format:{container, encoding, sample_rate},
 *       language, continue }
 *
 *   Response-Frames (JSON):
 *     { type:'chunk', data:<base64>, done:false, context_id }
 *     { type:'done',  done:true,  context_id }
 *     { type:'error', error:<str> }
 *
 * Eine Session = ein context_id. Mit `continue: true` werden weitere
 * transcript-Frames an dieselbe Generation angehängt → durchgehende
 * Prosodie ohne Tonalitätssprünge.
 */

const WS_URL_BASE = 'wss://api.cartesia.ai/tts/websocket';
const VERSION = '2026-03-01';
export const PCM_SAMPLE_RATE = 16000;
export const PCM_ENCODING = 'pcm_s16le' as const;

export interface CartesiaSession {
  /** Sendet einen Transcript-Frame. isFinal=true beendet die Generation. */
  send(transcript: string, isFinal: boolean): void;
  /** Audio-Chunk-Callback. Wird mehrfach gerufen, base64-decoded PCM. */
  onChunk(cb: (pcm: Buffer) => void): void;
  /** Resolved sobald Cartesia 'done' geschickt hat. */
  done: Promise<void>;
  /** WebSocket-Verbindung früh schließen (z. B. bei Client-Disconnect). */
  close(): void;
  sampleRate: number;
  encoding: typeof PCM_ENCODING;
  /** Gibt zurück, ob die Verbindung geschlossen wurde. */
  isClosed(): boolean;
}

export interface CartesiaSessionOptions {
  /** Cartesia generation_config: speed (-1..1), emotion[], volume. */
  generationConfig?: {
    speed?: number;
    emotion?: string[];
    volume?: number;
  };
}

export async function openCartesiaSession(
  opts: CartesiaSessionOptions = {},
): Promise<CartesiaSession> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error('CARTESIA_API_KEY fehlt in .env');
  const voiceId = process.env.CARTESIA_VOICE_ID;
  if (!voiceId) throw new Error('CARTESIA_VOICE_ID fehlt in .env');
  const model = process.env.CARTESIA_MODEL || 'sonic-3';
  const language = process.env.CARTESIA_LANGUAGE || 'de';
  const speed = opts.generationConfig?.speed ?? parseFloat(process.env.CARTESIA_SPEED || '0.85');

  const url = `${WS_URL_BASE}?cartesia_version=${VERSION}`;
  const ws = new WebSocket(url, {
    headers: { 'X-API-Key': apiKey, 'Cartesia-Version': VERSION },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });

  const contextId = randomUUID();
  const chunkCallbacks: Array<(pcm: Buffer) => void> = [];

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let finished = false;
  let keepAliveInterval: NodeJS.Timeout | null = null;
  
  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (err) rejectDone(err);
    else resolveDone();
    try {
      ws.close();
    } catch {
      // egal
    }
  };

  ws.on('open', () => {
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, 4000);
  });

  ws.on('message', (raw) => {
    let msg: { type?: string; data?: string; error?: string; context_id?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'chunk' && typeof msg.data === 'string') {
      const buf = Buffer.from(msg.data, 'base64');
      for (const cb of chunkCallbacks) cb(buf);
    } else if (msg.type === 'done') {
      finish();
    } else if (msg.type === 'error') {
      finish(new Error(msg.error || 'Cartesia error'));
    }
  });
  ws.on('error', (e) => finish(e as Error));
  ws.on('close', () => finish());

  return {
    sampleRate: PCM_SAMPLE_RATE,
    encoding: PCM_ENCODING,
    send(transcript: string, isFinal: boolean) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const payload: Record<string, unknown> = {
        model_id: model,
        transcript,
        context_id: contextId,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: 'raw',
          encoding: PCM_ENCODING,
          sample_rate: PCM_SAMPLE_RATE,
        },
        language,
        continue: !isFinal,
        generation_config: { speed },
      };
      ws.send(JSON.stringify(payload));
    },
    onChunk(cb) {
      chunkCallbacks.push(cb);
    },
    done,
    close: () => finish(),
    isClosed: () => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING,
  };
}
