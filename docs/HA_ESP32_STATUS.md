# HA-ESP32 Custom Firmware — Status

**Stand:** 21.05.2026
**Board:** HA-ESP32 V1.4.0 (Hearit.AI / Gainstrong, ESP32-S3 mit ES8311 + ES7210 Audio-Codecs)
**Ziel:** Eigene Firmware die mit unserem Mistral-Backend statt OpenAI redet

---

## TL;DR

Komplette Voice-Pipeline läuft End-to-End **bis zur Audio-Hardware**:
Button → Mic-Aufnahme → STT → Mistral LLM → Tools → Cartesia TTS → Audio-Chunks zurück.
**Nur Lautsprecher und Mikrofon selbst produzieren keinen Ton** – obwohl die Codec-Chips per
I2C voll ansprechbar sind und die Pin-Konfiguration laut Factory-Firmware-Binary korrekt ist.

---

## Was Funktioniert

| Komponente | Status |
|---|---|
| ESP32-S3 PlatformIO Toolchain (build/flash/monitor) | ✅ |
| WiFi Auto-Connect (`MagentaWLAN-TWCU`) | ✅ |
| WebSocket Verbindung zum Backend (`192.168.2.51:3001`) | ✅ stabil |
| Talk-Button (WF_KEY, ADC auf GPIO 5) | ✅ erkennt Press/Release |
| HTTP POST 150+ KB WAV an `/stt` | ✅ ohne OOM |
| STT-Antwort vom Server | ✅ in <1 s |
| LLM-Streaming + Tool-Calls (web_search) | ✅ |
| TTS-Audio-Chunks streamen via WebSocket | ✅ |
| Audio-Chunk Streaming-Decode (kein Allocations-Crash) | ✅ |
| I2C zu ES8311 (0x18) + ES7210 (0x40) | ✅ Chip-IDs verifiziert |
| Backup vom Original Hearit.AI Firmware | ✅ `backup/factory_firmware_20260521_200840.bin` |

## Was NICHT funktioniert

| Problem | Symptom |
|---|---|
| Lautsprecher | Komplett still – auch bei direktem 1 kHz Sinus-Test |
| Mikrofon | I2S RX liefert **exakt 0** (nicht mal Rauschen) – Spanisch-Halluzination beim STT da reine Stille |

Beide Codec-Chips antworten korrekt auf I2C, Schreibvorgänge gehen durch (Register-Readback
stimmt mit Schreibwerten überein). Aber der I2S-Audio-Pfad bleibt stumm in beide Richtungen.

---

## Was Wir Aus Der Factory-Firmware Bestätigt Haben

Im disassemblierten Binary steht klar `Board: S3_Korvo_V2` als Profil-Referenz:

```
i2c: {sda: 17, scl: 18}
i2s: {mclk: 16, bclk: 9, ws: 45, din: 10, dout: 8}
out: {codec: ES8311, pa: 48, pa_gain: 6, use_mclk: 1}
in: {codec: ES7210}
```

