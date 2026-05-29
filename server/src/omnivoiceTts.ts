import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

export const OMNIVOICE_SAMPLE_RATE = 24000;
export const OMNIVOICE_ENCODING = 'pcm_s16le' as const;

interface RunPodJobResponse {
  id?: string;
  error?: string;
}

interface RunPodStreamResponse {
  status?: string;
  stream?: unknown[];
  output?: unknown;
  error?: string;
}

export interface OmniVoiceSession {
  send(text: string, isFinal: boolean): void;
  onChunk(cb: (pcm: Buffer) => void): void;
  done: Promise<void>;
  close(): void;
  sampleRate: typeof OMNIVOICE_SAMPLE_RATE;
  encoding: typeof OMNIVOICE_ENCODING;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} fehlt in .env`);
  return value;
}

function runpodBaseUrl(): string {
  return (process.env.RUNPOD_BASE_URL || 'https://api.runpod.ai/v2').replace(/\/$/, '');
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function optionalRefAudioBase64(): Promise<string | undefined> {
  const raw = process.env.OMNIVOICE_REF_AUDIO_PATH;
  if (!raw) return undefined;
  const resolved = path.resolve(process.cwd(), raw);
  const buf = await fs.readFile(resolved);
  return buf.toString('base64');
}

function normalizeWsUrl(raw: string): string {
  let url = raw.trim().replace(/\/$/, '');
  if (url.startsWith('http://')) url = 'ws://' + url.slice('http://'.length);
  else if (url.startsWith('https://')) url = 'wss://' + url.slice('https://'.length);
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;
  if (!url.endsWith('/stream')) url += '/stream';
  return url;
}

function omniVoicePayload(text: string, refAudioBase64?: string): Record<string, unknown> {
  return {
    text,
    refText: process.env.OMNIVOICE_REF_TEXT || undefined,
    refAudioBase64,
    instruct: process.env.OMNIVOICE_INSTRUCT || undefined,
    numStep: envNumber('OMNIVOICE_NUM_STEP', 16),
    speed: envNumber('OMNIVOICE_SPEED', 1.0),
    chunkMs: envNumber('OMNIVOICE_CHUNK_MS', 160),
  };
}

function audioChunkFromRunPod(item: unknown): Buffer | null {
  const candidate =
    item && typeof item === 'object' && 'output' in item
      ? (item as { output?: unknown }).output
      : item;

  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  if (obj.type && obj.type !== 'audio_chunk') return null;
  if (obj.encoding && obj.encoding !== OMNIVOICE_ENCODING) return null;
  if (obj.sampleRate && obj.sampleRate !== OMNIVOICE_SAMPLE_RATE) return null;

  const b64 = obj.audioBase64;
  if (typeof b64 !== 'string' || !b64.length) return null;
  return Buffer.from(b64, 'base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripWavHeader(wav: Buffer): Buffer {
  let i = 12;
  while (i < wav.length - 8) {
    const chunkId = wav.toString('ascii', i, i + 4);
    const chunkSize = wav.readUInt32LE(i + 4);
    if (chunkId === 'data') return wav.subarray(i + 8);
    i += 8 + chunkSize;
  }
  return wav.subarray(44);
}

async function openOmniVoiceHttpSession(): Promise<OmniVoiceSession> {
  const baseUrl = requireEnv('OMNIVOICE_HTTP_URL').replace(/\/$/, '');
  const chunkCallbacks: Array<(pcm: Buffer) => void> = [];
  const queue: Array<{ text: string; isFinal: boolean }> = [];

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });

  let finished = false;
  let processing = false;
  let closeRequested = false;

  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    if (err) rejectDone(err);
    else resolveDone();
  };

  const apiKey = process.env.RUNPOD_API_KEY;
  const fetchAudio = async (text: string): Promise<Buffer> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/tts_pcm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`OmniVoice HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const processQueue = async () => {
    if (processing || finished) return;
    processing = true;
    try {
      // Pipeline: start fetch for N+1 while streaming N
      let pending: Promise<Buffer> | null = null;

      const startNext = (): Promise<Buffer> | null => {
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.isFinal) closeRequested = true;
          const t = item.text.trim();
          if (t) return fetchAudio(t);
        }
        return null;
      };

      pending = startNext();

      while (!finished && pending !== null) {
        const prefetch = startNext(); // fire N+1 fetch immediately
        const pcm = await pending;   // wait for N (was already in-flight)
        pending = prefetch;

        const chunkSize = 4800; // 100ms @ 24kHz s16le
        for (let i = 0; i < pcm.length; i += chunkSize) {
          if (finished) break;
          for (const cb of chunkCallbacks) cb(pcm.subarray(i, i + chunkSize));
        }

        // queue may have grown while we streamed — pick up stragglers
        if (pending === null) pending = startNext();
      }

      if (closeRequested && queue.length === 0) finish();
    } catch (err) {
      finish(err as Error);
    } finally {
      processing = false;
    }
  };

  return {
    sampleRate: OMNIVOICE_SAMPLE_RATE,
    encoding: OMNIVOICE_ENCODING,
    send(text: string, isFinal: boolean) {
      if (finished) return;
      const t = text.trim();
      if (t) queue.push({ text: t, isFinal });
      if (isFinal) closeRequested = true;
      if (closeRequested && !processing && queue.length === 0) finish();
      void processQueue();
    },
    onChunk(cb) { chunkCallbacks.push(cb); },
    done,
    close: () => finish(),
  };
}

