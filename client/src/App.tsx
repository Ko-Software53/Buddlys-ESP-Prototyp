import { useEffect, useRef, useState } from 'react';
import logoUrl from '../../assets/Logo_buddlys_blue.png';
import signetUrl from '../../assets/Logo_buddlys_signet_blue.png';

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
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
      sessionPromptTokens: number;
      sessionCompletionTokens: number;
      sessionTurns: number;
      sessionMinutes: number;
    }
  | { type: 'done' }
  | { type: 'error'; message: string };

interface TurnUsage {
  turn: number;
  ts: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

// Approximate Mistral pricing (USD per 1M tokens)
const PRICE_INPUT = 0.10;
const PRICE_OUTPUT = 0.30;

type Status = 'idle' | 'thinking' | 'speaking' | 'done' | 'error';
type ReasoningMode = 'auto' | 'always' | 'never';
type TtsProvider = 'cartesia' | 'mistral' | 'omnivoice';
type BackendMode = 'local' | 'runpod';

function savedBackendMode(): BackendMode {
  return localStorage.getItem('buddly_backend') === 'runpod' ? 'runpod' : 'local';
}

function savedRunpodUrl(): string {
  return localStorage.getItem('buddly_runpod_url') || '';
}

function deriveUrls(base: string) {
  const b = base.replace(/\/$/, '');
  const ws = b.startsWith('https://')
    ? 'wss://' + b.slice(8) + '/ws'
    : 'ws://' + b.replace(/^http:\/\//, '') + '/ws';
  return { ws, stt: b + '/stt' };
}
const MODELS = [
  { id: 'mistral-small-2506', label: 'Small 2506', desc: 'Baseline' },
  { id: 'mistral-small-2603', label: 'Small 4', desc: 'Neuester Small' },
  { id: 'open-mistral-nemo', label: 'Nemo', desc: '12B Open-weight' },
  { id: 'mistral-medium-2505', label: 'Medium 2505', desc: 'Größer' },
];

interface LatencyEntry {
  label: string;
  ms: number;
}

const LOCAL_BASE = 'http://localhost:3001';

function savedTtsProvider(): TtsProvider {
  const raw = localStorage.getItem('buddly_tts_provider');
  return raw === 'mistral' || raw === 'omnivoice' ? raw : 'cartesia';
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

export function App() {
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [wsReady, setWsReady] = useState(false);

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningMode>(
    (localStorage.getItem('buddly_reasoning') as ReasoningMode | null) ?? 'auto',
  );
  const setReasoningAndPersist = (r: ReasoningMode) => {
    setReasoning(r);
    localStorage.setItem('buddly_reasoning', r);
  };
  const [model, setModel] = useState<string>(
    localStorage.getItem('buddly_model') ?? 'mistral-small-2506',
  );
  const setModelAndPersist = (m: string) => {
    setModel(m);
    localStorage.setItem('buddly_model', m);
  };
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(
    localStorage.getItem('buddly_tts') !== 'false',
  );
  const setTtsAndPersist = (v: boolean) => {
    setTtsEnabled(v);
    localStorage.setItem('buddly_tts', v ? 'true' : 'false');
  };
  const [temperature, setTemperature] = useState<number>(
    parseFloat(localStorage.getItem('buddly_temp') ?? '0.8'),
  );
  const setTempAndPersist = (v: number) => {
    setTemperature(v);
    localStorage.setItem('buddly_temp', String(v));
  };
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(
    savedTtsProvider(),
  );
  const setTtsProviderAndPersist = (v: TtsProvider) => {
    setTtsProvider(v);
    localStorage.setItem('buddly_tts_provider', v);
  };

  const [backendMode, setBackendMode] = useState<BackendMode>(savedBackendMode());
  const [runpodUrl, setRunpodUrl] = useState<string>(savedRunpodUrl());
  const setBackendModeAndPersist = (v: BackendMode) => {
    setBackendMode(v);
    localStorage.setItem('buddly_backend', v);
  };
  const setRunpodUrlAndPersist = (v: string) => {
    setRunpodUrl(v);
    localStorage.setItem('buddly_runpod_url', v);
  };

  const serverBase = backendMode === 'runpod' && runpodUrl ? runpodUrl : LOCAL_BASE;
  const { ws: wsUrl, stt: sttUrl } = deriveUrls(serverBase);
  const sttUrlRef = useRef(sttUrl);
  sttUrlRef.current = sttUrl;
  const [latencies, setLatencies] = useState<LatencyEntry[]>([]);
  const [sttLatency, setSttLatency] = useState<number | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [usageHistory, setUsageHistory] = useState<TurnUsage[]>([]);
  const [sessionStats, setSessionStats] = useState<{
    promptTokens: number; completionTokens: number; turns: number; minutes: number;
  } | null>(null);

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
      const ws = new WebSocket(wsUrl);
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
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') return prev;
              return [...prev.slice(0, -1), { ...last, content: last.content + msg.text }];
            });
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
          case 'usage':
            setUsageHistory((h) => [...h, {
              turn: msg.sessionTurns,
              ts: Date.now(),
              model,
              promptTokens: msg.promptTokens,
              completionTokens: msg.completionTokens,
            }]);
            setSessionStats({
              promptTokens: msg.sessionPromptTokens,
              completionTokens: msg.sessionCompletionTokens,
              turns: msg.sessionTurns,
              minutes: msg.sessionMinutes,
            });
            break;
          case 'done':
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') return prev;
              return [...prev.slice(0, -1), { ...last, pending: false }];
            });
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
  }, [wsUrl]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendText = (raw: string) => {
    const t = raw.trim();
    if (!t || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // User-Gesture: AudioContext anlegen/aufwecken, damit Autoplay greift.
    ensureAudioCtx();

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: t },
      { role: 'assistant', content: '', pending: true },
    ]);
    setError(null);
    setStatus('thinking');
    setLatencies([]);
    setSttLatency(null);
    resetAudioPipeline();

    wsRef.current.send(JSON.stringify({ type: 'user_text', text: t, reasoning, model, tts: ttsEnabled, temperature, ttsProvider }));
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
          const res = await fetch(sttUrlRef.current, {
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
    setMessages([]);
    setError(null);
    setStatus('idle');
    setLatencies([]);
    setSttLatency(null);
    resetAudioPipeline();
    wsRef.current.send(JSON.stringify({ type: 'reset' }));
  };

  const copyAnalyticsCsv = () => {
    const header = 'Turn;Zeit;Modell;Prompt Tokens;Completion Tokens;Total Tokens;Kosten (USD)';
    const rows = usageHistory.map((u) => {
      const total = u.promptTokens + u.completionTokens;
      const cost = ((u.promptTokens * PRICE_INPUT + u.completionTokens * PRICE_OUTPUT) / 1_000_000).toFixed(6);
      const time = new Date(u.ts).toLocaleTimeString('de-DE');
      return [u.turn, time, u.model, u.promptTokens, u.completionTokens, total, cost].join(';');
    });
    if (sessionStats) {
      const total = sessionStats.promptTokens + sessionStats.completionTokens;
      const cost = ((sessionStats.promptTokens * PRICE_INPUT + sessionStats.completionTokens * PRICE_OUTPUT) / 1_000_000).toFixed(6);
      const perMin = sessionStats.minutes > 0 ? Math.round(total / sessionStats.minutes) : 0;
      rows.push('');
      rows.push(`Gesamt;;; ${sessionStats.promptTokens};${sessionStats.completionTokens};${total};${cost}`);
      rows.push(`Tokens/min;;;;; ${perMin};`);
    }
    navigator.clipboard.writeText([header, ...rows].join('\n'));
  };

  return (
    <main className="app-shell">
      <div className="header-row">
        <div className="brand-lockup" aria-label="Buddlys">
          <img className="brand-signet" src={signetUrl} alt="" />
          <img className="brand-logo" src={logoUrl} alt="Buddlys" />
        </div>
        <div className="header-actions">
          <button className="reset-btn" onClick={() => setAnalyticsOpen(true)} title="Analytics">
            Analytics
          </button>
          <button className="reset-btn" onClick={() => setSettingsOpen(true)} title="Einstellungen">
            Einstellungen
          </button>
          <button className="reset-btn" onClick={resetConversation} title="Gespräch löschen">
            Neu starten
          </button>
        </div>
      </div>
      <div className="subtitle">
        Mistral <code className="model-chip">{model}</code>
        {' · '}
        <code className="model-chip">
          {!ttsEnabled ? 'kein Audio' : ttsProvider}
        </code>
      </div>

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Einstellungen</h2>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="Schließen">×</button>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Modell</div>
              <div className="mode-row">
                {MODELS.map((m) => (
                  <label key={m.id} className={`mode ${model === m.id ? 'active' : ''}`}>
                    <input type="radio" name="model" value={m.id} checked={model === m.id}
                      onChange={() => setModelAndPersist(m.id)} />
                    <span className="mode-title">{m.label}</span>
                    <span className="mode-desc">{m.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Reasoning</div>
              <div className="mode-row">
                <label className={`mode ${reasoning === 'auto' ? 'active' : ''}`}>
                  <input type="radio" name="reasoning" checked={reasoning === 'auto'}
                    onChange={() => setReasoningAndPersist('auto')} />
                  <span className="mode-title">Auto</span>
                  <span className="mode-desc">Modell entscheidet</span>
                </label>
                <label className={`mode ${reasoning === 'always' ? 'active' : ''}`}>
                  <input type="radio" name="reasoning" checked={reasoning === 'always'}
                    onChange={() => setReasoningAndPersist('always')} />
                  <span className="mode-title">Immer</span>
                  <span className="mode-desc">tiefes Nachdenken</span>
                </label>
                <label className={`mode ${reasoning === 'never' ? 'active' : ''}`}>
                  <input type="radio" name="reasoning" checked={reasoning === 'never'}
                    onChange={() => setReasoningAndPersist('never')} />
                  <span className="mode-title">Nie</span>
                  <span className="mode-desc">schneller</span>
                </label>
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Server</div>
              <div className="mode-row">
                <label className={`mode ${backendMode === 'local' ? 'active' : ''}`}>
                  <input type="radio" name="backend" checked={backendMode === 'local'}
                    onChange={() => setBackendModeAndPersist('local')} />
                  <span className="mode-title">Lokal</span>
                  <span className="mode-desc">localhost:3001</span>
                </label>
                <label className={`mode ${backendMode === 'runpod' ? 'active' : ''}`}>
                  <input type="radio" name="backend" checked={backendMode === 'runpod'}
                    onChange={() => setBackendModeAndPersist('runpod')} />
                  <span className="mode-title">RunPod</span>
                  <span className="mode-desc">Port 3000</span>
                </label>
              </div>
              {backendMode === 'runpod' && (
                <input
                  type="text"
                  placeholder="https://<pod-id>-3000.proxy.runpod.net"
                  value={runpodUrl}
                  onChange={(e) => setRunpodUrlAndPersist(e.target.value)}
                  className="runpod-input"
                />
              )}
            </div>

            <div className="modal-section">
              <div className="modal-section-title">TTS Provider</div>
              <div className="mode-row">
                <label className={`mode ${ttsEnabled && ttsProvider === 'cartesia' ? 'active' : ''}`}>
                  <input type="radio" name="ttsprovider" checked={ttsEnabled && ttsProvider === 'cartesia'}
                    onChange={() => { setTtsAndPersist(true); setTtsProviderAndPersist('cartesia'); }} />
                  <span className="mode-title">Cartesia</span>
                  <span className="mode-desc">Streaming WS</span>
                </label>
                <label className={`mode ${ttsEnabled && ttsProvider === 'mistral' ? 'active' : ''}`}>
                  <input type="radio" name="ttsprovider" checked={ttsEnabled && ttsProvider === 'mistral'}
                    onChange={() => { setTtsAndPersist(true); setTtsProviderAndPersist('mistral'); }} />
                  <span className="mode-title">Mistral</span>
                  <span className="mode-desc">Voxtral PCM</span>
                </label>
                <label className={`mode ${ttsEnabled && ttsProvider === 'omnivoice' ? 'active' : ''}`}>
                  <input type="radio" name="ttsprovider" checked={ttsEnabled && ttsProvider === 'omnivoice'}
                    onChange={() => { setTtsAndPersist(true); setTtsProviderAndPersist('omnivoice'); }} />
                  <span className="mode-title">OmniVoice</span>
                  <span className="mode-desc">RunPod</span>
                </label>
                <label className={`mode ${!ttsEnabled ? 'active' : ''}`}>
                  <input type="radio" name="ttsprovider" checked={!ttsEnabled}
                    onChange={() => setTtsAndPersist(false)} />
                  <span className="mode-title">Kein Audio</span>
                  <span className="mode-desc">nur Text</span>
                </label>
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Temperature</div>
              <label className="setting-item">
                <span className="setting-label">Wert <strong>{temperature.toFixed(1)}</strong></span>
                <input type="range" min="0" max="1.5" step="0.1" value={temperature}
                  onChange={(e) => setTempAndPersist(parseFloat(e.target.value))} />
                <span className="setting-hint">kreativ ↑</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {analyticsOpen && (
        <div className="modal-backdrop" onClick={() => setAnalyticsOpen(false)}>
          <div className="modal analytics-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Analytics</h2>
              <button className="modal-close" onClick={() => setAnalyticsOpen(false)} aria-label="Schließen">×</button>
            </div>

            {sessionStats && (
              <div className="analytics-summary">
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Turns</span>
                  <span className="analytics-stat-value">{sessionStats.turns}</span>
                </div>
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Prompt Tokens</span>
                  <span className="analytics-stat-value">{sessionStats.promptTokens.toLocaleString('de-DE')}</span>
                </div>
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Completion Tokens</span>
                  <span className="analytics-stat-value">{sessionStats.completionTokens.toLocaleString('de-DE')}</span>
                </div>
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Total</span>
                  <span className="analytics-stat-value">{(sessionStats.promptTokens + sessionStats.completionTokens).toLocaleString('de-DE')}</span>
                </div>
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Tokens/min</span>
                  <span className="analytics-stat-value">
                    {sessionStats.minutes > 0 ? Math.round((sessionStats.promptTokens + sessionStats.completionTokens) / sessionStats.minutes).toLocaleString('de-DE') : '–'}
                  </span>
                </div>
                <div className="analytics-stat">
                  <span className="analytics-stat-label">Kosten</span>
                  <span className="analytics-stat-value analytics-cost">
                    ${((sessionStats.promptTokens * PRICE_INPUT + sessionStats.completionTokens * PRICE_OUTPUT) / 1_000_000).toFixed(5)}
                  </span>
                </div>
              </div>
            )}

            {usageHistory.length === 0 ? (
              <div className="analytics-empty">Noch keine Daten – führe ein Gespräch.</div>
            ) : (
              <div className="analytics-table-wrap">
                <table className="analytics-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Zeit</th>
                      <th>Modell</th>
                      <th>Prompt</th>
                      <th>Completion</th>
                      <th>Total</th>
                      <th>Kosten (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageHistory.map((u, i) => {
                      const total = u.promptTokens + u.completionTokens;
                      const cost = (u.promptTokens * PRICE_INPUT + u.completionTokens * PRICE_OUTPUT) / 1_000_000;
                      return (
                        <tr key={i}>
                          <td>{u.turn}</td>
                          <td>{new Date(u.ts).toLocaleTimeString('de-DE')}</td>
                          <td className="analytics-model">{u.model}</td>
                          <td>{u.promptTokens.toLocaleString('de-DE')}</td>
                          <td>{u.completionTokens.toLocaleString('de-DE')}</td>
                          <td>{total.toLocaleString('de-DE')}</td>
                          <td>${cost.toFixed(5)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="modal-footer">
              <button className="reset-btn" onClick={copyAnalyticsCsv} disabled={usageHistory.length === 0}>
                CSV kopieren (Excel)
              </button>
              <span className="analytics-price-hint">
                Preise: ${PRICE_INPUT}/1M input · ${PRICE_OUTPUT}/1M output
              </span>
            </div>
          </div>
        </div>
      )}

      <div className={`status ${recording ? 'speaking' : transcribing ? 'thinking' : status}`}>
        {recording && 'hört zu …'}
        {!recording && transcribing && 'verstehe …'}
        {!recording && !transcribing && status === 'idle' && (wsReady ? 'bereit' : 'verbinde …')}
        {!recording && !transcribing && status === 'thinking' && 'denkt …'}
        {!recording && !transcribing && status === 'speaking' && 'spricht …'}
        {!recording && !transcribing && status === 'done' && 'fertig'}
        {!recording && !transcribing && status === 'error' && 'fehler'}
      </div>

      <div className="chat-window">
        {messages.length === 0 && (
          <div className="chat-empty">
            <img src={signetUrl} alt="" />
            <span>Stell Buddly eine Frage …</span>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg--${msg.role}${msg.pending ? ' chat-msg--pending' : ''}`}>
            <span className="chat-bubble">{msg.content || (msg.pending ? '…' : '')}</span>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      <div className="input-row">
        <button
          className={`mic ${recording ? 'recording' : ''}`}
          onClick={toggleRecord}
          disabled={!wsReady || transcribing || status === 'thinking' || status === 'speaking'}
          title={recording ? 'Stop' : 'Sprechen'}
          aria-label={recording ? 'Aufnahme stoppen' : 'Aufnahme starten'}
        >
          {recording ? '■' : 'Mic'}
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
    </main>
  );
}
