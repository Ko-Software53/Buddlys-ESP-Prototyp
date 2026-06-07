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
#define MIC_CHANNELS        2        // legacy: MIC1+MIC2 as L+R (pre-AEC mix path)
#define MIC_BITS            16
#define MAX_RECORD_SECONDS  15

// ─── AEC / barge-in (esp-sr AFE) ─────────────────────────────────────────────
// The ES7210 is read in 4-slot TDM (codec_board already configures all 4 mics).
// Those 4 slots carry the two real mics PLUS the speaker echo-reference that the
// AFE needs for acoustic echo cancellation. We feed all 4 to esp-sr's AFE and
// consume its echo-cancelled MONO output, so the child's voice can be detected
// (libfvad) even while Buddly is talking → barge-in.
#define MIC_TDM_CHANNELS    4
// How the 4 interleaved TDM slots map to AFE channel roles:
//   M = microphone, R = playback echo-reference, N = unused/null.
// This MUST match the board's real slot order. "RMNM" matches the ES8311+ES7210
// korvo-2-class layout (slot0=reference, slot1=mic, slot2=null, slot3=mic).
// VERIFY ON DEVICE: dump the 4 slots while a clip plays and confirm which slot
// carries the speaker signal; adjust this string if the reference isn't slot 0.
#define BUDDLY_AFE_INPUT_FORMAT "RMNM"
// Master switch for voice barge-in. 1 = mic stays live during playback (AEC) and
// the child can interrupt; 0 = classic strict half-duplex (mic muted while talking).
#define BUDDLY_BARGE_IN     1

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
#define WIFI_READY_SETTLE_MS    800   // RSSI must stay solid this long before the toy goes "ready" (no timeout fallback — link must genuinely settle)

// VAD settings — speech vs. non-speech is now decided by libfvad (a model that
// looks at the signal's spectral shape), NOT a raw RMS energy threshold. Energy
// thresholds couldn't separate steady room noise from a child's voice at the same
// loudness, so a noisy room held turns open to the buffer cap. See vad_capture_chunk.
#define VAD_FVAD_MODE           3     // libfvad aggressiveness: 0=quality … 3=most noise-rejecting. Higher = fewer false "speech" frames in noise. 3 chosen because this mic runs very high gain (30 dB + ×4) and the amplified noise floor is easily mistaken for speech; drop toward 1–2 only if quiet speech gets missed.
#define VAD_ONSET_SPEECH_FRAMES 3     // consecutive 20 ms speech frames (×20 ms) required to OPEN a turn, so one stray frame can't trigger a spurious upload. 3 = ~60 ms. The preroll backfills audio before onset so nothing is lost.
#define VAD_MIN_SPEECH_FRAMES   8     // a turn must contain at least this many speech frames (×20 ms) total or it's dropped without uploading — kills brief false triggers that the STT would otherwise hallucinate a reply to. 8 = ~160 ms. Lower if very short answers ("Ja") get dropped; raise to be stricter about noise.
#define VAD_SILENCE_MS          300   // ms of continuous NON-speech before the turn ends. Pure dead time on the critical path before STT, so it's felt directly as latency. A real pause/"ähm" is voiced so it keeps the turn alive — only true silence counts down — so this can be short. Raise toward 500 if kids get cut off mid-thought; lower toward 200 for snappier replies.
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
