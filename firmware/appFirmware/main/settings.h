#pragma once

#define BOARD_NAME          "S3_Korvo_V2"

// Leave empty for BLE provisioning via the Buddlys app.
// If set, used as fallback when NVS has no saved config.
#define WIFI_SSID           ""
#define WIFI_PASSWORD       ""

#define SERVER_HOST         ""
#define SERVER_PORT         3001
#define STT_PATH            "/stt"
#define WS_URI              ""

#define BUDDLY_MODEL        "mistral-small-2506"
#define BUDDLY_TTS_PROVIDER "cartesia"
#define BUDDLY_REASONING    "never"

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
#define TALK_MODE_DEFAULT       1

// VAD settings — thresholds are in post-software-gain RMS units
#define VAD_SPEECH_THRESHOLD    1200  // RMS to trigger speech onset
#define VAD_SILENCE_THRESHOLD   200   // RMS below this counts as silence
#define VAD_SILENCE_MS          600   // consecutive silence ms to end turn
#define VAD_PREROLL_MS          200   // ms of audio captured before onset
#define VAD_SUPPRESS_MS         500   // brief echo tail after last sample; s_stream_active covers playback

// Power button gestures
#define POWER_BTN_LONG_MS       1000  // hold duration to toggle talk mode
