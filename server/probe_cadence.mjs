// Re-measure production cadence for a TOOL-CALL reply (the kind that stuttered on
// the toy). If server still streams >=2x realtime with small gaps, the toy stutter
// is local network; if it drops to ~1x / big gaps, it's server-side. Delete after.
import WebSocket from 'ws';
const URL = 'wss://buddlys-esp-prototyp-production.up.railway.app/ws';
const SR = 16000;
const prompt = process.argv[2] || 'Warum sind Flamingos rosa?';

const ws = new WebSocket(URL);
let t0 = 0, firstAudioAt = 0, lastChunkAt = 0, totalAudioMs = 0;
const gaps = []; const chunkMs = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'config', model: 'mistral-small-2506', reasoning: 'auto', tts: true, ttsProvider: 'cartesia' }));
  t0 = Date.now();
  ws.send(JSON.stringify({ type: 'user_text', text: prompt, ttsProvider: 'cartesia' }));
  console.log('[probe] prompt:', prompt);
});
ws.on('message', (raw, isBinary) => {
  const now = Date.now();
  if (isBinary) { // shouldn't happen (no audioBinary flag) but handle anyway
    const ms = (raw.length / 2) / SR * 1000; totalAudioMs += ms; chunkMs.push(ms);
    if (!firstAudioAt) firstAudioAt = now; else gaps.push(now - lastChunkAt); lastChunkAt = now; return;
  }
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'audio_chunk') {
    const ms = (Buffer.from(m.audioBase64, 'base64').length / 2) / SR * 1000;
    totalAudioMs += ms; chunkMs.push(ms);
    if (!firstAudioAt) { firstAudioAt = now; console.log(`[probe] first audio +${now - t0}ms`); }
    else gaps.push(now - lastChunkAt);
    lastChunkAt = now;
  } else if (m.type === 'latency') console.log(`[probe]   ${m.label}: ${m.ms}ms`);
  else if (m.type === 'text_delta') process.stdout.write(m.text);
  else if (m.type === 'error') console.log('\n[probe] ERROR', m.message);
  else if (m.type === 'done') {
    const wall = lastChunkAt - firstAudioAt;
    console.log('\n===== CADENCE =====');
    console.log(`chunks=${chunkMs.length} audio=${totalAudioMs.toFixed(0)}ms wall=${wall}ms rate=${(totalAudioMs/Math.max(1,wall)).toFixed(2)}x`);
    if (gaps.length) {
      const s = [...gaps].sort((a,b)=>a-b);
      console.log(`gaps: median ${s[Math.floor(s.length/2)]}ms p95 ${s[Math.floor(s.length*0.95)]}ms MAX ${s[s.length-1]}ms  (>500ms: ${gaps.filter(g=>g>500).length})`);
    }
    ws.close();
  }
});
ws.on('close', () => process.exit(0));
ws.on('error', (e) => { console.error('ws err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 30000);
