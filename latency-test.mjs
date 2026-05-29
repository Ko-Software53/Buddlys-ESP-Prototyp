const TTS_URL = "https://9cy2yuvsk6dpee.api.runpod.ai/tts_pcm";
const API_KEY = process.env.RUNPOD_API_KEY;
const text = "Hallo, ich bin Buddly und helfe dir heute.";

const t0 = performance.now();

const res = await fetch(TTS_URL, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ text }),
});

const t1 = performance.now();
const audioBuffer = await res.arrayBuffer();
const t2 = performance.now();

console.log({
  status: res.status,
  serverInference: res.headers.get("x-inference-sec"),
  wavEncode: res.headers.get("x-wav-encode-sec"),
  totalServer: res.headers.get("x-total-server-sec"),
  audioSec: res.headers.get("x-audio-sec"),
  rtf: res.headers.get("x-rtf"),
  headersMs: Math.round(t1 - t0),
  fullDownloadMs: Math.round(t2 - t0),
  bytes: audioBuffer.byteLength,
});
