# Buddlys Voice — Architektur

Voice-Agent für Kinder. Browser → Backend → LLM/STT/TTS → Browser, mit
Tool-Use (Web-Suche, Mathe, Uhrzeit) und vorgenerierten Filler-Sounds
gegen Tool-Latenz.

---

## 1. High-Level-Pipeline

```
                                                            ┌────────────────┐
                                                            │  Cartesia      │
                                                            │  Sonic-3 TTS   │
                                                            │  (WebSocket,   │
                                                            │   PCM 24 kHz)  │
                                                            └────────▲───────┘
                                                                     │ transcript
                                                                     │ chunks
                                                                     │ (continue:true)
   ┌──────────────┐    ┌─────────────────────────────────────────────┴─────────┐
   │              │    │                                                       │
   │   Browser    │    │                   Node-Server                         │
   │  (React +    │    │            (Express + ws, TypeScript)                 │
   │   Vite)      │    │                                                       │
   │              │    │   ┌─────────┐    ┌─────────────────────────────────┐  │
   │  ┌────────┐  │    │   │ /stt    │    │  /ws  (User-Konversation)       │  │
   │  │  Mic   │──┼────┼──▶│ POST    │    │                                 │  │
   │  └────────┘  │    │   │ (raw    │    │  ┌──────────┐  ┌─────────────┐  │  │
   │              │    │   │  audio) │    │  │  Mistral │  │ Tool-Loop:  │  │  │
   │  Text input  │    │   └────┬────┘    │  │  Chat    │──▶ calculator  │  │  │
   │       │      │    │        │         │  │  (stream │  │ web_search  │  │  │
   │       ▼      │    │        ▼         │  │  +tools) │  │ current_time│  │  │
   │   WebSocket ─┼────┼──▶ Voxtral STT   │  └────┬─────┘  └──────┬──────┘  │  │
   │              │    │    (Mistral)     │       │               │         │  │
   │  ▲ Audio out │    │                  │       ▼               ▼         │  │
   │  │ (PCM s16) │    │                  │   Sentence-Chunker  Filler-Cache│  │
   │  │           │    │                  │       │             (6 vorgen.) │  │
   │  └───────────┼────┼──── audio_chunk ◀┼───────┴────────┬────┘           │  │
   │              │    │     text_delta   │                │                │  │
   │   Web Audio  │    │     latency      │                ▼                │  │
   │   API queue  │    │     done         │            Cartesia WS          │  │
   │  (sample-    │    │                  │            (Streaming, einen    │  │
   │   genau)     │    │                  │             context_id pro Turn)│  │
   │              │    │                  └─────────────────────────────────┘  │
   └──────────────┘    └───────────────────────────────────────────────────────┘
```

## 2. Komponenten

### Frontend — `client/src/App.tsx`
- Vite + React.
- Ein WebSocket zu `ws://localhost:3001/ws`, **Auto-Reconnect mit Backoff**.
- Audio-Pipeline auf **Web Audio API**:
  - `AudioContext` einmal erzeugt, `nextStartRef` verschiebt jeden neu eintreffenden Buffer ans Ende des vorherigen → sample-genaue Verkettung, keine Codec-Padding-Pops zwischen Chunks.
  - Empfangene PCM-Chunks (`encoding: 'pcm_s16le'`, `sampleRate: 24000`) werden direkt in `AudioBuffer` umgerechnet (Int16 → Float32).
- **Mic**: `MediaRecorder` (webm/opus auf Chrome, mp4 auf Safari). Aufnahme als `Blob` per HTTP POST an `/stt`, Transkript landet im Chat-Flow.
- **Modus-Toggle** (`localStorage`-persistiert):
  - `streaming` — TTS bekommt Text satzweise mit `continue:true`, erstes Audio ~150 ms nach erstem LLM-Token.
  - `full` — wartet bis LLM-Antwort komplett ist, dann einer TTS-Push. Glatteste Tonalität, ~3 s First-Audio.
- **Latenz-Panel**: zeigt alle `latency`-Events des aktuellen Turns live an.

### Backend — `server/src/`

| Datei | Aufgabe |
|---|---|
| `index.ts` | Express, WebSocket, `/stt`-Route, CORS, `.env`-Hot-Reload, Pipeline-Orchestrierung |
| `mistralChat.ts` | Mistral Chat Completions SSE-Stream, **Tool-Loop** (`runConversation`), Systemprompt |
| `mistralStt.ts` | Voxtral STT via `POST /v1/audio/transcriptions` (multipart) |
| `cartesiaTts.ts` | Cartesia Sonic-3 Streaming-WebSocket-Session, `continue:true/false` für durchgehende Prosodie |
| `chunker.ts` | Satz-Chunker: schneidet auf `.?!…` (Punkt-vor-Ziffer nicht) oder max-Length |
| `tools.ts` | Tool-Schemas + `dispatchTool()` (calculator/web_search/current_time) |
| `webSearch.ts` | Tavily-Wrapper, `include_answer:true` für voice-taugliche Antwort |
| `fillerCache.ts` | 6 vorgenerierte „Thinking-Sounds" als PCM im RAM |
| `mistralTts.ts` | Mistral Voxtral TTS via Streaming-SSE, PCM float32 → PCM s16le |
| `omnivoiceTts.ts` | RunPod Serverless OmniVoice-Client (`/run` + `/stream`) |

