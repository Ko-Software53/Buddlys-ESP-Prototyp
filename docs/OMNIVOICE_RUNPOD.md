# OmniVoice auf RunPod deployen

Hier ist die einfache Schritt-für-Schritt-Anleitung, um OmniVoice für Buddly einzurichten.

## Schritt 1: Docker Image bauen und pushen
1. Öffne dein Terminal und wechsle in den Ordner `omnivoice-runpod`:
   ```bash
   cd omnivoice-runpod
   ```
2. Baue das Docker Image:
   ```bash
   docker build --platform linux/amd64 -t kenotheg/buddly-omnivoice:0.1 .
   ```
3. Lade das Image hoch:
   ```bash
   docker push kenotheg/buddly-omnivoice:0.1
   ```

## Schritt 2: RunPod Pod erstellen
1. Logge dich bei [RunPod](https://www.runpod.io/) ein und gehe auf **Pods**.
2. Klicke auf **Deploy**.
3. Suche nach **Custom Docker Image** oder trage das Image direkt ein.
4. Gib bei **Container Image** dein hochgeladenes Image ein: 
   `kenotheg/buddly-omnivoice:0.1`
5. Wähle eine Grafikkarte (GPU) aus (z.B. **L4**, **A10G** oder **RTX 4090**).
6. Klicke auf **Customize Deployment** (oder ähnlich, um die Einstellungen zu öffnen):
   * **Exposed HTTP Ports**: Trag hier `8000` ein.
   * **Container Disk**: Erhöhe den Wert auf `50 GB`.
7. Füge unter **Environment Variables** (Umgebungsvariablen) einzeln diese Werte hinzu:
   * `OMNIVOICE_MODE` = `websocket`
   * `PORT` = `8000`
   * `OMNIVOICE_MODEL` = `k2-fsa/OmniVoice`
   * `OMNIVOICE_DEVICE` = `cuda:0`
   * `OMNIVOICE_DTYPE` = `float16`
   * `OMNIVOICE_API_KEY` = `ein-geheimes-passwort` *(denk dir hier ein eigenes Passwort aus)*
8. Klicke auf **Deploy**, um den Pod zu starten.

## Schritt 3: URL kopieren
1. Gehe in deine **Pods**-Übersicht in RunPod.
2. Wenn der Pod gestartet ist, klicke auf **Connect**.
3. Unter **HTTP Port 8000** siehst du eine URL, die etwa so aussieht: 
   `https://<pod-id>-8000.proxy.runpod.net`
4. Kopiere diese URL. 

## Schritt 4: Buddly konfigurieren
1. Öffne die Datei `server/.env` in deinem Buddly-Projekt.
2. Trage die kopierte URL und dein Passwort ein. **Wichtig:** Ändere das `https://` der URL zu `wss://` und hänge `/stream` hinten an!
   ```env
   OMNIVOICE_WS_URL=wss://<pod-id>-8000.proxy.runpod.net/stream
   OMNIVOICE_API_KEY=ein-geheimes-passwort
   ```
3. Starte das Backend (`cd server && npm run dev`) und Frontend (`cd client && npm run dev`) neu.
4. Öffne Buddly im Browser, gehe in die **Einstellungen** -> **TTS Provider** und wähle **OmniVoice** aus.

Das war's! Du kannst jetzt mit OmniVoice sprechen.
