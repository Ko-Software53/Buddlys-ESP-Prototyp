#include <string.h>
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_websocket_client.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "esp_phy_init.h"
#include "driver/gpio.h"
#include "esp_codec_dev.h"
#include "codec_init.h"
#include "mbedtls/base64.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "settings.h"
#include "nvs_config.h"
#include "ble_prov.h"

static const char *TAG = "buddly";

// ─── State ───────────────────────────────────────────────────────────────────

static EventGroupHandle_t s_wifi_eg;
#define WIFI_CONNECTED_BIT BIT0

static esp_websocket_client_handle_t s_ws = NULL;
static bool s_ws_connected = false;
static volatile bool s_ws_started = false;
static volatile bool s_config_sent = false;
static bool s_recording    = false;
static int16_t *s_rec_buf  = NULL;
static size_t   s_rec_samples = 0;
static size_t   s_rec_cap     = 0;

// ─── Streamed audio upload ──────────────────────────────────────────────────
// Instead of one blocking send of the whole WAV after end-of-speech (which put
// the entire 1.5–3 s upload on the critical path AFTER the child stopped
// talking), we stream the recording to the server WHILE the child is still
// speaking. s_rec_buf is a single-producer/single-consumer buffer: the capture
// loop appends and advances s_rec_samples; audio_sender_task drains
// [s_tx_sent, s_rec_samples) as raw-PCM binary frames. Both run on CPU0, so the
// "write sample, then bump the index" ordering the consumer relies on holds.
// Control frames bracket the stream: audio_start (before any chunk), audio_end
// (after the last), or audio_cancel (utterance discarded — too short/silent).
#define STREAM_CHUNK_SAMPLES  3200   // 200 ms @ 16 kHz: flush granularity
static volatile size_t s_tx_sent      = 0;
static volatile bool   s_streaming    = false;  // an utterance is being streamed
static volatile bool   s_stream_end   = false;  // capture done; flush tail + finish
static volatile bool   s_stream_cancel = false; // discard utterance (too short/silent)

#define WS_REASSEMBLY_SIZE (64 * 1024)
static char    *s_ws_buf       = NULL;
static size_t   s_ws_buf_len   = 0;
static bool     s_ws_is_binary = false;  // current WS frame is a binary (raw-PCM) audio frame

static volatile uint32_t s_thinking_since_ms = 0;
static volatile uint32_t s_last_speaking_ms  = 0;
static volatile uint32_t s_error_until_ms    = 0;
static uint32_t          s_last_batt_ms      = 0;
static volatile bool     s_drain_jbuf        = false;
static volatile bool     s_stream_active     = false;
static esp_netif_t      *s_sta_netif         = NULL;

static int      s_talk_mode        = TALK_MODE_DEFAULT;

#define JITTER_BUF_SAMPLES  (MIC_SAMPLE_RATE * 8)
#define JITTER_PREBUF_MS    1500  // absorb real WAN/TTS/WiFi gaps before playback starts
#define JITTER_REBUF_MS     900   // re-prebuffer after mid-stream underrun without restarting too early
static int16_t       *s_jbuf    = NULL;
static volatile size_t s_jbuf_wr = 0;
static volatile size_t s_jbuf_rd = 0;

#define PCM_DECODE_BUF_SIZE (MIC_SAMPLE_RATE * 4)
static uint8_t *s_pcm_decode_buf = NULL;

// PCM intake queue: decouples WS event handler from the blocking jitter-buffer
// write, so the WS client task is never stalled by a full ring buffer.
typedef struct { uint8_t *data; size_t len; } pcm_block_t;
#define PCM_QUEUE_LEN 32
static QueueHandle_t s_pcm_queue = NULL;

#define VAD_PREROLL_FRAMES ((size_t)(MIC_SAMPLE_RATE * VAD_PREROLL_MS / 1000))
static int16_t *s_preroll_buf      = NULL;
static size_t   s_preroll_head     = 0;
static bool     s_preroll_full     = false;
static bool     s_vad_in_speech    = false;
static uint32_t s_silence_since_ms = 0;

// Runtime server config (filled from NVS or settings.h defaults)
static char     s_srv_host[128] = SERVER_HOST;
static uint16_t s_srv_port      = SERVER_PORT;

static inline uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

// ─── LED ──────────────────────────────────────────────────────────────────

typedef enum {
    LEDC_OFF, LEDC_RED, LEDC_GREEN, LEDC_BLUE,
    LEDC_YELLOW, LEDC_MAGENTA, LEDC_CYAN, LEDC_WHITE,
} led_color_t;

static void led_set(led_color_t c)
{
    const int on  = LED_ACTIVE_LOW ? 0 : 1;
    const int off = LED_ACTIVE_LOW ? 1 : 0;
    const bool r = c == LEDC_RED   || c == LEDC_YELLOW  || c == LEDC_MAGENTA || c == LEDC_WHITE;
    const bool g = c == LEDC_GREEN || c == LEDC_YELLOW  || c == LEDC_CYAN    || c == LEDC_WHITE;
    const bool b = c == LEDC_BLUE  || c == LEDC_MAGENTA || c == LEDC_CYAN    || c == LEDC_WHITE;
    gpio_set_level(LED_R_GPIO, r ? on : off);
    gpio_set_level(LED_G_GPIO, g ? on : off);
    gpio_set_level(LED_B_GPIO, b ? on : off);
}

static void led_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << LED_R_GPIO) | (1ULL << LED_G_GPIO) | (1ULL << LED_B_GPIO),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io);
    led_set(LEDC_RED);
}

static volatile bool s_ble_provisioning = false;
static volatile bool s_wifi_connecting  = false;
static volatile bool s_wifi_has_ip      = false;
// Warm-up gate: false until the link is solid enough to take a turn. While false
// the toy ignores the mic/button so the child can't talk into a half-connected
// radio (the post-deep-sleep failure mode). See the main loop.
static volatile bool s_app_ready        = false;

