import 'dotenv/config';

/**
 * Mistral / Voxtral Text-to-Speech-Adapter.
 *
 * Endpoint (verifiziert gegen api.mistral.ai, Mai 2026):
 *   POST https://api.mistral.ai/v1/audio/speech
 *   Body: { model, input, voice_id, response_format }
 *   Antwort: JSON { "audio_data": "<base64>" }
 *
 * Voices-Liste:
 *   GET  https://api.mistral.ai/v1/audio/voices
 *
 * MISTRAL_TTS_VOICE darf entweder eine UUID oder ein Voice-Name sein.
 * Bei einem Namen wird die UUID einmalig über /v1/audio/voices aufgelöst
 * und gecacht.
 *
 * ============================================================================
 * ANPASSEN BEI ABWEICHENDEM ENDPOINT / ENGINE-WECHSEL
 * ============================================================================
 * Falls Mistral den Pfad ändert, hier `SPEECH_URL` anpassen.
 * Wenn dein Account gar keinen TTS-Zugang hat, kannst du `synthesizeSpeech`
 * komplett durch eine andere Engine (ElevenLabs, OpenAI TTS, Piper …)
 * ersetzen. Die Signatur muss bleiben:
 *
 *   synthesizeSpeech(text: string): Promise<TtsResult>
 * ============================================================================
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

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');

  const model = process.env.MISTRAL_TTS_MODEL || 'voxtral-mini-tts-2603';
  const voiceRaw = process.env.MISTRAL_TTS_VOICE || '';
  const format = (process.env.MISTRAL_TTS_FORMAT || 'mp3').toLowerCase();

  if (!voiceRaw) {
    throw new Error(
      'MISTRAL_TTS_VOICE fehlt: Name oder UUID einer Voice in .env eintragen.',
    );
  }

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