### Externe APIs
| Dienst | Wofür | Endpoint | Auth |
|---|---|---|---|
| Mistral | Chat + Tool-Use | `POST /v1/chat/completions` (stream) | Bearer |
| Mistral | STT | `POST /v1/audio/transcriptions` | Bearer |
| Mistral | TTS | `POST /v1/audio/speech` (`stream:true`, `response_format:"pcm"`) | Bearer |
| Cartesia | TTS (Streaming) | `wss://api.cartesia.ai/tts/websocket` | `X-API-Key` |
| RunPod | OmniVoice TTS | `POST /v2/{endpoint}/run`, `GET /stream/{job}` | Bearer |
| Tavily | Web-Suche | `POST /search` | `api_key` im Body |

---

## 3. Datenfluss eines Turns

### 3a. Einfache Frage ohne Tool

```
Browser                       Server                         Mistral             Cartesia
   │                             │                              │                   │
   │── user_text ────────────────▶                              │                   │
   │   {mode:'streaming'}        ├─ open Cartesia WS ──────────────────────────────▶│
   │                             ◀──── opened (~140 ms) ───────────────────────────│
   │                             ├─ Chat Completions stream ───▶│                   │
   │                             ◀── delta: "Hallo " ───────────│                   │
   │◀── text_delta "Hallo " ─────┤                              │                   │
   │                             ├─ chunker: nichts (kein Satzende)                 │
   │                             ◀── delta: "Buddly! " ─────────│                   │
   │◀── text_delta "Buddly! " ───┤                              │                   │
   │                             ◀── delta: "Wie geht's?" ──────│                   │
   │                             ├─ chunker: full sentence "Hallo Buddly!"          │
   │                             ├─ cartesia.send(.., continue:true) ──────────────▶│
   │                             ◀── chunk: PCM bytes ───────────────────────────── │
   │◀── audio_chunk (PCM) ───────┤                                                  │
   │                             ◀── delta: "" finish_reason=stop ──┤               │
   │                             ├─ chunker.flush → "Wie geht's?"                   │
   │                             ├─ cartesia.send(.., continue:false) ─────────────▶│
   │                             ◀── chunk PCM, chunk PCM, … ─────────────────────── │
   │◀── audio_chunk ×N ──────────┤                                                  │
   │                             ◀── done ────────────────────────────────────────│
   │◀── done ────────────────────┤
```

### 3b. Frage mit Tool-Call

```
Browser                       Server                  Mistral
   │                             │                      │
   │── "Was ist 17 mal 23?" ─────▶                      │
   │                             ├─ chat (tools enabled)▶│
   │                             ◀── delta: tool_calls[0]= {name:"calculator", args:"{\"expr…
   │                             │     ─── tool_call_pending event
   │◀── audio_chunk (FILLER) ────┤     "Mhm, lass mich kurz nachdenken."
   │◀── text_delta "Mhm…"        │
   │                             ◀── delta: tool_calls[0]args: "…ression\":\"17*23\"}"
   │                             ◀── finish_reason=tool_calls
   │                             ├─ dispatchTool(calculator, "17*23") → "Ergebnis: 391"
   │                             │
   │                             ├─ chat (mit tool result als role=tool) ─▶│
   │                             ◀── delta: "17 mal 23 ist 391. " ─────────│
   │◀── text_delta + audio_chunk ┤                                          
   │                             ◀── delta: "Stell dir vor…" ──────────────│
   │◀── …                        │                                          
   │                             ◀── done
   │◀── done ────────────────────┤
```

**Wichtig**: der Filler kommt aus `fillerCache` (vorgenerierte PCM im RAM, ~0 ms),
**nicht** über eine neue Cartesia-Generation. Dadurch hört das Kind ohne
Pause sofort eine Reaktion, während der zweite LLM-Call läuft.

---

## 4. WebSocket-Protokoll

### Client → Server

```ts
{ type: 'user_text', text: string, mode?: 'streaming' | 'full' }
```

### Server → Client

```ts
{ type: 'text_delta',  text: string }
{ type: 'audio_chunk', encoding: 'pcm_s16le', sampleRate: 24000, audioBase64: string }
{ type: 'latency',     label: string, ms: number }      // Beobachtung jedes Meilensteins
{ type: 'done' }
{ type: 'error',       message: string }
```

### HTTP

```
GET  /health     → { ok, model }
POST /stt        → body=raw audio (webm/mp4/wav)
                 → { text }                 // oder { error }
```

---

## 5. Latenz-Budget (Streaming-Modus, gemessen)