Quelle: [esp-webrtc-solution/components/codec_board/board_cfg.txt](https://github.com/espressif/esp-webrtc-solution/blob/main/components/codec_board/board_cfg.txt)

Das `openai_demo/main/settings.h` des esp-webrtc-solution Repos (auf dem HA-ESP32 basiert)
nutzt explizit:
```c
#define TEST_BOARD_NAME "S3_Korvo_V2"
```

**Unsere Firmware ist exakt mit diesen Werten konfiguriert.**

---

## Warum Es Trotzdem Nicht Geht

Die Espressif-Library `esp_codec_dev` (ESP-IDF C-Komponente, von Hearit.AI verwendet) macht
**deutlich mehr** als einzelne I2C-Register zu setzen:

- Voll konfigurierte Volume-Curves (`esp_codec_dev_set_vol_curve`)
- DAC-Gain + PA-Gain kombiniert über Software-Mapping
- Codec-spezifische Power-State-Machine
- Sample-Rate-Setting mit Clock-Tree-Berechnung

Das ist in **Arduino nicht trivial** nachzubauen. Wir haben die ESP-ADF-Init-Sequenz
manuell repliziert (~50 Register-Writes pro Chip), aber irgendein Detail – wahrscheinlich
PA-Gain-Stage oder Power-State-Sequencing – ist nicht 1:1 abgebildet.

---

## Nächste Schritte – 3 Optionen

### Option 1: Web-UI Demo (sofort einsatzbereit)
```bash
cd server && npm run dev          # Terminal A
cd client && npm run dev          # Terminal B → http://localhost:5173
```
Voller Voice-Loop im Browser. Bewährt, alles fertig.

### Option 2: Pin-Schema vom Lieferanten
Mail an Gainstrong/Hearit.AI mit Bitte um:
- Schaltplan HA-ESP32 V1.4.0
- GPIO-Belegung für PA-Enable, MCLK, BCLK, WS, DOUT, DIN
- PA-Chip Part-Number und Aktivierungs-Logik (HIGH/LOW)
- Falls vorhanden: `board_cfg.txt` Eintrag für HA-ESP32 (falls custom statt S3_Korvo_V2)

Sobald die Antwort da ist: ~20 Min Code-Anpassung in `firmware/esp32-buddly-client/include/config.h`.

### Option 3: Auf ESP-IDF + esp-webrtc-solution wechseln (saubere Lösung)
- `esp-webrtc-solution` klonen
- `solutions/openai_demo` als Vorlage
- `settings.h`: WebSocket-Endpoint auf unseren Server statt OpenAI
- Build mit `idf.py menuconfig` (Board = S3_Korvo_V2)
- Aufwand: 4-6 Std für jemand mit ESP-IDF-Erfahrung

Damit erbt man `esp_codec_dev` automatisch – das was uns gerade fehlt.

---

## Repository-Struktur

```
firmware/esp32-buddly-client/
├── platformio.ini                          PlatformIO config (board: esp32-s3-devkitc-1)
├── include/
│   ├── config.h                            Pinout: I2C, I2S, Button, PA Enable
│   ├── secrets.example.h                   WiFi credentials template
│   ├── secrets.h                           (gitignored, lokal)
│   └── codec.h                             ES8311/ES7210 API
├── src/
│   ├── main.cpp                            Hauptfirmware mit Diagnose-Tools
│   └── codec.cpp                           ES8311 + ES7210 Init
├── backup/                                 (gitignored - enthält Vendor API Key)
│   ├── factory_firmware_*.bin              4 MB Original Hearit.AI Firmware
│   └── factory_strings*.txt                String-Extract
├── backup_factory_firmware.sh              Backup-Skript
└── README.md
```

## Diagnose-Tools (Serial Monitor)

| Taste | Funktion |
|---|---|
| `r` | 3 s Test-Aufnahme |
| `i` | Codec re-init + Register-Verify |
| `s` | I2C-Bus scan |
| `g` | 1 s Roh-Mic Sample (zeigt peak/avg) |
| `d` | ES7210 Komplett-Register-Dump |
| `u` | ES7210 aggressive Unmute |
| `t` | 1 kHz Sinus-Ton 2 s |
| `p` | PA-Pin-Scanner (27 GPIOs × 2 Polaritäten) |

## Factory-Firmware Wiederherstellen

```bash
cd firmware/esp32-buddly-client
pio pkg exec -p tool-esptoolpy -- esptool.py \
  --port /dev/cu.usbmodem14101 --baud 460800 \
  write_flash 0x0 backup/factory_firmware_20260521_200840.bin
```

⚠️ **Achtung:** Die Factory-Bin enthält den **OpenAI API-Key** der Vendoren als Klartext.
Daher nicht öffentlich teilen. Lokal als Disaster-Recovery-Backup ist OK.
