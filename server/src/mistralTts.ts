import 'dotenv/config';

/**
 * Mistral / Voxtral Text-to-Speech-Adapter.
 *
 * Endpoint:
 *   POST https://api.mistral.ai/v1/audio/speech
 *   Body: { model, input, voice_id, response_format, stream }
 *
 * Non-streaming Antwort:
 *   JSON { "audio_data": "<base64>" }
 *
 * Streaming Antwort:
 *   text/event-stream mit JSON-Events, deren `audio_data` jeweils ein
 *   Base64-kodierter Audio-Chunk ist.
 *
 * Voices-Liste:
 *   GET  https://api.mistral.ai/v1/audio/voices
 *
 * MISTRAL_TTS_VOICE darf entweder eine UUID oder ein Voice-Name sein.
 * Bei einem Namen wird die UUID einmalig über /v1/audio/voices aufgelöst
 * und gecacht. Für Streaming nutzen wir `response_format: "pcm"`; Mistral
 * liefert dabei raw float32 little-endian Samples. Der Browser-Pfad in dieser
 * App erwartet PCM s16le, darum konvertieren wir serverseitig.
 */

export interface TtsResult {
  audio: Buffer;
  mimeType: string;
}

const SPEECH_URL = 'https://api.mistral.ai/v1/audio/speech';
const VOICES_URL = 'https://api.mistral.ai/v1/audio/voices';

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  pcm: 'audio/pcm',
};

export const MISTRAL_TTS_SAMPLE_RATE = 24000;
export const MISTRAL_TTS_ENCODING = 'pcm_s16le' as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache pro Voice-Name → UUID. Wird neu aufgelöst, wenn der konfigurierte
// Name (.env MISTRAL_TTS_VOICE) wechselt.
const voiceIdCache = new Map<string, string>();

async function resolveVoiceId(apiKey: string, raw: string): Promise<string> {
  if (UUID_RE.test(raw)) return raw;
  const cached = voiceIdCache.get(raw);
  if (cached) return cached;

  const res = await fetch(VOICES_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voices-Liste HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    items?: Array<{ id: string; name?: string; slug?: string | null }>;
  };
  const items = data.items ?? [];
  const lower = raw.toLowerCase();
  const hit = items.find(
    (v) =>
      v.name?.toLowerCase() === lower ||
      (v.slug && v.slug.toLowerCase() === lower),
  );
  if (!hit) {
    const known = items
      .map((v) => v.name ?? v.slug ?? v.id)
      .slice(0, 12)
      .join(', ');
    throw new Error(
      `Voice "${raw}" nicht gefunden. Verfügbar: ${known}` +
        (items.length > 12 ? ' …' : ''),
    );
  }
  voiceIdCache.set(raw, hit.id);
  return hit.id;
}

function readConfig() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');

  const model = process.env.MISTRAL_TTS_MODEL || 'voxtral-mini-tts-2603';
  const voiceRaw = process.env.MISTRAL_TTS_VOICE || '';

  if (!voiceRaw) {
    throw new Error(
      'MISTRAL_TTS_VOICE fehlt: Name oder UUID einer Voice in .env eintragen.',
    );
  }

  return { apiKey, model, voiceRaw };
}

function base64AudioFromEvent(json: Record<string, unknown>): string | null {
  const candidates = [
    json.audio_data,
    json.audio,
    json.audio_base64,
    json.data,
  ];
  const value = candidates.find((v) => typeof v === 'string' && v.length > 0);
  return typeof value === 'string' ? value : null;
}

function f32leToS16le(input: Buffer): { pcm: Buffer; remainder: Buffer } {
  const sampleCount = Math.floor(input.length / 4);
  const pcm = Buffer.allocUnsafe(sampleCount * 2);

  for (let i = 0; i < sampleCount; i++) {
    const f = input.readFloatLE(i * 4);
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(f) ? f : 0));
    const int = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    pcm.writeInt16LE(int, i * 2);
  }

  return { pcm, remainder: input.subarray(sampleCount * 4) };
}