static void led_task(void *arg)
{
    while (1) {
        uint32_t now = now_ms();

        if (s_ble_provisioning) {
            led_set((now / 300) & 1 ? LEDC_CYAN : LEDC_OFF);
        } else if (s_wifi_connecting || !s_app_ready) {
            // Warming up: connecting / waiting for a solid link before "ready".
            led_set((now / 200) & 1 ? LEDC_YELLOW : LEDC_OFF);
        } else if (s_error_until_ms && now < s_error_until_ms) {
            led_set((now / 100) & 1 ? LEDC_RED : LEDC_OFF);
        } else if (s_recording) {
            led_set(LEDC_BLUE);
        } else if (now - s_last_speaking_ms < 400) {
            led_set(LEDC_MAGENTA);
        } else if (s_thinking_since_ms && now - s_thinking_since_ms < 30000) {
            led_set((now / 200) & 1 ? LEDC_BLUE : LEDC_OFF);
        } else if (!s_ws_connected) {
            led_set((now / 500) & 1 ? LEDC_GREEN : LEDC_OFF);
        } else {
            led_set((now % 2000) < 150 ? LEDC_GREEN : LEDC_OFF);
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// ─── WiFi ─────────────────────────────────────────────────────────────────

static void on_wifi_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
    char ip[20];
    snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ev->ip_info.ip));
    ESP_LOGI(TAG, "WiFi connected, IP=%s", ip);
    if (s_sta_netif) {
        esp_netif_dns_info_t dns = {0};
        dns.ip.type = IPADDR_TYPE_V4;
        dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("1.1.1.1");
        esp_err_t dns_err = esp_netif_set_dns_info(s_sta_netif, ESP_NETIF_DNS_FALLBACK, &dns);
        if (dns_err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to set fallback DNS: %s", esp_err_to_name(dns_err));
        }
    }
    s_wifi_has_ip = true;
    ble_prov_notify_wifi_status("connected", ip);
    xEventGroupSetBits(s_wifi_eg, WIFI_CONNECTED_BIT);
}

static volatile bool s_wifi_established = false;

static void on_wifi_disconnect(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ESP_LOGW(TAG, "WiFi disconnected");
    s_wifi_has_ip = false;
    s_ws_connected = false;
    s_config_sent = false;
    s_app_ready = false;
    xEventGroupClearBits(s_wifi_eg, WIFI_CONNECTED_BIT);
    // Retry on disconnect during the INITIAL connect too, not only after a
    // connection was once established. Some APs (e.g. WPA3 WLAN-65QWSM) answer
    // the first association with "refused temporarily"; without this retry the
    // single attempt failed and we sat idle until the 15 s timeout, never
    // getting an IP (then DNS/getaddrinfo fails and the WS can't connect).
    if (s_wifi_established || s_wifi_connecting) {
        ESP_LOGI(TAG, "Re-connecting...");
        esp_wifi_connect();
    }
}

static void wifi_driver_init(void)
{
    s_wifi_eg = xEventGroupCreate();
    esp_netif_init();
    esp_event_loop_create_default();
    s_sta_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_wifi_init(&cfg);

    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                        on_wifi_got_ip, NULL, NULL);
    esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                        on_wifi_disconnect, NULL, NULL);

    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_start();

    // Realtime audio streaming can't tolerate modem sleep: the default
    // WIFI_PS_MIN_MODEM parks the radio between DTIM beacons, adding 100–300 ms
    // latency spikes and jitter that show up as stuttering playback. Keep the
    // radio always on.
    esp_wifi_set_ps(WIFI_PS_NONE);
}

#define WIFI_CONNECT_TIMEOUT_MS  15000

static bool wifi_connect(const char *ssid, const char *pass)
{
    s_wifi_connecting = true;
    s_wifi_has_ip = false;
    xEventGroupClearBits(s_wifi_eg, WIFI_CONNECTED_BIT);

    wifi_config_t wc = { .sta = { .threshold.authmode = WIFI_AUTH_WPA2_PSK } };
    strncpy((char *)wc.sta.ssid,     ssid, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, pass, sizeof(wc.sta.password) - 1);
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    esp_wifi_connect();

    ESP_LOGI(TAG, "Waiting for WiFi (%s)...", ssid);
    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, WIFI_CONNECTED_BIT,
                        pdFALSE, pdTRUE,
                        pdMS_TO_TICKS(WIFI_CONNECT_TIMEOUT_MS));
    s_wifi_connecting = false;

    if (bits & WIFI_CONNECTED_BIT) {
        s_wifi_established = true;
        return true;
    }
    ESP_LOGE(TAG, "WiFi connection timed out");
    esp_wifi_disconnect();
    ble_prov_notify_wifi_status("failed", "");
    return false;
}

// ─── Audio helpers ────────────────────────────────────────────────────────

static void open_record(void)
{
    esp_codec_dev_handle_t rec = get_record_handle();
    esp_codec_dev_sample_info_t info = {
        .sample_rate    = MIC_SAMPLE_RATE,
        .channel        = MIC_CHANNELS,
        .bits_per_sample = MIC_BITS,
    };
    esp_codec_dev_open(rec, &info);
}

static void open_playback(void)
{
    esp_codec_dev_handle_t play = get_playback_handle();
    esp_codec_dev_sample_info_t info = {
        .sample_rate    = SPK_SAMPLE_RATE,
        .channel        = SPK_CHANNELS,
        .bits_per_sample = SPK_BITS,
    };
    esp_codec_dev_open(play, &info);
    size_t frames = SPK_SAMPLE_RATE * 100 / 1000;
    int16_t *sil = calloc(frames * SPK_CHANNELS, sizeof(int16_t));
    if (sil) {
        esp_codec_dev_write(play, sil, frames * SPK_CHANNELS * sizeof(int16_t));
        free(sil);
    }
}

static inline int16_t mic_gain(int16_t s)
{
    int32_t v = (int32_t)s * MIC_SW_GAIN;
    if (v >  32767) v =  32767;
    if (v < -32768) v = -32768;
    return (int16_t)v;
}

static void play_pcm16_mono(const uint8_t *pcm, size_t byte_len)
{
    if (!s_jbuf) return;
    const int16_t *mono = (const int16_t *)pcm;
    size_t n = byte_len / sizeof(int16_t);
    size_t written = 0;
    while (written < n) {
        if (s_drain_jbuf) return;
        __asm__ volatile("memw" ::: "memory");
        size_t wr = s_jbuf_wr;
        size_t rd = s_jbuf_rd;
        // Free slots (1 slot reserved to distinguish full from empty)
        size_t free_slots = (rd > wr)
            ? (rd - wr - 1)
            : (JITTER_BUF_SAMPLES - wr + rd - 1);
        if (free_slots == 0) { vTaskDelay(pdMS_TO_TICKS(5)); continue; }
        size_t batch = n - written;
        if (batch > free_slots) batch = free_slots;
        size_t to_end = JITTER_BUF_SAMPLES - wr;
        if (batch <= to_end) {
            memcpy(&s_jbuf[wr], &mono[written], batch * sizeof(int16_t));
        } else {
            memcpy(&s_jbuf[wr], &mono[written], to_end * sizeof(int16_t));
            memcpy(&s_jbuf[0], &mono[written + to_end], (batch - to_end) * sizeof(int16_t));
        }
        __asm__ volatile("memw" ::: "memory");
        s_jbuf_wr = (wr + batch) % JITTER_BUF_SAMPLES;
        written += batch;
    }
}