| Meilenstein | Dauer | Anmerkung |
|---|---:|---|
| Cartesia WS open | 130–800 ms | parallel zum Mistral-Call, blockt nicht |
| Mistral first text token | 300–500 ms | TTFT vom LLM |
| Cartesia TTFB | ~145 ms | nach erstem `cartesia.send()` |
| **First audio out beim Client** | **~500–700 ms** | dominanter Faktor: LLM-TTFT |
| Tool-Call Overhead | +500–800 ms | zweiter Mistral-Roundtrip + Tool-Execution |
| Filler-Audio (bei Tool) | 0 ms | aus RAM-Cache; spielt durch den Tool-Loop |

Bei Tool-Aufrufen ist die User-Wahrnehmung „sofort", weil der Filler in dem Moment startet, in dem der LLM den Tool-Call ankündigt — also bevor das Tool überhaupt läuft.

---

## 6. Konfiguration (`.env`)

```bash
# Pflicht
MISTRAL_API_KEY=
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=

# Default-Modelle (überschreibbar für finetuned/neuere Modelle)
MISTRAL_MODEL=mistral-small-2506
MISTRAL_STT_MODEL=voxtral-mini-2507
CARTESIA_MODEL=sonic-3

# Sprachen
CARTESIA_LANGUAGE=de
MISTRAL_STT_LANGUAGE=de

# Optional
TAVILY_API_KEY=             # ohne: web_search meldet "nicht konfiguriert"
PORT=3001
```

**Hot-Reload**: `.env`-Änderungen werden alle 500 ms via `fs.watchFile` erkannt und mit `dotenv.config({override:true})` neu eingelesen — Server-Restart nicht nötig.

---

## 7. Erweitern

### Neues Tool hinzufügen
1. Schema in `server/src/tools.ts` (`TOOL_DEFS`) anhängen.
2. Implementation hinzufügen + Case in `dispatchTool()` ergänzen.
3. Sicherstellen, dass der LLM weiß, wann er es nutzen soll — Systemprompt in `mistralChat.ts` aktualisieren.
4. Mistral-Modell muss `tool_choice:'auto'` korrekt umsetzen (mistral-small-2506+ tut das).

### Andere TTS-Engine
Neue Provider implementieren dieselbe Session-Schnittstelle wie `cartesiaTts.ts`,
`mistralTts.ts` und `omnivoiceTts.ts`:
```ts
openProviderSession(): Promise<{
  send(text: string, isFinal: boolean): void;
  onChunk(cb: (pcm: Buffer) => void): void;
  done: Promise<void>;
  close(): void;
  sampleRate: number;
  encoding: 'pcm_s16le';
}>
```
Wenn die neue Engine MP3/WAV liefert statt PCM, im Client den
`audio_chunk`-Handler erweitern (gibt's schon, fällt automatisch auf
`decodeAudioData` zurück). Streaming-PCM ist für Voice-Agent-Latenz robuster,
weil einzelne MP3/WAV-Fragmente nicht immer separat decodierbar sind.

### Anderes LLM
`server/src/mistralChat.ts` anpassen. Die Tool-Loop-Logik ist OpenAI-kompatibel (Anthropic, Together, Groq, vLLM-self-hosted gehen alle mit minimalen Änderungen).

### Finetune einsetzen
`MISTRAL_MODEL=ft:mistral-small-2506:org:buddly:hash` in `.env`. Sonst nichts ändern.

---

## 8. Sicherheits- & Operations-Notizen

- **Keys**: stehen ausschließlich serverseitig (`server/.env`). Browser sieht keinen Schlüssel.
- **CORS**: aktuell offen (`*`) — für Prod auf die Frontend-Origin einschränken.
- **Mathjs**: `evaluate` ist sandboxed, kein Zugriff auf JS-Globals.
- **Tavily**: Default `search_depth:'basic'` (schneller, billiger). Für tiefere Recherche `'advanced'`.
- **Mic-Permission**: über HTTP geht das nur auf `localhost`. Production-Deployment braucht **HTTPS**.
- **Autoplay**: AudioContext startet im `suspended`-State, wird beim ersten User-Klick aufgeweckt. Fallback-Button im UI für blockiertes Autoplay.
- **`max_tokens: 200`** im Chat-Body: harte Bremse gegen lange Antworten. System-Prompt fordert 1–3 Sätze.

---

## 9. Dateibaum

```
Buddlys Mistal AI/
├── ARCHITECTURE.md           ← dieses Dokument
├── README.md
├── server/
│   ├── .env                  ← Secrets
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          ← Express + ws + Pipeline-Orchestrierung
│       ├── mistralChat.ts    ← Tool-Loop, runConversation()
│       ├── mistralStt.ts     ← Voxtral STT
│       ├── mistralTts.ts     ← Mistral Voxtral Streaming-SSE
│       ├── omnivoiceTts.ts   ← RunPod OmniVoice Serverless-Stream
│       ├── cartesiaTts.ts    ← Cartesia Streaming-Session
│       ├── chunker.ts        ← Satz-Chunker
│       ├── tools.ts          ← Tool-Schemas + dispatchTool()
│       ├── webSearch.ts      ← Tavily-Wrapper
│       └── fillerCache.ts    ← Vorgerenderte Thinking-Sounds
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx           ← UI + Web-Audio-Pipeline + Mic
        └── styles.css
```