async function streamSpeechPcm(
  opts: {
    apiKey: string;
    model: string;
    voiceId: string;
    text: string;
    signal: AbortSignal;
  },
  onPcm: (pcm: Buffer) => void,
): Promise<void> {
  const res = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.text,
      voice_id: opts.voiceId,
      response_format: 'pcm',
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mistral TTS HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>;
    const b64 = base64AudioFromEvent(json);
    if (!b64) {
      throw new Error(
        'Mistral TTS: JSON-Antwort ohne Audio-Feld. Raw=' +
          JSON.stringify(json).slice(0, 200),
      );
    }
    const converted = f32leToS16le(Buffer.from(b64, 'base64'));
    if (converted.pcm.length) onPcm(converted.pcm);
    return;
  }

  if (!res.body) throw new Error('Mistral TTS: leere Streaming-Antwort');

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let sseBuffer = '';
  let pcmRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  const handleBlock = (block: string) => {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (!dataLines.length) return;

    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return;

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof json.error === 'string') {
      throw new Error(`Mistral TTS: ${json.error}`);
    }

    const b64 = base64AudioFromEvent(json);
    if (!b64) return;

    const f32 = Buffer.concat([pcmRemainder, Buffer.from(b64, 'base64')]);
    const converted = f32leToS16le(f32);
    pcmRemainder = converted.remainder;
    if (converted.pcm.length) onPcm(converted.pcm);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    let sep = sseBuffer.search(/\r?\n\r?\n/);
    while (sep !== -1) {
      const block = sseBuffer.slice(0, sep);
      const match = sseBuffer.slice(sep).match(/^\r?\n\r?\n/);
      sseBuffer = sseBuffer.slice(sep + (match?.[0].length ?? 2));
      handleBlock(block);
      sep = sseBuffer.search(/\r?\n\r?\n/);
    }
  }

  sseBuffer += decoder.decode();
  if (sseBuffer.trim()) handleBlock(sseBuffer);
}

export interface MistralTtsSession {
  send(text: string, isFinal: boolean): void;
  onChunk(cb: (pcm: Buffer) => void): void;
  done: Promise<void>;
  close(): void;
  sampleRate: typeof MISTRAL_TTS_SAMPLE_RATE;
  encoding: typeof MISTRAL_TTS_ENCODING;
}

export async function openMistralTtsSession(): Promise<MistralTtsSession> {
  const { apiKey, model, voiceRaw } = readConfig();
  const voiceId = await resolveVoiceId(apiKey, voiceRaw);

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
        await streamSpeechPcm(
          { apiKey, model, voiceId, text: t, signal: activeAbort.signal },
          (pcm) => {
            for (const cb of chunkCallbacks) cb(pcm);
          },
        );
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
    sampleRate: MISTRAL_TTS_SAMPLE_RATE,
    encoding: MISTRAL_TTS_ENCODING,
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

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const { apiKey, model, voiceRaw } = readConfig();
  const format = (process.env.MISTRAL_TTS_FORMAT || 'mp3').toLowerCase();

  const voiceId = await resolveVoiceId(apiKey, voiceRaw);

  const res = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, application/octet-stream',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice_id: voiceId,
      response_format: format,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mistral TTS HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  let audio: Buffer;

  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>;
    const b64 =
      (json.audio_data as string | undefined) ??
      (json.audio as string | undefined) ??
      (json.audio_base64 as string | undefined);
    if (typeof b64 !== 'string' || !b64.length) {
      throw new Error(
        'Mistral TTS: JSON-Antwort ohne Audio-Feld. Raw=' +
          JSON.stringify(json).slice(0, 200),
      );
    }
    audio = Buffer.from(b64, 'base64');
  } else {
    const ab = await res.arrayBuffer();
    audio = Buffer.from(ab);
  }

  return {
    audio,
    mimeType: FORMAT_MIME[format] ?? 'application/octet-stream',
  };
}