// ─── Embedded voice feedback clips ──────────────────────────────────────────
// Spoken status messages in Buddly's own Cartesia voice, baked into the binary
// via EMBED_FILES (CMakeLists.txt) as raw 16 kHz mono s16le PCM. Generated by
// server/scripts/gen_feedback_clips.mjs. Played LOCALLY (no network) so the toy
// can reassure the child while the WiFi/WebSocket link is still coming up.
extern const uint8_t clip_waking_start[]    asm("_binary_clip_waking_pcm_start");
extern const uint8_t clip_waking_end[]      asm("_binary_clip_waking_pcm_end");
extern const uint8_t clip_ready_start[]     asm("_binary_clip_ready_pcm_start");
extern const uint8_t clip_ready_end[]       asm("_binary_clip_ready_pcm_end");
extern const uint8_t clip_reconnect_start[] asm("_binary_clip_reconnect_pcm_start");
extern const uint8_t clip_reconnect_end[]   asm("_binary_clip_reconnect_pcm_end");

/** Play an embedded PCM clip through the normal jitter-buffered playback path.
 *  Non-blocking for clips up to the 8 s buffer. Skipped while a live server turn
 *  is streaming so local feedback never collides with Buddly's reply. */
static void play_clip(const uint8_t *start, const uint8_t *end)
{
#if WARMUP_AUDIO_FEEDBACK
    if (!start || end <= start || s_stream_active) return;
    play_pcm16_mono(start, (size_t)(end - start));
    // Hold the mic suppressed (half-duplex, no AEC) until the clip drains; the
    // playback task keeps bumping s_last_speaking_ms while it actually plays.
    s_last_speaking_ms = now_ms();
#else
    (void)start; (void)end;
#endif
}

/** Drain the PCM intake queue, freeing all queued blocks (for barge-in). */
static void flush_pcm_queue(void)
{
    if (!s_pcm_queue) return;
    pcm_block_t blk;
    while (xQueueReceive(s_pcm_queue, &blk, 0) == pdTRUE) {
        free(blk.data);
    }
}

/** Reads PCM blocks from the intake queue and feeds them into the jitter ring
 *  buffer. Runs on CPU1 at priority 10 — between the WS client (lower) and
 *  the playback task (18), so playback always preempts this. */
static void pcm_feeder_task(void *arg)
{
    pcm_block_t blk;
    while (1) {
        if (xQueueReceive(s_pcm_queue, &blk, portMAX_DELAY) == pdTRUE) {
            play_pcm16_mono(blk.data, blk.len);
            free(blk.data);
        }
    }
}

static void playback_task(void *arg)
{
    const size_t CHUNK  = MIC_SAMPLE_RATE * 30 / 1000;
    const size_t PREBUF = (size_t)(MIC_SAMPLE_RATE * JITTER_PREBUF_MS / 1000);
    const size_t REBUF  = (size_t)(MIC_SAMPLE_RATE * JITTER_REBUF_MS / 1000);
    bool playing = false;
    size_t rebuf_target = 0;
    esp_codec_dev_handle_t play = get_playback_handle();
    int16_t stereo[MIC_SAMPLE_RATE * 30 / 1000 * 2];
    int16_t mono_tmp[MIC_SAMPLE_RATE * 30 / 1000];

    while (1) {
        if (s_drain_jbuf) {
            __asm__ volatile("memw" ::: "memory");
            s_jbuf_rd    = s_jbuf_wr;
            playing      = false;
            rebuf_target = 0;
            s_drain_jbuf = false;
            __asm__ volatile("memw" ::: "memory");
            flush_pcm_queue();
        }

        size_t wr    = s_jbuf_wr;
        __asm__ volatile("memw" ::: "memory");
        size_t rd    = s_jbuf_rd;
        size_t avail = (wr >= rd) ? (wr - rd) : (JITTER_BUF_SAMPLES - rd + wr);

        // Prebuffer check: wait for enough data before starting/resuming playback.
        // After a mid-stream underrun, use the shorter REBUF target to minimize
        // the audible gap while still absorbing jitter.
        {
            size_t needed = rebuf_target > 0 ? rebuf_target : PREBUF;
            if (!playing && avail > 0 && (avail >= needed || !s_stream_active)) {
                playing = true;
                rebuf_target = 0;
            }
        }

        // Turn finished and buffer fully drained → stop, re-arming the cushion.
        if (playing && avail == 0 && !s_stream_active) {
            playing = false;
            rebuf_target = 0;
        }

        // Mid-stream underrun: pause playback and re-prebuffer with a shorter
        // cushion instead of continuing with zero margin (which cascades).
        if (playing && avail == 0 && s_stream_active) {
            playing = false;
            rebuf_target = REBUF;
            static uint32_t s_last_underrun_ms = 0;
            if (now_ms() - s_last_underrun_ms >= 500) {
                s_last_underrun_ms = now_ms();
                ESP_LOGW(TAG, "playback underrun — re-prebuffering %ums",
                         (unsigned)JITTER_REBUF_MS);
            }
        }

        if (playing) {
            size_t n = avail < CHUNK ? avail : CHUNK;
            // Block-read from ring buffer, then mono→stereo duplication.
            // One memcpy (or two at wrap-around) + one barrier replaces the
            // per-sample memw loop that was burning ~16k barriers/second.
            size_t to_end = JITTER_BUF_SAMPLES - rd;
            if (n <= to_end) {
                memcpy(mono_tmp, &s_jbuf[rd], n * sizeof(int16_t));
            } else {
                memcpy(mono_tmp, &s_jbuf[rd], to_end * sizeof(int16_t));
                memcpy(&mono_tmp[to_end], &s_jbuf[0], (n - to_end) * sizeof(int16_t));
            }
            __asm__ volatile("memw" ::: "memory");
            s_jbuf_rd = (rd + n) % JITTER_BUF_SAMPLES;
            for (size_t i = 0; i < n; i++) {
                stereo[i * 2]     = mono_tmp[i];
                stereo[i * 2 + 1] = mono_tmp[i];
            }
            memset(&stereo[n * 2], 0, (CHUNK - n) * 2 * sizeof(int16_t));
            if (n > 0) s_last_speaking_ms = now_ms();
        } else {
            memset(stereo, 0, sizeof(stereo));
        }

        esp_codec_dev_write(play, stereo, sizeof(stereo));
    }
}

// ─── WAV header ──────────────────────────────────────────────────────────

// Stream the recorded utterance to the server as raw PCM (16 kHz mono s16le) in
// binary frames WHILE the child is still talking, bracketed by audio_start /
// audio_end text control frames. The server reassembles the chunks into a WAV
// and runs STT on the same persistent connection (no per-turn TLS handshake).
// Streaming overlaps the upload with speech, so end-of-speech → STT no longer
// waits on a multi-second blocking transfer.

static void send_audio_ctrl(const char *type)
{
    if (!s_ws_connected || !s_ws) return;
    char msg[48];
    int n = snprintf(msg, sizeof(msg), "{\"type\":\"%s\"}", type);
    esp_websocket_client_send_text(s_ws, msg, n, pdMS_TO_TICKS(3000));
}

