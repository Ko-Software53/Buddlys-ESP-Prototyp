// Generate Buddly's spoken status clips in the toy's OWN Cartesia voice and write
// them as raw 16 kHz mono s16le PCM into the firmware, where CMake EMBED_FILES bakes
// them into the binary. These play locally on the toy (no network) so it can talk to
// the child while the WiFi/WebSocket link is still coming up after a deep-sleep wake.
//
// Run from the server/ dir (its node_modules has `ws` and the .env keys):
//   node scripts/gen_feedback_clips.mjs
// Re-run whenever you want to change the wording, then rebuild + reflash the firmware.
//
// Uses the SAME Cartesia voice/model/speed as live turns (cartesiaTts.ts reads the
// same .env vars) so the feedback sounds like Buddly, not a different robot voice.

import 'dotenv/config';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Child-friendly German. Keep them short — they play before the toy is "ready".
// The firmware symbol names derive from the file name: clip_ready.pcm ->
// _binary_clip_ready_pcm_start. If you add/rename a clip, update CMakeLists.txt
// (EMBED_FILES) and the extern decls in main.c to match.
const CLIPS = {
  clip_waking:    'Einen Moment, ich wache auf.',
  clip_ready:     'Ich bin bereit. Du kannst jetzt mit mir reden!',
  clip_reconnect: 'Hoppla, einen kleinen Moment. Ich verbinde mich neu.',
};

const VERSION = '2026-03-01';
const SAMPLE_RATE = 16000;

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', '..', 'firmware', 'appFirmware', 'main', 'audio');

async function synth(text) {
  const apiKey = process.env.CARTESIA_API_KEY;
  const voiceId = process.env.CARTESIA_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error('CARTESIA_API_KEY / CARTESIA_VOICE_ID missing in .env');
  const model = process.env.CARTESIA_MODEL || 'sonic-3';
  const language = process.env.CARTESIA_LANGUAGE || 'de';
  const speed = parseFloat(process.env.CARTESIA_SPEED || '0.85');

  const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, {
    headers: { 'X-API-Key': apiKey, 'Cartesia-Version': VERSION },
  });
  const chunks = [];

  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  const done = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'chunk' && typeof m.data === 'string') chunks.push(Buffer.from(m.data, 'base64'));
      else if (m.type === 'done') res();
      else if (m.type === 'error') rej(new Error(m.error || 'Cartesia error'));
    });
    ws.on('error', rej);
  });

  ws.send(JSON.stringify({
    model_id: model,
    transcript: text,
    context_id: randomUUID(),
    voice: { mode: 'id', id: voiceId },
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    language,
    continue: false,
    generation_config: { speed },
  }));

  await done;
  ws.close();
  return Buffer.concat(chunks);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, text] of Object.entries(CLIPS)) {
  const pcm = await synth(text);
  const path = join(OUT_DIR, `${name}.pcm`);
  writeFileSync(path, pcm);
  const secs = (pcm.length / 2 / SAMPLE_RATE).toFixed(2);
  console.log(`✓ ${name}.pcm  ${pcm.length} bytes  ${secs}s  "${text}"`);
}
console.log(`\nWrote clips to ${OUT_DIR}\nRebuild + reflash the firmware to embed them.`);
