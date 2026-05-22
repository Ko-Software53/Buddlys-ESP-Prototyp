# Buddlys Voice Demo

Browser-Textchat → Mistral Chat (Streaming) → Sentence-Chunking → TTS-Provider → Audio im Browser.

## Setup

```bash
# 1. Backend
cd server
cp .env.example .env          # MISTRAL_API_KEY + MISTRAL_TTS_VOICE eintragen
npm install
npm run dev                   # http://localhost:3001  (ws: ws://localhost:3001/ws)

# 2. Frontend (zweites Terminal)
cd client
npm install
npm run dev                   # http://localhost:5173
```

## Wichtige .env-Felder

| Variable | Default | Zweck |
|---|---|---|
| `MISTRAL_API_KEY` | – | Pflicht |
| `MISTRAL_MODEL` | `mistral-small-2506` | **hier dein finetuned Modell eintragen**, z. B. `ft:mistral-small-2506:org:buddly:abcd` |
| `MISTRAL_TTS_MODEL` | `voxtral-mini-tts-2603` | Voxtral TTS |
| `MISTRAL_TTS_VOICE` | – | Pflicht für Provider `Mistral`. `voice_id` oder Name einer in Mistral Studio angelegten Voice |
| `MISTRAL_TTS_FORMAT` | `mp3` | Nur für den non-streaming Helper. Der UI-Provider nutzt Streaming-`pcm` |
| `RUNPOD_API_KEY` | – | Pflicht für Provider `OmniVoice` |
| `OMNIVOICE_RUNPOD_ENDPOINT_ID` | – | RunPod Serverless Endpoint ID |
| `PORT` | `3001` | Server-Port |

> Für Voxtral TTS musst du einmalig in Mistral Studio eine Voice anlegen
> (Zero-Shot-Cloning aus 2–3 s Audio) und dann die `voice_id` oder den Namen
> in `.env` setzen. Im UI danach unter Einstellungen → TTS Provider
> `Mistral` wählen.

## TTS Provider

- `Cartesia`: WebSocket-Streaming mit `pcm_s16le`.
- `Mistral`: Voxtral TTS via `POST /v1/audio/speech` mit `stream:true`,
  `response_format:"pcm"` und serverseitiger Float32-zu-s16-Konvertierung.
- `OmniVoice`: RunPod Serverless Worker (`/run` + `/stream`) mit 24-kHz-PCM.

RunPod-Deployment für OmniVoice: [docs/OMNIVOICE_RUNPOD.md](docs/OMNIVOICE_RUNPOD.md).

## Latenzlogs

Im Server-Terminal:

```
[lat] time-to-first-text-token: 312ms
[lat] tts-start (+540ms): "Hallo, ich freue mich, dich zu sehen!"
[lat] time-to-first-audio-out: 1480ms
[lat] total: 3210ms
```