// Open a streamed utterance: announce it, then arm the sender. audio_start MUST
// reach the server before any chunk, so we send it (synchronously) before
// flipping s_streaming on. Caller must have already reset s_rec_samples = 0.
static void stream_begin(void)
{
    s_tx_sent    = 0;
    s_stream_end = false;
    send_audio_ctrl("audio_start");
    s_streaming  = true;
}

// Drains s_rec_buf to the server as the capture loop fills it. Pinned to CPU0
// (same core as capture) so the producer's "write sample, then bump index"
// ordering is observed here without explicit barriers. A blocking send only
// parks THIS task on socket I/O; the capture loop keeps reading the mic.
static void audio_sender_task(void *arg)
{
    for (;;) {
        if (!s_streaming) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }

        if (s_stream_cancel) {            // utterance discarded — drop buffered audio
            send_audio_ctrl("audio_cancel");
            s_streaming = false; s_stream_end = false; s_stream_cancel = false;
            continue;
        }

        // Do NOT transmit while the mic is still live: continuous WiFi TX couples
        // noise into the high-gain ES7210 ADC, lifting the RMS above
        // VAD_CONTINUE_THRESHOLD so end-of-speech never fires (the turn ran to the
        // 15 s cap). The TCP-window fix makes the post-speech upload fast enough
        // (~200 ms for a normal turn) that we don't need to overlap it with speech,
        // so we hold all chunks until capture finishes (s_stream_end), then burst.
        if (!s_stream_end) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }

        size_t produced  = s_rec_samples;     // snapshot producer index
        size_t avail     = produced - s_tx_sent;
        bool   finishing = s_stream_end;

        if (avail >= STREAM_CHUNK_SAMPLES || (finishing && avail > 0)) {
            size_t n = avail > STREAM_CHUNK_SAMPLES ? STREAM_CHUNK_SAMPLES : avail;
            int sent = esp_websocket_client_send_bin(
                s_ws, (const char *)(s_rec_buf + s_tx_sent),
                (int)(n * sizeof(int16_t)), pdMS_TO_TICKS(10000));
            if (sent < 0) {
                ESP_LOGE(TAG, "stream send failed — aborting utterance");
                s_streaming = false; s_stream_end = false;
                send_audio_ctrl("audio_cancel");
                continue;
            }
            s_tx_sent += n;
        } else if (finishing) {            // all drained → close the utterance
            send_audio_ctrl("audio_end");
            ESP_LOGI(TAG, "→ WS streamed %u samples", (unsigned)s_tx_sent);
            s_streaming  = false;
            s_stream_end = false;
        } else {
            vTaskDelay(pdMS_TO_TICKS(10));  // wait for the capture loop
        }
    }
}

// ─── WebSocket ───────────────────────────────────────────────────────────

// Tell the server the per-device turn settings once per connection. Binary
// audio frames carry no metadata, so the server remembers these and applies
// them to every transcribed turn.
static void send_config(void)
{
    if (!s_ws_connected || !s_ws) return;

    // audioBinary:true → ask the server to send TTS as raw-binary WS frames
    // instead of base64-JSON audio_chunk. Negotiated per connection, so older
    // servers (and the web client, which omits the flag) keep the JSON path.
    char *msg = NULL;
    asprintf(&msg,
        "{\"type\":\"config\",\"device_id\":\"%s\",\"model\":\"%s\","
        "\"reasoning\":\"%s\",\"tts\":true,\"ttsProvider\":\"%s\",\"audioBinary\":true}",
        ble_prov_device_id(), BUDDLY_MODEL, BUDDLY_REASONING, BUDDLY_TTS_PROVIDER);
    if (!msg) return;

    ESP_LOGI(TAG, "→ WS config: %s", msg);
    esp_websocket_client_send_text(s_ws, msg, strlen(msg), pdMS_TO_TICKS(3000));
    free(msg);
}

// Returns the battery charge as 0–100 %, or -1 if unknown/unavailable.
// TODO: implement the real measurement once battery-sense hardware exists.
//   • ADC voltage divider: configure the ADC unit/channel, read mV, map the
//     battery voltage range (e.g. 3.30 V→0 %, 4.20 V→100 %) to a percentage.
//   • I2C fuel gauge (e.g. MAX17048): read the SOC register directly.
// Until then this returns -1 so no placeholder value is ever reported.
static int battery_read_percent(void)
{
    return -1;
}

static void send_battery(void)
{
    if (!s_ws_connected || !s_ws) return;
    int pct = battery_read_percent();
    if (pct < 0) return;            // unknown — never report a fake value
    if (pct > 100) pct = 100;

    char *msg = NULL;
    asprintf(&msg,
        "{\"type\":\"battery\",\"device_id\":\"%s\",\"level\":%d}",
        ble_prov_device_id(), pct);
    if (!msg) return;
    esp_websocket_client_send_text(s_ws, msg, strlen(msg), pdMS_TO_TICKS(3000));
    free(msg);
}

static void handle_ws_message(const char *data, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (!root) return;

    cJSON *type_item = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type_item)) { cJSON_Delete(root); return; }
    const char *type = type_item->valuestring;

    if (strcmp(type, "audio_chunk") == 0) {
        s_thinking_since_ms = 0;
        s_stream_active     = true;
        s_last_speaking_ms  = now_ms();
        cJSON *b64_item = cJSON_GetObjectItem(root, "audioBase64");
        if (cJSON_IsString(b64_item)) {
            const char *b64 = b64_item->valuestring;
            size_t b64_len  = strlen(b64);
            size_t out_len  = (b64_len * 3) / 4 + 4;
            if (s_pcm_decode_buf && out_len <= PCM_DECODE_BUF_SIZE) {
                size_t actual = 0;
                if (mbedtls_base64_decode(s_pcm_decode_buf, out_len, &actual,
                    (const unsigned char *)b64, b64_len) == 0 && actual > 0) {
                    pcm_block_t blk;
                    blk.data = heap_caps_malloc(actual, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                    if (blk.data) {
                        memcpy(blk.data, s_pcm_decode_buf, actual);
                        blk.len = actual;
                        if (xQueueSend(s_pcm_queue, &blk, 0) != pdTRUE) {
                            free(blk.data);
                            ESP_LOGW(TAG, "pcm queue full — dropped chunk");
                        }
                    }
                }
            }
        }
    } else if (strcmp(type, "text_delta") == 0) {
        cJSON *t = cJSON_GetObjectItem(root, "text");
        if (cJSON_IsString(t)) printf("%s", t->valuestring);
    } else if (strcmp(type, "done") == 0) {
        s_thinking_since_ms = 0;
        s_stream_active     = false;
        printf("\n[done]\n");
    } else if (strcmp(type, "error") == 0) {
        s_thinking_since_ms = 0;
        s_stream_active     = false;
        s_error_until_ms    = now_ms() + 1500;
        cJSON *m = cJSON_GetObjectItem(root, "message");
        ESP_LOGE(TAG, "Server error: %s",
                 cJSON_IsString(m) ? m->valuestring : "?");
    }

    cJSON_Delete(root);
}

