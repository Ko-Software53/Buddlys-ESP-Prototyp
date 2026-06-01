#pragma once

#define BOARD_NAME          "S3_Korvo_V2"

// Leave empty for BLE provisioning via the Buddlys app.
// If set, used as fallback when NVS has no saved config.
#define WIFI_SSID           ""
#define WIFI_PASSWORD       ""

#define SERVER_HOST         "buddlys-esp-prototyp-production.up.railway.app"
#define SERVER_PORT         443
#define STT_PATH            "/stt"
#define WS_URI              "/ws"

#define BUDDLY_MODEL        "mistral-small-2506"
#define BUDDLY_TTS_PROVIDER "cartesia"
#define BUDDLY_REASONING    "auto"

// Push-to-talk: AI key, digital GPIO 47, active low.
#define TALK_BTN_GPIO          47
#define TALK_BTN_ACTIVE_LOW    1

// Power/wake: WIFI key, digital GPIO 5, active low.
//   single press from deep sleep -> wake (ext0 on this pin)
//   triple press within window -> enter deep sleep
#define POWER_BTN_GPIO              5
#define POWER_BTN_ACTIVE_LOW        1
#define POWER_BTN_TRIPLE_WINDOW_MS  1500

// On-board RGB LEDs (3 separate GPIOs, active low).
#define LED_R_GPIO          14
#define LED_G_GPIO          13
#define LED_B_GPIO          12
#define LED_ACTIVE_LOW      1

#define MIC_SAMPLE_RATE     16000
#define MIC_CHANNELS        2        // MIC1+MIC2 as L+R; we mix to mono
#define MIC_BITS            16
#define MAX_RECORD_SECONDS  15

#define SPK_SAMPLE_RATE     16000
#define SPK_CHANNELS        2
#define SPK_BITS            16
#define DEFAULT_VOLUME      85
#define MIC_GAIN_DB         30.0f    // ADC hardware gain in dB (0–37.5, ES7210)
#define MIC_SW_GAIN         4        // software gain multiplier applied after ADC

// Boot talk mode: 0 = push-to-talk, 1 = VAD (always-on listening)
// Long-press the power button at runtime to toggle between modes.
#define TALK_MODE_DEFAULT       0

// ─── Warm-up gate (post-deep-sleep robustness) ──────────────────────────────
// After a deep-sleep wake the WiFi radio is briefly marginal (partial recal, AP
// re-association, DHCP). Letting the child talk into that window causes the
// dropped-connection + stutter seen on wake. So the toy holds off "ready" until
// the link is genuinely solid, and plays a spoken status clip in the meantime.
#define WARMUP_AUDIO_FEEDBACK   1     // 1 = play embedded voice clips on connect/reconnect
#define WIFI_READY_RSSI_DBM     (-78) // link counts as solid at/above this RSSI (dBm; closer to 0 = stronger)
#define WIFI_READY_SETTLE_MS    800   // RSSI must stay solid this long before the toy goes "ready"
#define WIFI_READY_MAX_WAIT_MS  4000  // hard cap: go ready anyway this long after WS connects (weak-but-working link)

// VAD settings — thresholds are in post-software-gain RMS units
#define VAD_SPEECH_THRESHOLD    800   // RMS to trigger speech onset (lower = wakes on quieter speech)
#define VAD_CONTINUE_THRESHOLD  500   // RMS to keep an active turn alive; below this counts toward end-of-turn silence.
                                      // MEASURED 2026-05-31: with the high mic gain (30dB+4x) the ambient NOISE FLOOR reads
                                      // ~200–350 RMS, so the old 300 let noise keep resetting the silence timer → turns never
                                      // ended → ran to the 15s buffer cap and uploaded huge recordings. Real continued speech
                                      // sits well above 500 (onset gate is 800); 500 lets the ~350 noise floor count as silence
                                      // so end-of-speech actually fires. If a noisy room still won't end turns, raise toward 600.
#define VAD_SILENCE_MS          900   // ms below the continue threshold before the turn ends (higher = tolerates mid-sentence pauses like "uhm").
                                      // This is pure dead time after the child stops talking, ON the critical path before STT even starts —
                                      // every ms here is felt as latency. 900 tolerates thinking pauses and filler words ("um"); drop toward 600 if latency bothers.
#define VAD_PREROLL_MS          200   // ms of audio captured before onset
#define VAD_SUPPRESS_MS         700   // echo-tail guard after last playback sample before the mic re-engages (half-duplex)

// --- Battery reporting ---
// The device reports its battery charge (0–100 %) to the server over the WS
// connection; the server stores it in Supabase and the app shows it.
// No battery-sense hardware is wired yet, so this is OFF by default. To enable:
//   1. Implement battery_read_percent() in main.c (ADC divider or I2C gauge).
//   2. Set BATTERY_REPORT_ENABLED to 1.
#define BATTERY_REPORT_ENABLED  0
#define BATTERY_REPORT_MS       60000  // how often to report while connected

// Power button gestures
#define POWER_BTN_LONG_MS       1000  // hold duration to toggle talk mode
