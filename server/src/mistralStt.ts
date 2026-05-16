import 'dotenv/config';

/**
 * Mistral / Voxtral Speech-to-Text.
 *
 * Endpoint:
 *   POST https://api.mistral.ai/v1/audio/transcriptions
 *   multipart/form-data: file=<audio>, model=<voxtral-stt-modell>, language=de
 *   Antwort JSON: { text: string, language: string | null, ... }
 */

const STT_URL = 'https://api.mistral.ai/v1/audio/transcriptions';

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');
  const model = process.env.MISTRAL_STT_MODEL || 'voxtral-mini-2507';
  const language = process.env.MISTRAL_STT_LANGUAGE || 'de';

  const ext = mimeType.includes('webm')
    ? 'webm'
    : mimeType.includes('mp4')
      ? 'mp4'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : 'bin';

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${ext}`);
  form.append('model', model);
  if (language) form.append('language', language);

  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mistral STT HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}