static void ws_event_handler(void *arg, esp_event_base_t base,
                             int32_t id, void *event_data)
{
    esp_websocket_event_data_t *ev = (esp_websocket_event_data_t *)event_data;
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "WS connected");
            s_ws_connected = true;
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "WS disconnected");
            s_ws_connected  = false;
            s_stream_active = false;
            s_ws_buf_len    = 0;
            s_config_sent   = false;   // re-send config after reconnect
            // Drop any in-progress upload; nothing can be sent until reconnect.
            s_streaming = false; s_stream_end = false; s_stream_cancel = false;
            break;
        case WEBSOCKET_EVENT_DATA:
            if (ev->op_code == 0x8) break;   // close frame
            // Reassemble the (possibly fragmented) frame into s_ws_buf, then
            // dispatch by type. Audio now arrives as BINARY frames (op_code 0x2)
            // carrying raw PCM (16 kHz mono s16le) with NO base64/JSON wrapper —
            // saving ~33% downlink bandwidth and the per-chunk base64 decode on
            // the toy. Control frames (text_delta/done/error/latency) stay text
            // JSON. Latch the frame type at its FIRST fragment (payload_offset 0);
            // continuation fragments may report op_code 0x0, so we must not
            // re-read the opcode mid-frame.
            if (ev->payload_offset == 0) {
                s_ws_buf_len   = 0;
                s_ws_is_binary = (ev->op_code == 0x2);
            }
            if (s_ws_buf && s_ws_buf_len + ev->data_len < WS_REASSEMBLY_SIZE) {
                memcpy(s_ws_buf + s_ws_buf_len, ev->data_ptr, ev->data_len);
                s_ws_buf_len += ev->data_len;
            }
            if (s_ws_buf_len >= (size_t)ev->payload_len && ev->payload_len > 0) {
                if (s_ws_is_binary) {
                    // Raw-PCM audio chunk → straight into the jitter buffer.
                    s_thinking_since_ms = 0;
                    s_stream_active     = true;
                    s_last_speaking_ms  = now_ms();
                    {
                        pcm_block_t blk;
                        blk.data = heap_caps_malloc(s_ws_buf_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                        if (blk.data) {
                            memcpy(blk.data, s_ws_buf, s_ws_buf_len);
                            blk.len = s_ws_buf_len;
                            if (xQueueSend(s_pcm_queue, &blk, 0) != pdTRUE) {
                                free(blk.data);
                                ESP_LOGW(TAG, "pcm queue full — dropped chunk");
                            }
                        }
                    }
                } else {
                    s_ws_buf[s_ws_buf_len] = '\0';
                    handle_ws_message(s_ws_buf, s_ws_buf_len);
                }
                s_ws_buf_len = 0;
            }
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGE(TAG, "WS error");
            break;
        case WEBSOCKET_EVENT_FINISH:
            ESP_LOGI(TAG, "WS task finished");
            s_ws_started = false;
            break;
        default: break;
    }
}

static void ws_reset_runtime_state(void)
{
    s_ws_connected  = false;
    s_stream_active = false;
    s_ws_buf_len    = 0;
    s_config_sent   = false;
    s_streaming = false; s_stream_end = false; s_stream_cancel = false;
}

static void ws_start_if_wifi_ready(void)
{
    static uint32_t last_start_attempt_ms = 0;
    uint32_t now = now_ms();
    if (!s_ws || s_ws_started || !s_wifi_has_ip) return;
    if (last_start_attempt_ms && now - last_start_attempt_ms < 1000) return;
    last_start_attempt_ms = now;

    ESP_LOGI(TAG, "Starting WS");
    esp_err_t err = esp_websocket_client_start(s_ws);
    if (err == ESP_OK) {
        s_ws_started = true;
    } else {
        ESP_LOGW(TAG, "WS start failed: %s", esp_err_to_name(err));
    }
}

static void ws_stop_until_wifi_returns(void)
{
    if (!s_ws || !s_ws_started) return;
    ESP_LOGW(TAG, "Stopping WS until WiFi has IP");
    esp_err_t err = esp_websocket_client_stop(s_ws);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "WS stop failed: %s", esp_err_to_name(err));
    }
    s_ws_started = false;
    ws_reset_runtime_state();
}

static void ws_connect(const char *uri)
{
    esp_websocket_client_config_t cfg = {
        .uri                  = uri,
        .buffer_size          = 8192,
        // Retry quickly after a true disconnect, but do not declare a slow TTS
        // audio frame dead after only a few seconds. Railway/Cartesia/WiFi can
        // occasionally stall long enough to underrun playback while the socket is
        // still valid; a short read timeout turns that into a false reconnect.
        .reconnect_timeout_ms = 1000,
        .network_timeout_ms   = 20000,
        // Verify the server cert against the built-in CA bundle for wss://.
        // Ignored for plain ws:// URIs, so it's safe to always attach.
        .crt_bundle_attach    = esp_crt_bundle_attach,
        .enable_close_reconnect = true,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) {
        ESP_LOGE(TAG, "WS init failed");
        return;
    }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY,
                                  ws_event_handler, NULL);
    ws_start_if_wifi_ready();
}

// ─── Mode toggle ──────────────────────────────────────────────────────────

static void toggle_talk_mode(void)
{
    if (s_recording) {
        s_recording   = false;
        s_rec_samples = 0;
    }
    s_vad_in_speech    = false;
    s_silence_since_ms = 0;
    s_preroll_head     = 0;
    s_preroll_full     = false;

    s_talk_mode = !s_talk_mode;
    ESP_LOGI(TAG, "Talk mode -> %s", s_talk_mode ? "VAD" : "push-to-talk");

    led_color_t flash = s_talk_mode ? LEDC_CYAN : LEDC_GREEN;
    for (int i = 0; i < 3; i++) {
        led_set(flash);
        vTaskDelay(pdMS_TO_TICKS(120));
        led_set(LEDC_OFF);
        vTaskDelay(pdMS_TO_TICKS(80));
    }
}

// ─── Buttons ──────────────────────────────────────────────────────────────

