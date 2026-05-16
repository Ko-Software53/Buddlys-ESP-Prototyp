# Buddlys Voice Demo

Browser-Textchat → Mistral Chat (Streaming) → Sentence-Chunking → Voxtral TTS → Audio im Browser.

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
| `MISTRAL_TTS_VOICE` | – | Pflicht. `voice_id` einer in Mistral Studio angelegten Voice |
| `MISTRAL_TTS_FORMAT` | `mp3` | `mp3` / `wav` / `opus` / `pcm` / `flac` |
| `PORT` | `3001` | Server-Port |

> Voxtral TTS hat keine Preset-Stimmen. Du musst einmalig in Mistral Studio
> eine Voice anlegen (Zero-Shot-Cloning aus 2–3 s Audio) und dann die
> `voice_id` in `.env` setzen.

## Wenn dein Account noch keinen TTS-Zugang hat

Der TTS-Adapter ist isoliert in `server/src/mistralTts.ts`. Tausche dort die
Funktion `synthesizeSpeech(text)` gegen einen anderen Provider (ElevenLabs,
OpenAI TTS, Piper) aus – die Signatur `(text: string) => Promise<TtsResult>`
muss bleiben. Der Chat-Streaming-Teil läuft unverändert weiter.

## Latenzlogs

Im Server-Terminal:

```
[lat] time-to-first-text-token: 312ms
[lat] tts-start (+540ms): "Hallo, ich freue mich, dich zu sehen!"
[lat] time-to-first-audio-out: 1480ms
[lat] total: 3210ms
```
