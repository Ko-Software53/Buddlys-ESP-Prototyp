import fs from 'node:fs/promises';
import path from 'node:path';
import { openCartesiaSession, PCM_SAMPLE_RATE, PCM_ENCODING } from './cartesiaTts.js';

/**
 * "Thinking sounds" — vorgenerierte kurze Audio-Schnipsel, die abgespielt
 * werden, sobald der LLM einen Tool-Call ankündigt. Aus dem RAM, also ~0 ms.
 *
 * Zwei Quellen:
 *   1) TTS-generierte Phrasen via Cartesia (eine breite Mischung aus kurzen
 *      Interjektionen und Sätzen, beim Boot einmal parallel gerendert).
 *   2) Optional: WAV-SFX-Dateien aus dem Ordner `server/fillers/`. Müssen
 *      24 kHz, 16-bit, mono sein. Werden zusätzlich in den Pool gemixt.
 *
 * Der Pool wird zufällig durchmischt — kein Phrase-Spam mehr.
 */

interface CachedFiller {
  text: string;
  pcm: Buffer;
}

const cache: CachedFiller[] = [];
let loaded = false;

// Variation kommt rein aus dem Text. (Cartesia generation_config-Schema
// hat sich beim Test als zickig erwiesen.)
const TTS_FILLERS: string[] = [
  // Reine Vokal-Reaktionen
  'Hmm.',
  'Mhm.',
  'Mh, mh.',
  'Mh, interessant.',
  // Kurze Phrasen
  'Moment.',
  'Warte mal.',
  'Hmm, kurz überlegen.',
  'Eine Sekunde.',
  'Mh, lass mich denken.',
  'Mh, mal sehen.',
  'Spannend.',
  'Hmm, lass mal sehen.',
  // Etwas längere natürliche Sätze
  'Mhm, das überlege ich kurz.',
  'Moment, das schaue ich gleich nach.',
  'Oh, da denke ich mal kurz drüber nach.',
  'Hmm, lass mich das genauer anschauen.',
  'Ah, das wüsste ich auch gerne genauer.',
  'Warte, ich überlege mal.',
  'Oh, ich denke kurz nach.',
  'Spannend, gleich habe ich es.',
  'Hmm, eine kleine Sekunde noch.',
];

async function renderOne(text: string): Promise<Buffer> {
  const session = await openCartesiaSession();
  const parts: Buffer[] = [];
  session.onChunk((p) => parts.push(p));
  session.send(text, true);
  await session.done;
  // Pad with 100ms of silence at the start so the audio system has time
  // to start playback before the actual sound begins (prevents clipping).
  const silenceMs = 100;
  const silenceBytes = Math.ceil((PCM_SAMPLE_RATE * silenceMs) / 1000) * 2; // 16-bit = 2 bytes/sample
  const silence = Buffer.alloc(silenceBytes, 0);
  return Buffer.concat([silence, ...parts]);
}

async function loadSfxFiles(): Promise<CachedFiller[]> {
  const dir = path.resolve(process.cwd(), 'fillers');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: CachedFiller[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    try {
      const buf = await fs.readFile(path.join(dir, name));
      const pcm = parseWavToPcm(buf);
      if (pcm) {
        out.push({ text: `[sfx:${name}]`, pcm: padToMinimumDuration(pcm) });
        console.log(`[filler] SFX geladen: ${name} (${pcm.length} bytes PCM)`);
      } else {
        console.warn(`[filler] SFX übersprungen (Format != 24kHz/16-bit/mono): ${name}`);
      }
    } catch (err) {
      console.warn(`[filler] SFX-Fehler ${name}:`, (err as Error).message);
    }
  }
  return out;
}

/** Minimaler WAV-Parser: akzeptiert nur 24 kHz, 16-bit, mono PCM. */
function parseWavToPcm(buf: Buffer): Buffer | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt: { ch: number; rate: number; bits: number } | null = null;
  let dataStart = -1;
  let dataLen = 0;

  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        ch: buf.readUInt16LE(offset + 10),
        rate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size;
  }
  if (!fmt || dataStart < 0) return null;
  if (fmt.ch !== 1 || fmt.rate !== PCM_SAMPLE_RATE || fmt.bits !== 16) return null;
  return buf.subarray(dataStart, dataStart + dataLen);
}

// Pad fillers to at least 1600ms so they bypass the ESP32's JITTER_PREBUF_MS (1500ms)
// and start playing instantly without waiting for the rest of the answer.
function padToMinimumDuration(pcm: Buffer, minMs: number = 1600): Buffer {
  const minBytes = Math.ceil((PCM_SAMPLE_RATE * minMs) / 1000) * 2;
  if (pcm.length >= minBytes) return pcm;
  const padding = Buffer.alloc(minBytes - pcm.length, 0);
  return Buffer.concat([pcm, padding]);
}

export async function preloadFillers(): Promise<void> {
  if (loaded) return;
  loaded = true;

  // SFX-Dateien parallel zu TTS-Generation laden
  const sfxPromise = loadSfxFiles();

  // TTS-Fillers seriell oder in geringer Parallelität rendern.
  // Cartesia hat bei zu vielen parallelen Sessions Fehler geliefert.
  const t0 = Date.now();
  const concurrent = 2;
  const queue = [...TTS_FILLERS];
  const results: CachedFiller[] = [];
  let okCount = 0;
  let failCount = 0;

  const workers = Array.from({ length: concurrent }, async () => {
    while (queue.length) {
      const text = queue.shift();
      if (!text) break;
      try {
        const pcm = await renderOne(text);
        if (pcm.length > 0) {
          results.push({ text, pcm: padToMinimumDuration(pcm) });
          okCount++;
        }
      } catch (err) {
        failCount++;
        // Retry einmal nach kurzer Pause (transienter Cartesia-Hänger)
        await new Promise((r) => setTimeout(r, 300));
        try {
          const pcm = await renderOne(text);
          if (pcm.length > 0) {
            results.push({ text, pcm: padToMinimumDuration(pcm) });
            okCount++;
            failCount--;
          }
        } catch (err2) {
          console.warn(`[filler] TTS-Fehler "${text}":`, (err2 as Error).message);
        }
      }
    }
  });
  await Promise.all(workers);

  const sfx = await sfxPromise;
  cache.push(...results, ...sfx);

  console.log(
    `[filler] ${okCount} TTS-Phrasen (${failCount} Fehler) + ${sfx.length} SFX = ${cache.length} Filler bereit (${Date.now() - t0} ms)`,
  );
}

export function pickFiller(): { pcm: Buffer; text: string; sampleRate: number; encoding: typeof PCM_ENCODING } | null {
  if (!cache.length) return null;
  const item = cache[Math.floor(Math.random() * cache.length)];
  return {
    pcm: item.pcm,
    text: item.text.startsWith('[sfx:') ? '' : item.text,
    sampleRate: PCM_SAMPLE_RATE,
    encoding: PCM_ENCODING,
  };
}

export function pickShortFiller(): { pcm: Buffer; text: string; sampleRate: number; encoding: typeof PCM_ENCODING } | null {
  if (!cache.length) return null;
  const shortFillers = cache.filter(c => c.text.length < 15 || c.text.includes('Hmm') || c.text.includes('Mhm'));
  const pool = shortFillers.length ? shortFillers : cache;
  const item = pool[Math.floor(Math.random() * pool.length)];
  return {
    pcm: item.pcm,
    text: item.text.startsWith('[sfx:') ? '' : item.text,
    sampleRate: PCM_SAMPLE_RATE,
    encoding: PCM_ENCODING,
  };
}
