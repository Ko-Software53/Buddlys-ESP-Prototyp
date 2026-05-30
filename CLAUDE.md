# Buddlys — Voice AI Toy (orientation for Claude)

Read this before exploring. It exists so you don't waste a turn re-discovering the
layout. The repo has an `ARCHITECTURE.md` with more depth; this file is the fast map
plus the gotchas that actually cause bugs.

## ⛔ EFFICIENCY RULES — READ FIRST (the user pays per token; wasting them is unacceptable)

A past session burned a large amount of the user's paid credits flailing in Bash instead
of reading files. Do not repeat it.

1. **READ FILES WITH THE `Read` TOOL, DIRECTLY.** The two core files are
   `firmware/appFirmware/main/main.c` and `server/src/index.ts`. Open them with `Read`.
   Do NOT "preview" source via `grep`/`sed`/`awk`/`cat` piped through Bash.
2. **DO NOT pipe file contents through Bash.** This shell has repeatedly mangled/emptied
   output (null bytes, swallowed stdout); each retry costs a full turn. If you catch
   yourself running `grep`/`sed`/`awk`/`cat` on a source file, STOP and use `Read`/`Edit`.
3. **USE ABSOLUTE PATHS.** Bash CWD persists across calls and is often `server/`, not the
   repo root. A wrong relative path = a wasted call.