export async function openOmniVoiceSession(): Promise<OmniVoiceSession> {
  if (process.env.OMNIVOICE_HTTP_URL) {
    return openOmniVoiceHttpSession();
  }
  if (process.env.OMNIVOICE_WS_URL) {
    return openOmniVoiceWebSocketSession();
  }

  const apiKey = requireEnv('RUNPOD_API_KEY');
  const endpointId = requireEnv('OMNIVOICE_RUNPOD_ENDPOINT_ID');
  const baseUrl = runpodBaseUrl();
  const pollMs = Math.max(50, envNumber('OMNIVOICE_STREAM_POLL_MS', 100));
  const refAudioBase64 = await optionalRefAudioBase64();

  const chunkCallbacks: Array<(pcm: Buffer) => void> = [];
  const queue: Array<{ text: string; isFinal: boolean }> = [];

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let finished = false;
  let processing = false;
  let closeRequested = false;
  let activeAbort: AbortController | null = null;

  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    activeAbort?.abort();
    if (err) rejectDone(err);
    else resolveDone();
  };

  const submitJob = async (text: string, signal: AbortSignal): Promise<string> => {
    const res = await fetch(`${baseUrl}/${endpointId}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: omniVoicePayload(text, refAudioBase64) }),
      signal,
    });

    const body = (await res.json().catch(() => ({}))) as RunPodJobResponse;
    if (!res.ok || !body.id) {
      throw new Error(
        `OmniVoice RunPod /run HTTP ${res.status}: ${
          body.error || JSON.stringify(body).slice(0, 300)
        }`,
      );
    }
    return body.id;
  };

  const streamJob = async (jobId: string, signal: AbortSignal) => {
    let seen = 0;
    while (!finished) {
      const res = await fetch(`${baseUrl}/${endpointId}/stream/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      const body = (await res.json().catch(() => ({}))) as RunPodStreamResponse;
      if (!res.ok) {
        throw new Error(
          `OmniVoice RunPod /stream HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
        );
      }
      if (body.error) throw new Error(`OmniVoice RunPod: ${body.error}`);

      const stream = Array.isArray(body.stream) ? body.stream : [];
      for (const item of stream.slice(seen)) {
        const pcm = audioChunkFromRunPod(item);
        if (pcm?.length) {
          for (const cb of chunkCallbacks) cb(pcm);
        }
      }
      seen = stream.length;

      if (body.status === 'COMPLETED') {
        if (Array.isArray(body.output)) {
          for (const item of body.output.slice(seen)) {
            const pcm = audioChunkFromRunPod(item);
            if (pcm?.length) {
              for (const cb of chunkCallbacks) cb(pcm);
            }
          }
        }
        return;
      }
      if (body.status === 'FAILED' || body.status === 'CANCELLED' || body.status === 'TIMED_OUT') {
        throw new Error(`OmniVoice RunPod job ${body.status}`);
      }
      await sleep(pollMs);
    }
  };

  const processQueue = async () => {
    if (processing || finished) return;
    processing = true;
    try {
      while (!finished && queue.length > 0) {
        const item = queue.shift()!;
        if (item.isFinal) closeRequested = true;
        const t = item.text.trim();
        if (!t) continue;

        activeAbort = new AbortController();
        const jobId = await submitJob(t, activeAbort.signal);
        await streamJob(jobId, activeAbort.signal);
        activeAbort = null;
      }
      if (closeRequested && queue.length === 0) finish();
    } catch (err) {
      if ((err as Error).name === 'AbortError' && finished) return;
      finish(err as Error);
    } finally {
      processing = false;
    }
  };

  return {
    sampleRate: OMNIVOICE_SAMPLE_RATE,
    encoding: OMNIVOICE_ENCODING,
    send(text: string, isFinal: boolean) {
      if (finished) return;
      const t = text.trim();
      if (t) queue.push({ text: t, isFinal });
      if (isFinal) closeRequested = true;
      if (closeRequested && !processing && queue.length === 0) finish();
      void processQueue();
    },
    onChunk(cb) {
      chunkCallbacks.push(cb);
    },
    done,
    close: () => finish(),
  };
}

async function openOmniVoiceWebSocketSession(): Promise<OmniVoiceSession> {
  const url = normalizeWsUrl(requireEnv('OMNIVOICE_WS_URL'));
  const apiKey = process.env.OMNIVOICE_API_KEY;
  const refAudioBase64 = await optionalRefAudioBase64();

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const ws = new WebSocket(url, { headers });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });

  const chunkCallbacks: Array<(pcm: Buffer) => void> = [];
  let pendingSpeaks = 0;
  let closeRequested = false;

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let finished = false;
  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    if (err) rejectDone(err);
    else resolveDone();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = raw as Buffer;
      if (buf.length) {
        for (const cb of chunkCallbacks) cb(buf);
      }
      return;
    }

    let msg: { type?: string; message?: string; audioBase64?: string; sampleRate?: number; encoding?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'audio_chunk' && typeof msg.audioBase64 === 'string') {
      const pcm = Buffer.from(msg.audioBase64, 'base64');
      if (pcm.length) {
        for (const cb of chunkCallbacks) cb(pcm);
      }
    } else if (msg.type === 'speak_done') {
      pendingSpeaks = Math.max(0, pendingSpeaks - 1);
      if (closeRequested && pendingSpeaks === 0) {
        ws.send(JSON.stringify({ type: 'close' }));
      }
    } else if (msg.type === 'done') {
      finish();
    } else if (msg.type === 'error') {
      finish(new Error(msg.message || 'OmniVoice WebSocket error'));
    }
  });
  ws.on('error', (e) => finish(e as Error));
  ws.on('close', () => finish());

  return {
    sampleRate: OMNIVOICE_SAMPLE_RATE,
    encoding: OMNIVOICE_ENCODING,
    send(text: string, isFinal: boolean) {
      if (finished || ws.readyState !== WebSocket.OPEN) return;
      const t = text.trim();
      if (t) {
        pendingSpeaks += 1;
        ws.send(
          JSON.stringify({
            type: 'speak',
            isFinal,
            ...omniVoicePayload(t, refAudioBase64),
          }),
        );
      }
      if (isFinal) {
        closeRequested = true;
        if (pendingSpeaks === 0) ws.send(JSON.stringify({ type: 'close' }));
      }
    },
    onChunk(cb) {
      chunkCallbacks.push(cb);
    },
    done,
    close: () => finish(),
  };
}
