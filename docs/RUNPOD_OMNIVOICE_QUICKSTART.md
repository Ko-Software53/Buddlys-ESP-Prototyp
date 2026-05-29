# RunPod OmniVoice Quickstart

Ziel: warmen RunPod-Pod starten, der OmniVoice per WebSocket streamt.

## 1. Docker Image bauen

```bash
cd omnivoice-runpod

docker build --platform linux/amd64 \
  -t <DEIN-DOCKER-USER>/buddly-omnivoice:0.1 .

docker push <DEIN-DOCKER-USER>/buddly-omnivoice:0.1
```

## 2. RunPod Pod erstellen

In RunPod:

1. `Pods` -> `Deploy`.
2. Custom Docker Image:
   `<DEIN-DOCKER-USER>/buddly-omnivoice:0.1`
3. GPU: zuerst `L4`, `A10G` oder `RTX 4090`.
4. Expose HTTP Port: `8000`.
5. Container Disk: `50 GB`.
6. Env Vars:

```bash
OMNIVOICE_MODE=websocket
PORT=8000
OMNIVOICE_MODEL=k2-fsa/OmniVoice
OMNIVOICE_DEVICE=cuda:0
OMNIVOICE_DTYPE=float16
OMNIVOICE_NUM_STEP=16
OMNIVOICE_SPEED=1.0
OMNIVOICE_CHUNK_MS=160
OMNIVOICE_API_KEY=<ein-shared-secret-ausdenken>

# Optional:
HF_TOKEN=<dein-huggingface-token>
```

## 3. Pod testen

RunPod zeigt dir für Port `8000` eine URL wie:

```text
https://<pod-id>-8000.proxy.runpod.net
```

Health check:

```bash
curl https://<pod-id>-8000.proxy.runpod.net/health
```

Erwartung:

```json
{"ok":true,"modelLoaded":true,"sampleRate":24000}
```

## 4. Buddly Backend konfigurieren

In `server/.env`:

```bash
OMNIVOICE_WS_URL=wss://<pod-id>-8000.proxy.runpod.net/stream
OMNIVOICE_API_KEY=<gleiches-shared-secret>

OMNIVOICE_NUM_STEP=16
OMNIVOICE_SPEED=1.0
OMNIVOICE_CHUNK_MS=160
```

Dann Backend neu starten oder `.env` Hot Reload abwarten:

```bash
cd server
npm run dev
```

## 5. Im UI testen

```bash
cd client
npm run dev
```

Im Browser:

1. Einstellungen öffnen.
2. TTS Provider: `OmniVoice`.
3. Kurze Frage stellen.
4. Latenzpanel beobachten:
   - `tts session open (omnivoice)`
   - `first audio out`
   - `tts done`
   - `total`

## 6. Voice Cloning

Für ersten Test weglassen. Danach:

1. Referenz-WAV auf den Pod legen, z. B. `/workspace/voice/buddly.wav`.
2. Im RunPod Pod Env ergänzen:

```bash
OMNIVOICE_REF_AUDIO_PATH=/workspace/voice/buddly.wav
OMNIVOICE_REF_TEXT=<exakte Transkription des Clips>
```

Pod neu starten.

## 7. Schneller testen

Wenn Qualität okay bleibt:

```bash
OMNIVOICE_NUM_STEP=8
OMNIVOICE_CHUNK_MS=80
```

Wenn Qualität schlechter wird:

```bash
OMNIVOICE_NUM_STEP=16
OMNIVOICE_CHUNK_MS=160
```