4. **DON'T GUESS SCHEMAS.** The real Supabase `devices` columns are listed in the gotchas
   below; an earlier session invented `model_override`/`voice_id` (don't exist) and broke
   the build. Verify before referencing.
5. **Minimize calls.** Read a file once, in full, with the right path. Don't re-Read files
   already in context. Don't fan out parallel grep variants hoping one works.

## What this is

A voice AI plush toy for kids. Child speaks → toy records → server transcribes (STT) →
LLM (Mistral) replies → server streams TTS audio back → toy plays it. Half-duplex
(toy either listens OR talks, never both — one shared I2S codec, no AEC).

## Layout (the parts that matter)

- `firmware/appFirmware/main/` — **ESP-IDF firmware in C** (ESP32-S3 Korvo V2 board).
  - `main.c` (~920 lines) — everything: WiFi, WebSocket client, audio capture/VAD,
    jitter-buffered playback, LEDs, buttons, deep sleep.
  - `settings.h` — all tunables: server host, sample rates, **TTS provider**, VAD
    thresholds, GPIO pins, LED colors. Most behavior changes happen here.
  - `ble_prov.c` — BLE WiFi provisioning + device_id. `nvs_config.c` — saved WiFi/server.
  - NOTE: there is no `Buddly_Firmware/` dir and no `.ino` — it's pure ESP-IDF C.
- `server/src/` — **TypeScript** (Node, `type: module`, runs via `tsx`/`tsc`).
  - `index.ts` — Express + `ws` WebSocketServer on `/ws`. Per-connection turn loop.
    This is the orchestrator; start here.
  - `mistralChat.ts` — LLM conversation/streaming. `mistralStt.ts` — Voxtral STT.
  - `cartesiaTts.ts`, `mistralTts.ts`, `omnivoiceTts.ts` — TTS providers (one is chosen
    per turn). All expose the same `TtsSession` interface (`send/onChunk/done/close`).
  - `chunker.ts` — splits LLM text into sentences for incremental TTS.
  - `supabase.ts` — device config, conversation history. `.env` holds all API keys.
  - There is **no Python server**. Ignore any `Mistral_Voicebot/` or `websocket_server.py`
    instinct — they don't exist.
- `mobile/` — Expo/React Native companion app (Supabase auth, BLE provisioning).
- `client/` — React web demo. `supabase/` — DB schema.

## Production

- Server: `https://buddlys-esp-prototyp-production.up.railway.app` (Railway).
  `/health` returns `{ok, model}`. WebSocket at `/ws` (wss, port 443).
- Firmware points at it via `settings.h` `SERVER_HOST`/`SERVER_PORT`.

## The end-to-end turn (so you don't have to trace it)

1. Toy captures speech (VAD or push-to-talk), packs PCM into a WAV, sends it as a
   **binary** WS frame (`send_audio_ws`, main.c).
2. On connect the toy first sends a **text** `config` frame with device_id, model,
   reasoning, and **ttsProvider** (`send_config`, main.c).
3. Server: `ws.on('message')` — binary → `handleAudio` (STT then `handleTurn`);
   text → stores `config` into `turnCfg`, or handles `battery`/`reset`/`user_text`.
4. `handleTurn` streams LLM deltas (`text_delta`), chunks them, feeds TTS, and streams
   audio back as `audio_chunk` JSON frames carrying base64 PCM (16 kHz mono s16le).
5. Toy decodes base64 → `s_jbuf` jitter buffer → `playback_task` plays at realtime.
   `done` ends the turn.

## CRITICAL GOTCHAS (these cause the real bugs)

- **App TTS/model selection — how it flows (FIXED 2026-05-30, LOCAL until Railway redeploy).**
  The device sends its own `config` on connect (hardcoded `settings.h`: `BUDDLY_TTS_PROVIDER`/
  `BUDDLY_MODEL`/`BUDDLY_REASONING`). The app writes the user's choice into the Supabase
  `devices` row. REAL columns (verified via REST): `id, device_id, owner_id, name, model,
  tts_provider, temperature, language, created_at, last_seen_at, battery_level, child_name,
  child_age, interests, avoid_topics, learning_goals, personality, daily_limit_minutes,
  quiet_hours_start, quiet_hours_end, onboarded_at, wifi_ssid`. There is NO `voice_id` and NO
  `model_override` column. The app's device screen (`mobile/app/(main)/device/[id].tsx`)
  updates `name, model, tts_provider, language, temperature`. Previously `handleTurn` used the
  row only for the system prompt and ignored `tts_provider`/`model`, so the app selection was
  dropped and the firmware value won. NOW `handleTurn` reads `tts_provider` and `model` from
  the row and they OVERRIDE the device-sent config (`deviceTtsProvider`/`deviceModel` in
  index.ts). Config is cached **per WebSocket connection** — the toy picks up an app change on
  its next (re)connect, not mid-call. Per-device VOICE is not selectable: cartesia/mistral read
  voice from `.env` (`CARTESIA_VOICE_ID`/`MISTRAL_TTS_VOICE`); no voice column exists to thread.
- **TTS failures used to be silently swallowed (partially FIXED 2026-05-30).** `index.ts`
  `.catch(() => null)` on TTS session open (and `ensureTts()` returning false) means a
  dead/slow/misconfigured provider yields a turn with text but **zero `audio_chunk`s**.
  `handleTurn` now detects "text produced but no audio emitted" and sends an `error` frame
  (toy blinks red) + logs `[tts] no audio emitted for provider=…`. So a mute toy now gives
  a signal instead of silence. If "toy won't talk," FIRST probe `/ws` (config+user_text,
  count audio chunks) and check the requested `ttsProvider` is keyed/enabled in `.env`.
  As of last check BOTH cartesia and mistral return audio fine from production.
- **Stuttering = jitter-buffer underrun, not a code bug.** `playback_task` (main.c) pads
  with silence when audio arrives slower than realtime (WAN/TLS jitter, slow TTS).
  `JITTER_PREBUF_MS` (settings.h, ~400ms) is the cushion. "Works sometimes, stutters
  other times" almost always means the TTS provider / network is the variable, not the FW.
- **Half-duplex.** While speaking (+`VAD_SUPPRESS_MS` echo tail) the mic is ignored on
  purpose (no AEC). Don't "fix" the mic going dead during playback — it's intentional.
- The server's `.env` `MISTRAL_MODEL` may be a reasoning model (e.g. `magistral-*`), but
  the **device overrides it** with `BUDDLY_MODEL` from settings.h per turn.

## How to diagnose "toy won't talk" efficiently (don't re-explore)

1. `curl -s .../health` — server up?
2. Probe `/ws` from `server/` (so `node_modules/ws` resolves): connect, send a `config`
   frame then a `user_text` frame, count `audio_chunk` messages and log `latency`/`error`.
   Text-but-no-audio ⇒ TTS provider problem (see gotchas). No text ⇒ LLM/STT/key problem.
3. Check `server/.env` that the requested provider's key/voice is set and the provider
   isn't disabled.
4. Confirm `settings.h` `BUDDLY_TTS_PROVIDER` matches an enabled provider, then reflash.

## Working efficiently in this repo (meta)

- `main.c` and `index.ts` are the two files you'll touch most — open them directly, don't
  fan out a wide search first.
- Prefer `Read` with an offset/limit over piping `sed`/`awk`/`grep` through Bash; this
  shell has shown flaky output capture and it wastes turns.
- To exercise the live server, write one small `.mjs`/`.cjs` probe **inside `server/`**
  (its `node_modules` has `ws`), run it, and delete it. Don't write probes in `/tmp`
  (module resolution fails there).
- Build/flash firmware with ESP-IDF (`idf.py build flash monitor`) — not Arduino.

