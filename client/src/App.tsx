import { useEffect, useRef, useState } from 'react';

type ServerMsg =
  | { type: 'text_delta'; text: string }
  | {
      type: 'audio_chunk';
      audioBase64: string;
      mimeType?: string;
      encoding?: 'pcm_s16le';
      sampleRate?: number;
    }
  | { type: 'latency'; label: string; ms: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

type Status = 'idle' | 'thinking' | 'speaking' | 'done' | 'error';
type TtsMode = 'streaming' | 'full';
type ReasoningMode = 'auto' | 'always' | 'never';

interface LatencyEntry {
  label: string;
  ms: number;
}

const WS_URL = 'ws://localhost:3001/ws';
const STT_URL = 'http://localhost:3001/stt';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function App() {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [wsReady, setWsReady] = useState(false);

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [mode, setMode] = useState<TtsMode>(
    (localStorage.getItem('buddly_mode') as TtsMode | null) ?? 'full',
  );
  const [reasoning, setReasoning] = useState<ReasoningMode>(
    (localStorage.getItem('buddly_reasoning') as ReasoningMode | null) ?? 'auto',
  );
  const setReasoningAndPersist = (r: ReasoningMode) => {
    setReasoning(r);
    localStorage.setItem('buddly_reasoning', r);
  };
  const [latencies, setLatencies] = useState<LatencyEntry[]>([]);
  const [sttLatency, setSttLatency] = useState<number | null>(null);

  const setModeAndPersist = (m: TtsMode) => {
    setMode(m);
    localStorage.setItem('buddly_mode', m);
  };

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);

  // Web-Audio-Pipeline: ein AudioContext, sample-genau aneinander gefügte
  // Buffer. Keine HTML-<audio>-Elemente → keine Codec-Padding-Pops zwischen
  // Chunks, deutlich sauberere Übergänge.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef<number>(0);
  const playingCountRef = useRef<number>(0);

  const ensureAudioCtx = (): AudioContext => {
    let ctx = audioCtxRef.current;
    if (!ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new Ctor();
      audioCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    return ctx;
  };

  const scheduleAudioBuffer = (ctx: AudioContext, audioBuf: AudioBuffer) => {
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStartRef.current);
    src.start(startAt);
    nextStartRef.current = startAt + audioBuf.duration;
    playingCountRef.current += 1;
    src.onended = () => {
      playingCountRef.current -= 1;
    };
  };

  /** Container-Audio (WAV/MP3): über decodeAudioData. */
  const enqueueAudio = async (b64: string) => {
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') {
      setNeedsUnlock(true);
      return;
    }
    try {
      const buf = base64ToArrayBuffer(b64);
      const audioBuf = await ctx.decodeAudioData(buf);
      scheduleAudioBuffer(ctx, audioBuf);
    } catch (err) {
      console.error('decodeAudioData failed', err);
    }
  };

  /** Raw PCM s16le → Float32 AudioBuffer, sample-genau angefügt. */
  const enqueuePcm = (b64: string, sampleRate: number) => {
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') {
      setNeedsUnlock(true);
      return;
    }
    const ab = base64ToArrayBuffer(b64);
    if (ab.byteLength < 2) return;
    const view = new DataView(ab);
    const sampleCount = ab.byteLength >>> 1;
    const audioBuf = ctx.createBuffer(1, sampleCount, sampleRate);
    const ch = audioBuf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      ch[i] = view.getInt16(i * 2, true) / 32768;
    }
    scheduleAudioBuffer(ctx, audioBuf);
  };

  const resetAudioPipeline = () => {
    const ctx = audioCtxRef.current;
    if (ctx) {
      nextStartRef.current = ctx.currentTime;
    } else {
      nextStartRef.current = 0;
    }
    playingCountRef.current = 0;
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setWsReady(true);
        setError(null);
      };
      ws.onclose = () => {
        if (wsRef.current === ws) setWsReady(false);
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** attempts, 5000);
        attempts++;
        retryTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        if (!cancelled) setError('WebSocket getrennt – versuche neu zu verbinden …');
      };
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'text_delta':
            setAnswer((a) => a + msg.text);
            setStatus((s) => (s === 'thinking' ? 'speaking' : s));
            break;
          case 'audio_chunk': {
            setStatus((s) => (s === 'idle' ? 'speaking' : s));
            if (msg.encoding === 'pcm_s16le' && msg.sampleRate) {
              enqueuePcm(msg.audioBase64, msg.sampleRate);
            } else {
              void enqueueAudio(msg.audioBase64);
            }
            break;
          }
          case 'latency':
            setLatencies((l) => [...l, { label: msg.label, ms: msg.ms }]);
            break;
          case 'done':
            setStatus('done');
            break;
          case 'error':
            setError(msg.message);
            setStatus('error');
            break;
        }
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  const sendText = (raw: string) => {
    const t = raw.trim();
    if (!t || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // User-Gesture: AudioContext anlegen/aufwecken, damit Autoplay greift.
    ensureAudioCtx();

    setAnswer('');
    setError(null);
    setStatus('thinking');
    setLatencies([]);
    resetAudioPipeline();

    wsRef.current.send(JSON.stringify({ type: 'user_text', text: t, mode, reasoning }));
    setText('');
  };

  const send = () => sendText(text);

  const startRecording = async () => {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // AudioContext über User-Gesture aufwecken
      ensureAudioCtx();

      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = rec;
      recordChunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        const blob = new Blob(recordChunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        });
        recordChunksRef.current = [];
        if (blob.size < 200) {
          setError('Aufnahme zu kurz.');
          setTranscribing(false);
          return;
        }
        try {
          setTranscribing(true);
          setSttLatency(null);
          const sttStart = performance.now();
          const res = await fetch(STT_URL, {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            body: blob,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`STT HTTP ${res.status}: ${body.slice(0, 200)}`);
          }
          const data = (await res.json()) as { text?: string; error?: string };
          if (data.error) throw new Error(data.error);
          const txt = (data.text || '').trim();
          setSttLatency(Math.round(performance.now() - sttStart));
          setTranscribing(false);
          if (!txt) {
            setError('Konnte dich nicht verstehen – bitte nochmal.');
            return;
          }
          sendText(txt);
        } catch (err) {
          setTranscribing(false);
          setError((err as Error).message);
        }
      };

      rec.start();
      setRecording(true);
      setError(null);
    } catch (err) {
      setError(`Mikrofon: ${(err as Error).message}`);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    setRecording(false);
  };

  const toggleRecord = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  const unlockAudio = () => {
    setNeedsUnlock(false);
    const ctx = ensureAudioCtx();
    void ctx.resume();
  };

  const resetConversation = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setAnswer('');
    setError(null);
    setStatus('idle');
    setLatencies([]);
    setSttLatency(null);
    resetAudioPipeline();
    wsRef.current.send(JSON.stringify({ type: 'reset' }));
  };

  return (
    <div className="app">
      <div className="header-row">
        <h1>Buddlys Voice Demo</h1>
        <button className="reset-btn" onClick={resetConversation} title="Gespräch löschen">
          Neu starten
        </button>
      </div>
      <div className="subtitle">
        Streaming Chat + Voxtral TTS · Mistral{' '}
        <code style={{ color: '#9aa0a6' }}>mistral-small-2506</code>
      </div>

      <div className="mode-row">
        <label className={`mode ${mode === 'full' ? 'active' : ''}`}>
          <input
            type="radio"
            name="mode"
            value="full"
            checked={mode === 'full'}
            onChange={() => setModeAndPersist('full')}
          />
          <span className="mode-title">Top-Qualität</span>
          <span className="mode-desc">eine TTS-Generation, ~3 s Wartezeit</span>
        </label>
        <label className={`mode ${mode === 'streaming' ? 'active' : ''}`}>
          <input
            type="radio"
            name="mode"
            value="streaming"
            checked={mode === 'streaming'}
            onChange={() => setModeAndPersist('streaming')}
          />
          <span className="mode-title">Schnell (Streaming)</span>
          <span className="mode-desc">Audio nach 1. Satz, Brüche möglich</span>
        </label>
      </div>

      <div className="mode-row reasoning-row">
        <label className={`mode ${reasoning === 'auto' ? 'active' : ''}`}>
          <input
            type="radio"
            name="reasoning"
            value="auto"
            checked={reasoning === 'auto'}
            onChange={() => setReasoningAndPersist('auto')}
          />
          <span className="mode-title">Reasoning: Auto</span>
          <span className="mode-desc">Modell entscheidet</span>
        </label>
        <label className={`mode ${reasoning === 'always' ? 'active' : ''}`}>
          <input
            type="radio"
            name="reasoning"
            value="always"
            checked={reasoning === 'always'}
            onChange={() => setReasoningAndPersist('always')}
          />
          <span className="mode-title">Immer</span>
          <span className="mode-desc">erzwingt tiefes Nachdenken</span>
        </label>
        <label className={`mode ${reasoning === 'never' ? 'active' : ''}`}>
          <input
            type="radio"
            name="reasoning"
            value="never"
            checked={reasoning === 'never'}
            onChange={() => setReasoningAndPersist('never')}
          />
          <span className="mode-title">Nie</span>
          <span className="mode-desc">schneller, weniger Tiefe</span>
        </label>
      </div>

      <div className={`status ${recording ? 'speaking' : transcribing ? 'thinking' : status}`}>
        {recording && 'hört zu …'}
        {!recording && transcribing && 'verstehe …'}
        {!recording && !transcribing && status === 'idle' && (wsReady ? 'bereit' : 'verbinde …')}
        {!recording && !transcribing && status === 'thinking' && 'denkt …'}
        {!recording && !transcribing && status === 'speaking' && 'spricht …'}
        {!recording && !transcribing && status === 'done' && 'fertig'}
        {!recording && !transcribing && status === 'error' && 'fehler'}
      </div>

      <div className={`answer ${answer ? '' : 'empty'}`}>
        {answer || 'Buddly-Antwort erscheint hier live …'}
      </div>

      <div className="input-row">
        <button
          className={`mic ${recording ? 'recording' : ''}`}
          onClick={toggleRecord}
          disabled={!wsReady || transcribing || status === 'thinking' || status === 'speaking'}
          title={recording ? 'Stop' : 'Sprechen'}
          aria-label={recording ? 'Aufnahme stoppen' : 'Aufnahme starten'}
        >
          {recording ? '■' : '🎤'}
        </button>
        <input
          type="text"
          placeholder={recording ? 'Sprich jetzt …' : 'Was möchtest du Buddly fragen?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          disabled={!wsReady || recording || transcribing}
        />
        <button
          onClick={send}
          disabled={
            !wsReady ||
            !text.trim() ||
            recording ||
            transcribing ||
            status === 'thinking' ||
            status === 'speaking'
          }
        >
          Senden
        </button>
      </div>

      {needsUnlock && (
        <div className="unlock">
          <span>Browser blockiert Autoplay – klicke, um Audio zu aktivieren.</span>
          <button onClick={unlockAudio}>Audio aktivieren</button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="latency-panel">
        <div className="latency-title">Latenzen</div>
        {sttLatency != null && (
          <div className="lat-row">
            <span>STT (Aufnahme → Text)</span>
            <span className="lat-val">{sttLatency} ms</span>
          </div>
        )}
        {latencies.length === 0 && sttLatency == null && (
          <div className="lat-row empty">noch keine Daten</div>
        )}
        {latencies.map((l, i) => (
          <div key={i} className="lat-row">
            <span>{l.label}</span>
            <span className="lat-val">{l.ms} ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