static void buttons_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << TALK_BTN_GPIO) | (1ULL << POWER_BTN_GPIO),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);

    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) {
        ESP_LOGI(TAG, "Woke from deep sleep — waiting for power button release");
        while (gpio_get_level(POWER_BTN_GPIO) == (POWER_BTN_ACTIVE_LOW ? 0 : 1)) {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
}

static bool button_pressed(void)
{
    int level = gpio_get_level(TALK_BTN_GPIO);
    return TALK_BTN_ACTIVE_LOW ? level == 0 : level == 1;
}

static bool power_button_pressed(void)
{
    int level = gpio_get_level(POWER_BTN_GPIO);
    return POWER_BTN_ACTIVE_LOW ? level == 0 : level == 1;
}

static void enter_deep_sleep(void)
{
    ESP_LOGI(TAG, "Triple press — entering deep sleep");
    led_set(LEDC_RED);
    vTaskDelay(pdMS_TO_TICKS(250));
    led_set(LEDC_OFF);
    esp_sleep_enable_ext0_wakeup((gpio_num_t)POWER_BTN_GPIO, POWER_BTN_ACTIVE_LOW ? 0 : 1);
    esp_deep_sleep_start();
}

static void factory_reset(void)
{
    ESP_LOGI(TAG, "Factory reset — clearing WiFi config and rebooting");
    nvs_clear_wifi_config();
    for (int i = 0; i < 3; i++) {
        led_set(LEDC_CYAN);
        vTaskDelay(pdMS_TO_TICKS(150));
        led_set(LEDC_OFF);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    esp_restart();
}

static void handle_power_button(void)
{
    static uint32_t press_ts[3]      = {0, 0, 0};
    static bool     last             = false;
    static uint32_t last_change      = 0;
    static uint32_t held_since_ms    = 0;
    static bool     long_fired       = false;

    const uint32_t now = now_ms();
    const bool pressed = power_button_pressed();

    if (pressed != last && now - last_change > 35) {
        last_change = now;
        last        = pressed;
        if (pressed) {
            held_since_ms = now;
            long_fired    = false;
            press_ts[0]   = press_ts[1];
            press_ts[1]   = press_ts[2];
            press_ts[2]   = now;
            if (press_ts[0] != 0 &&
                now - press_ts[0] < POWER_BTN_TRIPLE_WINDOW_MS) {
                enter_deep_sleep();
            }
        } else {
            held_since_ms = 0;
        }
    }

    if (pressed && held_since_ms && !long_fired &&
        now - held_since_ms >= POWER_BTN_LONG_MS) {
        long_fired = true;
        toggle_talk_mode();
    }

    // 5-second hold: factory reset (clear WiFi config, reboot into BLE provisioning)
    if (pressed && held_since_ms && now - held_since_ms >= 5000) {
        factory_reset();
    }
}

// ─── Recording ────────────────────────────────────────────────────────────

static void start_recording(void)
{
    if (s_recording) return;
    s_rec_samples = 0;
    s_recording   = true;
    stream_begin();
    ESP_LOGI(TAG, "Recording...");
}

static void capture_chunk(void)
{
    if (!s_recording) return;
    esp_codec_dev_handle_t rec = get_record_handle();

    const size_t frames = MIC_SAMPLE_RATE * 20 / 1000;
    int16_t stereo[frames * MIC_CHANNELS];
    if (esp_codec_dev_read(rec, stereo, sizeof(stereo)) != 0) return;

    for (size_t i = 0; i < frames && s_rec_samples < s_rec_cap; i++) {
        int32_t mixed = ((int32_t)stereo[i * 2] + stereo[i * 2 + 1]) / 2;
        s_rec_buf[s_rec_samples++] = mic_gain((int16_t)mixed);
    }
    if (s_rec_samples >= s_rec_cap) {
        ESP_LOGW(TAG, "Recording buffer full");
        s_recording = false;
        if (s_streaming) { s_thinking_since_ms = now_ms(); s_stream_end = true; }
    }
}

static void stop_and_send(void)
{
    if (!s_recording) return;
    s_recording = false;

    int16_t peak = 0;
    for (size_t i = 0; i < s_rec_samples; i++) {
        int16_t a = s_rec_buf[i] < 0 ? -s_rec_buf[i] : s_rec_buf[i];
        if (a > peak) peak = a;
    }
    float dur = (float)s_rec_samples / MIC_SAMPLE_RATE;
    ESP_LOGI(TAG, "Recorded %.1fs, peak=%d", dur, peak);

    // Capture is done; the sender keeps reading s_rec_buf[s_tx_sent..s_rec_samples]
    // (frozen now that s_recording is false) until drained. Don't reset
    // s_rec_samples here — the next start_recording/onset does that, after the
    // half-duplex playback gate guarantees this stream has long since finished.
    if (peak < 50 || s_rec_samples < (size_t)(MIC_SAMPLE_RATE / 2)) {
        ESP_LOGW(TAG, "%s", peak < 50 ? "Mic silent — cancel" : "Too short — cancel");
        s_stream_cancel = true;   // sender drops buffered chunks
        return;
    }

    s_thinking_since_ms = now_ms();
    s_stream_end = true;          // sender flushes the tail + sends audio_end
}

// ─── VAD capture ──────────────────────────────────────────────────────────

static void vad_init(void)
{
    s_preroll_buf = heap_caps_malloc(VAD_PREROLL_FRAMES * sizeof(int16_t),
                                     MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_preroll_buf) s_preroll_buf = malloc(VAD_PREROLL_FRAMES * sizeof(int16_t));
    if (!s_preroll_buf) ESP_LOGE(TAG, "Cannot allocate VAD preroll buffer!");
}

static int16_t chunk_rms(const int16_t *buf, size_t n)
{
    if (n == 0) return 0;
    int64_t sum = 0;
    for (size_t i = 0; i < n; i++) sum += (int32_t)buf[i] * buf[i];
    return (int16_t)sqrt((double)sum / n);
}

static void vad_capture_chunk(void)
{
    esp_codec_dev_handle_t rec = get_record_handle();
    const size_t frames = MIC_SAMPLE_RATE * 20 / 1000;
    int16_t stereo[frames * MIC_CHANNELS];
    if (esp_codec_dev_read(rec, stereo, sizeof(stereo)) != 0) return;

    int16_t mono[frames];
    for (size_t i = 0; i < frames; i++) {
        int32_t mixed = ((int32_t)stereo[i * 2] + stereo[i * 2 + 1]) / 2;
        mono[i] = mic_gain((int16_t)mixed);
    }

    int16_t energy = chunk_rms(mono, frames);

    if (!s_vad_in_speech) {
        for (size_t i = 0; i < frames; i++) {
            s_preroll_buf[s_preroll_head] = mono[i];
            s_preroll_head = (s_preroll_head + 1) % VAD_PREROLL_FRAMES;
            if (s_preroll_head == 0) s_preroll_full = true;
        }

        bool playing_back = s_stream_active || (now_ms() - s_last_speaking_ms) < VAD_SUPPRESS_MS;
        // Don't open a new utterance until the previous one has finished
        // uploading (audio_start..audio_end), so the two streams can't interleave.
        if (energy >= VAD_SPEECH_THRESHOLD && !s_streaming) {
            if (playing_back) {
                s_drain_jbuf       = true;
                s_last_speaking_ms = 0;
                ESP_LOGI(TAG, "VAD: interrupt (rms=%d)", energy);
            } else {
                ESP_LOGI(TAG, "VAD: speech onset (rms=%d)", energy);
            }
            s_rec_samples      = 0;
            s_vad_in_speech    = true;
            s_silence_since_ms = 0;
            s_recording        = true;
            stream_begin();   // audio_start + arm the sender (s_rec_samples is 0 here)

            size_t preroll_count = s_preroll_full ? VAD_PREROLL_FRAMES : s_preroll_head;
            size_t from = s_preroll_full ? s_preroll_head : 0;
            for (size_t i = 0; i < preroll_count && s_rec_samples < s_rec_cap; i++) {
                s_rec_buf[s_rec_samples++] = s_preroll_buf[(from + i) % VAD_PREROLL_FRAMES];
            }
            for (size_t i = 0; i < frames && s_rec_samples < s_rec_cap; i++) {
                s_rec_buf[s_rec_samples++] = mono[i];
            }
        }
    } else {
        for (size_t i = 0; i < frames && s_rec_samples < s_rec_cap; i++) {
            s_rec_buf[s_rec_samples++] = mono[i];
        }

        if (s_rec_samples >= s_rec_cap) {
            ESP_LOGW(TAG, "VAD: buffer full, sending");
            s_vad_in_speech  = false;
            s_preroll_head   = 0;
            s_preroll_full   = false;
            stop_and_send();
            return;
        }

        // Keep the turn alive only while we still hear speech-level energy.
        // Anything below VAD_CONTINUE_THRESHOLD (room noise, trailing breath)
        // counts toward silence, so the mic releases ~VAD_SILENCE_MS after the
        // child actually stops talking instead of being held open by ambient noise.
        // Diagnostic: surface the live RMS once a second while in speech, so a
        // turn that won't end reveals whether the noise floor sits above
        // VAD_CONTINUE_THRESHOLD (e.g. WiFi-TX coupling) vs. real continuous sound.
        static uint32_t s_last_rms_log_ms = 0;
        if (now_ms() - s_last_rms_log_ms >= 1000) {
            s_last_rms_log_ms = now_ms();
            ESP_LOGI(TAG, "VAD: in-speech rms=%d (continue>=%d)", energy, VAD_CONTINUE_THRESHOLD);
        }

        if (energy >= VAD_CONTINUE_THRESHOLD) {
            s_silence_since_ms = 0;
        } else if (s_silence_since_ms == 0) {
            s_silence_since_ms = now_ms();
        } else if (now_ms() - s_silence_since_ms >= VAD_SILENCE_MS) {
            ESP_LOGI(TAG, "VAD: end of speech (rms=%d)", energy);
            s_vad_in_speech  = false;
            s_preroll_head   = 0;
            s_preroll_full   = false;
            stop_and_send();
        }
    }
}

// ─── app_main ─────────────────────────────────────────────────────────────

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
        err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    led_init();

    // After deep sleep the chip wakes with only PARTIAL RF calibration to save
    // wake time. With a marginal stored calibration that yields a weak/noisy
    // link → retransmissions → high latency and stuttering audio, until a full
    // power cycle / factory-reset reboot recalibrates. Erase the stored cal data
    // on a deep-sleep wake so esp_wifi_init() below does a FULL recalibration,
    // making the wake path behave like a clean cold boot.
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) {
        ESP_LOGI(TAG, "Deep-sleep wake — forcing full RF recalibration");
        esp_phy_erase_cal_data_in_nvs();
    }

    extern void init_board(void);
    init_board();

    open_record();
    esp_codec_dev_set_in_gain(get_record_handle(), MIC_GAIN_DB);
    open_playback();

    s_rec_cap = (size_t)(MIC_SAMPLE_RATE * MAX_RECORD_SECONDS);
    s_rec_buf = heap_caps_malloc(s_rec_cap * sizeof(int16_t),
                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_rec_buf) s_rec_buf = malloc(s_rec_cap * sizeof(int16_t));
    if (!s_rec_buf) { ESP_LOGE(TAG, "Cannot allocate recording buffer!"); return; }

    s_ws_buf = heap_caps_malloc(WS_REASSEMBLY_SIZE + 1,
                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_ws_buf) s_ws_buf = malloc(WS_REASSEMBLY_SIZE + 1);
    if (!s_ws_buf) { ESP_LOGE(TAG, "Cannot allocate WS buffer!"); return; }

    s_jbuf = heap_caps_malloc(JITTER_BUF_SAMPLES * sizeof(int16_t),
                               MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_jbuf) s_jbuf = malloc(JITTER_BUF_SAMPLES * sizeof(int16_t));
    if (!s_jbuf) { ESP_LOGE(TAG, "Cannot allocate jitter buffer!"); return; }

    s_pcm_decode_buf = heap_caps_malloc(PCM_DECODE_BUF_SIZE,
                                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_pcm_decode_buf) s_pcm_decode_buf = malloc(PCM_DECODE_BUF_SIZE);
    if (!s_pcm_decode_buf) { ESP_LOGE(TAG, "Cannot allocate PCM decode buffer!"); return; }

    buttons_init();
    xTaskCreate(led_task, "led", 2048, NULL, 3, NULL);
    xTaskCreatePinnedToCore(playback_task, "playback", 4096, NULL, 18, NULL, 1);
    // Pinned to CPU0 (same core as the capture loop) so the producer/consumer
    // index ordering on s_rec_buf holds without explicit memory barriers.
    xTaskCreatePinnedToCore(audio_sender_task, "audio_tx", 4096, NULL, 6, NULL, 0);
    // PCM intake queue + feeder task: decouples WS event handler from the
    // blocking jitter-buffer write so WS reception is never stalled.
    s_pcm_queue = xQueueCreate(PCM_QUEUE_LEN, sizeof(pcm_block_t));
    xTaskCreatePinnedToCore(pcm_feeder_task, "pcm_feed", 4096, NULL, 10, NULL, 1);

    wifi_driver_init();

    char wifi_ssid[33]  = WIFI_SSID;
    char wifi_pass[65]  = WIFI_PASSWORD;
    char srv_host[128]  = SERVER_HOST;
    uint16_t srv_port   = SERVER_PORT;

    bool nvs_ok = nvs_load_wifi_config(wifi_ssid, wifi_pass, srv_host, &srv_port);

    if (!nvs_ok && strlen(WIFI_SSID) == 0) {
        ble_prov_init();
        while (1) {
            ESP_LOGI(TAG, "No WiFi config — waiting for BLE provisioning");
            s_ble_provisioning = true;
            xEventGroupClearBits(ble_prov_event_group(), BLE_PROV_DONE_BIT);
            xEventGroupWaitBits(ble_prov_event_group(), BLE_PROV_DONE_BIT,
                                pdFALSE, pdTRUE, portMAX_DELAY);
            nvs_load_wifi_config(wifi_ssid, wifi_pass, srv_host, &srv_port);
            s_ble_provisioning = false;

            if (wifi_connect(wifi_ssid, wifi_pass)) {
                // Reboot so next boot skips BLE entirely — frees ~60KB internal RAM
                ESP_LOGI(TAG, "Provisioning complete — rebooting cleanly");
                ble_prov_notify_wifi_status("connected", "");
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_restart();
            }
            ESP_LOGW(TAG, "WiFi failed — clearing config, re-entering provisioning");
            ble_prov_notify_wifi_status("failed", "");
            nvs_clear_wifi_config();
        }
    } else {
        // Talk to the child right away ("Einen Moment, ich wache auf.") so the
        // ~1–4 s connect/warm-up after a deep-sleep wake feels intentional, not
        // broken. Non-blocking: it plays over the speaker while we connect below.
        play_clip(clip_waking_start, clip_waking_end);
        bool wifi_ok = false;
        for (int attempt = 1; attempt <= 3 && !wifi_ok; attempt++) {
            wifi_ok = wifi_connect(wifi_ssid, wifi_pass);
            if (!wifi_ok && attempt < 3) {
                ESP_LOGW(TAG, "WiFi connect failed (%d/3) — retrying before provisioning reset", attempt);
                vTaskDelay(pdMS_TO_TICKS(3000));
            }
        }
        if (!wifi_ok) {
            if (nvs_ok && strlen(WIFI_SSID) == 0) {
                ESP_LOGW(TAG, "Saved WiFi config failed — clearing it and restarting provisioning");
                nvs_clear_wifi_config();
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_restart();
            }
            while (!wifi_ok) {
                ESP_LOGW(TAG, "Built-in WiFi config failed — retrying");
                vTaskDelay(pdMS_TO_TICKS(5000));
                wifi_ok = wifi_connect(wifi_ssid, wifi_pass);
            }
        }
    }

    strncpy(s_srv_host, srv_host, sizeof(s_srv_host) - 1);
    s_srv_port = srv_port;

    ESP_LOGI(TAG, "Server config: host=%s port=%d", s_srv_host, s_srv_port);
    char ws_uri[192];
    snprintf(ws_uri, sizeof(ws_uri), "%s://%s:%d/ws",
             s_srv_port == 443 ? "wss" : "ws", s_srv_host, s_srv_port);
    ESP_LOGI(TAG, "Connecting WS: %s", ws_uri);
    ws_connect(ws_uri);

    vad_init();
    ESP_LOGI(TAG, "Ready — mode=%s (long-press power to toggle)",
             s_talk_mode ? "VAD" : "push-to-talk");

    bool last_pressed = false;
    bool prev_ws_connected   = false;
    uint32_t rssi_ok_since   = 0;
    uint32_t ws_conn_since   = 0;

    while (1) {
        handle_power_button();

        if (!s_wifi_has_ip) {
            ws_stop_until_wifi_returns();
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        ws_start_if_wifi_ready();

        // Send per-device config once after each (re)connect so the server can
        // run binary-audio turns with the right model/voice/device_id.
        if (s_ws_connected && !s_config_sent) {
            send_config();
            s_config_sent = true;
        }

        // ─── Warm-up gate ───────────────────────────────────────────────────
        // The toy stays "not ready" (mic/button ignored) until the link is
        // solid, so the child can't talk into the marginal radio right after a
        // deep-sleep wake — the root cause of the dropped-connection + stutter.
        // Track WS connection edges to drive spoken feedback.
        if (s_ws_connected && !prev_ws_connected) {
            ws_conn_since = now_ms();
            rssi_ok_since = 0;
        } else if (!s_ws_connected && prev_ws_connected && s_app_ready) {
            // Lost the link mid-session → pause turns and reassure the child.
            ESP_LOGW(TAG, "Link lost — pausing until reconnect");
            play_clip(clip_reconnect_start, clip_reconnect_end);
            s_app_ready = false;
        }
        prev_ws_connected = s_ws_connected;

        if (!s_app_ready) {
            if (s_ws_connected && s_config_sent) {
                int rssi = 0;
                bool rssi_solid = (esp_wifi_sta_get_rssi(&rssi) == ESP_OK &&
                                   rssi >= WIFI_READY_RSSI_DBM);
                if (rssi_solid) {
                    if (rssi_ok_since == 0) rssi_ok_since = now_ms();
                } else {
                    rssi_ok_since = 0;
                }
                bool settled = rssi_ok_since && now_ms() - rssi_ok_since >= WIFI_READY_SETTLE_MS;
                bool capped  = now_ms() - ws_conn_since >= WIFI_READY_MAX_WAIT_MS;
                if (settled || capped) {
                    ESP_LOGI(TAG, "Warm-up done (rssi=%d settled=%d capped=%d) — ready",
                             rssi, settled, capped);
                    play_clip(clip_ready_start, clip_ready_end);
                    s_app_ready = true;
                }
            }
            if (!s_app_ready) {
                vTaskDelay(pdMS_TO_TICKS(50));  // stay responsive to the power button
                continue;
            }
        }

        if (BATTERY_REPORT_ENABLED && s_ws_connected &&
            (s_last_batt_ms == 0 || now_ms() - s_last_batt_ms >= BATTERY_REPORT_MS)) {
            send_battery();
            s_last_batt_ms = now_ms();
        }

        // Half-duplex: while Buddly is speaking (plus a short echo-tail), do not
        // touch the microphone. The mic and speaker share one I2S codec, so
        // reading the mic during playback both starves the speaker (stuttering)
        // and feeds the speaker's own output back in as "speech" (echo loop, no
        // AEC on this board). Buttons stay responsive; capture resumes once
        // playback ends.
        bool playing_back = s_stream_active ||
                            (now_ms() - s_last_speaking_ms) < VAD_SUPPRESS_MS;
        if (playing_back) {
            if (s_recording)   { s_recording = false; s_rec_samples = 0; }
            if (s_streaming)   s_stream_cancel = true;  // abort any in-progress upload
            s_vad_in_speech    = false;
            s_silence_since_ms = 0;
            last_pressed       = false;
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        if (s_talk_mode == 1) {
            vad_capture_chunk();
        } else {
            bool pressed = button_pressed();
            if (pressed && !last_pressed)                     start_recording();
            else if (!pressed && last_pressed && s_recording) stop_and_send();
            last_pressed = pressed;
            if (s_recording) capture_chunk();
        }

        vTaskDelay(pdMS_TO_TICKS(s_recording ? 0 : 10));
    }
}
