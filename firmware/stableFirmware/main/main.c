#include <string.h>
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_http_client.h"
#include "esp_websocket_client.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "driver/gpio.h"
#include "esp_codec_dev.h"
#include "codec_init.h"
#include "mbedtls/base64.h"
#include "cJSON.h"
#include "settings.h"
#include "nvs_config.h"

static const char *TAG = "buddly";

// ─── State ───────────────────────────────────────────────────────────────────

static EventGroupHandle_t s_wifi_eg;
#define WIFI_CONNECTED_BIT BIT0

static esp_websocket_client_handle_t s_ws = NULL;
static bool s_ws_connected = false;
static bool s_recording    = false;
static int16_t *s_rec_buf  = NULL;
static size_t   s_rec_samples = 0;
static size_t   s_rec_cap     = 0;

#define WS_REASSEMBLY_SIZE (64 * 1024)
static char    *s_ws_buf     = NULL;
static size_t   s_ws_buf_len = 0;

static volatile uint32_t s_thinking_since_ms = 0;
static volatile uint32_t s_last_speaking_ms  = 0;
static volatile uint32_t s_error_until_ms    = 0;
static volatile bool     s_drain_jbuf        = false;
static volatile bool     s_stream_active     = false;  // true between first audio_chunk and done

static int      s_talk_mode        = TALK_MODE_DEFAULT;  // 0=push-to-talk, 1=VAD

// Jitter buffer: WS event task writes here; playback_task drains at constant rate.
// Cartesia generates audio faster than real-time; 8 s prevents overflow for typical
// responses (a 5 s reply may arrive in 2-3 s of wall time from Cartesia).
#define JITTER_BUF_SAMPLES  (MIC_SAMPLE_RATE * 8)  // 8 s headroom
#define JITTER_PREBUF_MS    50                       // pre-buffer before starting playback
static int16_t       *s_jbuf    = NULL;
static volatile size_t s_jbuf_wr = 0;               // written by WS task
static volatile size_t s_jbuf_rd = 0;               // read   by playback_task

// Pre-allocated decode buffer for audio_chunk path — avoids malloc on every chunk.
#define PCM_DECODE_BUF_SIZE (MIC_SAMPLE_RATE * 4)   // 4s max per chunk (ample)
static uint8_t *s_pcm_decode_buf = NULL;

#define VAD_PREROLL_FRAMES ((size_t)(MIC_SAMPLE_RATE * VAD_PREROLL_MS / 1000))
static int16_t *s_preroll_buf      = NULL;
static size_t   s_preroll_head     = 0;
static bool     s_preroll_full     = false;
static bool     s_vad_in_speech    = false;
static uint32_t s_silence_since_ms = 0;

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
    led_set(LEDC_RED);  // boot indicator
}

static void led_task(void *arg)
{
    while (1) {
        uint32_t now = now_ms();

        if (s_error_until_ms && now < s_error_until_ms) {
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
            // Idle: short green pulse every 2 s.
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
    xEventGroupSetBits(s_wifi_eg, WIFI_CONNECTED_BIT);
}

static void on_wifi_disconnect(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ESP_LOGW(TAG, "WiFi disconnected, retrying...");
    s_ws_connected = false;
    esp_wifi_connect();
}

static void wifi_connect(const char *ssid, const char *pass)
{
    s_wifi_eg = xEventGroupCreate();
    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_wifi_init(&cfg);

    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                        on_wifi_got_ip, NULL, NULL);
    esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                        on_wifi_disconnect, NULL, NULL);

    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_start();

    wifi_config_t wc = { .sta = { .threshold.authmode = WIFI_AUTH_WPA2_PSK } };
    strncpy((char *)wc.sta.ssid,     ssid, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, pass, sizeof(wc.sta.password) - 1);
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    esp_wifi_connect();

    ESP_LOGI(TAG, "Waiting for WiFi (%s)...", ssid);
    xEventGroupWaitBits(s_wifi_eg, WIFI_CONNECTED_BIT,
                        pdFALSE, pdTRUE, portMAX_DELAY);
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
    // Flush DMA with silence to suppress startup pop
    size_t frames = SPK_SAMPLE_RATE * 100 / 1000;
    int16_t *sil = calloc(frames * SPK_CHANNELS, sizeof(int16_t));
    if (sil) {
        esp_codec_dev_write(play, sil, frames * SPK_CHANNELS * sizeof(int16_t));
        free(sil);
    }
}

// Software gain applied to every captured sample (both push-to-talk and VAD).
// Saturates at int16 limits so it never wraps.
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
    for (size_t i = 0; i < n; i++) {
        size_t next = (s_jbuf_wr + 1) % JITTER_BUF_SAMPLES;
        if (next == s_jbuf_rd) break;  // buffer full — drop tail
        s_jbuf[s_jbuf_wr] = mono[i];
        // Memory barrier: ensure sample is written before index advances
        // (matters on dual-core ESP32-S3 where playback_task runs on PRO cpu).
        __asm__ volatile("memw" ::: "memory");
        s_jbuf_wr = next;
    }
}

// Dedicated DMA feeder. Runs at high priority so WiFi task preemptions don't
// starve the I2S DMA. Uses 30 ms write chunks — larger than 10 ms so that even
// a 20 ms WiFi preemption doesn't drain the hardware DMA buffer between writes.
//
// Ring-buffer protocol (single-producer / single-consumer, dual-core safe):
//   play_pcm16_mono  writes s_jbuf_wr  (APP cpu, WS event task)
//   playback_task    writes s_jbuf_rd  (PRO cpu, this task)
//   Both use memw barriers so index advances are visible only after data.
static void playback_task(void *arg)
{
    const size_t CHUNK  = MIC_SAMPLE_RATE * 30 / 1000;   // 480 samples = 30 ms
    const size_t PREBUF = (size_t)(MIC_SAMPLE_RATE * JITTER_PREBUF_MS / 1000);
    bool primed  = false;
    bool playing = false;
    esp_codec_dev_handle_t play = get_playback_handle();
    int16_t stereo[MIC_SAMPLE_RATE * 30 / 1000 * 2];

    while (1) {
        if (s_drain_jbuf) {
            __asm__ volatile("memw" ::: "memory");
            s_jbuf_rd    = s_jbuf_wr;
            playing      = false;
            s_drain_jbuf = false;
            __asm__ volatile("memw" ::: "memory");
        }

        size_t wr    = s_jbuf_wr;
        __asm__ volatile("memw" ::: "memory");
        size_t rd    = s_jbuf_rd;
        size_t avail = (wr >= rd) ? (wr - rd) : (JITTER_BUF_SAMPLES - rd + wr);

        if (!playing && avail >= (primed ? 1u : PREBUF)) {
            playing = true;
            primed  = true;
        }

        // Don't stop while the server is still streaming — bridge gaps with silence.
        // Only stop when the buffer is empty AND the stream is over.
        if (playing && avail == 0 && !s_stream_active) {
            playing = false;
        }

        if (playing) {
            size_t n = avail < CHUNK ? avail : CHUNK;
            for (size_t i = 0; i < n; i++) {
                int16_t s = s_jbuf[s_jbuf_rd];
                __asm__ volatile("memw" ::: "memory");
                s_jbuf_rd = (s_jbuf_rd + 1) % JITTER_BUF_SAMPLES;
                stereo[i * 2]     = s;
                stereo[i * 2 + 1] = s;
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

static void make_wav_header(uint8_t *h, uint32_t pcm_bytes)
{
    uint32_t file_size  = 36 + pcm_bytes;
    uint32_t byte_rate  = MIC_SAMPLE_RATE * 1 * MIC_BITS / 8;
    uint16_t block_align = 1 * MIC_BITS / 8;
    uint16_t pcm_fmt = 1, channels = 1, bits = MIC_BITS;
    uint32_t sr = MIC_SAMPLE_RATE, chunk16 = 16;

    memcpy(h,      "RIFF", 4); memcpy(h+4,  &file_size,   4);
    memcpy(h+8,   "WAVE", 4); memcpy(h+12, "fmt ", 4);
    memcpy(h+16,  &chunk16,   4); memcpy(h+20, &pcm_fmt,    2);
    memcpy(h+22,  &channels,  2); memcpy(h+24, &sr,         4);
    memcpy(h+28,  &byte_rate, 4); memcpy(h+32, &block_align,2);
    memcpy(h+34,  &bits,      2); memcpy(h+36, "data",      4);
    memcpy(h+40,  &pcm_bytes, 4);
}

// ─── STT HTTP POST ────────────────────────────────────────────────────────

typedef struct { char buf[2048]; int len; } http_resp_ctx_t;

static esp_err_t stt_http_event(esp_http_client_event_t *evt)
{
    http_resp_ctx_t *ctx = (http_resp_ctx_t *)evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_DATA && ctx) {
        int space = (int)sizeof(ctx->buf) - ctx->len - 1;
        int take  = evt->data_len < space ? evt->data_len : space;
        memcpy(ctx->buf + ctx->len, evt->data, take);
        ctx->len += take;
    }
    return ESP_OK;
}

static char *post_wav_get_text(const int16_t *pcm, size_t samples)
{
    size_t pcm_bytes = samples * sizeof(int16_t);
    size_t body_len  = 44 + pcm_bytes;

    uint8_t *body = heap_caps_malloc(body_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!body) body = malloc(body_len);
    if (!body) {
        ESP_LOGE(TAG, "OOM for WAV body (%u bytes)", (unsigned)body_len);
        return NULL;
    }
    make_wav_header(body, pcm_bytes);
    memcpy(body + 44, pcm, pcm_bytes);

    char url[128];
    snprintf(url, sizeof(url), "http://%s:%d%s", SERVER_HOST, SERVER_PORT, STT_PATH);

    http_resp_ctx_t ctx = {0};
    esp_http_client_config_t cfg = {
        .url            = url,
        .method         = HTTP_METHOD_POST,
        .timeout_ms     = 30000,
        .buffer_size    = 2048,
        .buffer_size_tx = 4096,
        .event_handler  = stt_http_event,
        .user_data      = &ctx,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "audio/wav");
    esp_http_client_set_post_field(client, (const char *)body, body_len);

    esp_err_t err = esp_http_client_perform(client);
    free(body);
    esp_http_client_cleanup(client);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "STT HTTP error: %s", esp_err_to_name(err));
        return NULL;
    }
    ctx.buf[ctx.len] = '\0';
    ESP_LOGI(TAG, "STT response: %.200s", ctx.buf);

    cJSON *root = cJSON_Parse(ctx.buf);
    if (!root) { ESP_LOGE(TAG, "STT JSON parse failed"); return NULL; }
    cJSON *text_item = cJSON_GetObjectItem(root, "text");
    char *text = NULL;
    if (cJSON_IsString(text_item) && text_item->valuestring[0])
        text = strdup(text_item->valuestring);
    cJSON_Delete(root);
    return text;
}

// ─── WebSocket ───────────────────────────────────────────────────────────

static void send_user_text(const char *text)
{
    if (!s_ws_connected || !s_ws) return;

    char *msg = NULL;
    asprintf(&msg,
        "{\"type\":\"user_text\",\"text\":\"%s\","
        "\"reasoning\":\"%s\",\"model\":\"%s\","
        "\"tts\":true,\"ttsProvider\":\"%s\","
        "\"device_id\":\"buddly-01\"}",
        text, BUDDLY_REASONING, BUDDLY_MODEL, BUDDLY_TTS_PROVIDER);
    if (!msg) return;

    ESP_LOGI(TAG, "→ WS: %s", msg);
    esp_websocket_client_send_text(s_ws, msg, strlen(msg), pdMS_TO_TICKS(3000));
    s_thinking_since_ms = now_ms();
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
                    (const unsigned char *)b64, b64_len) == 0 && actual > 0)
                    play_pcm16_mono(s_pcm_decode_buf, actual);
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
            break;
        case WEBSOCKET_EVENT_DATA:
            if (ev->op_code == 0x8) break;
            if (ev->payload_offset == 0) s_ws_buf_len = 0;
            if (s_ws_buf && s_ws_buf_len + ev->data_len < WS_REASSEMBLY_SIZE) {
                memcpy(s_ws_buf + s_ws_buf_len, ev->data_ptr, ev->data_len);
                s_ws_buf_len += ev->data_len;
            }
            if (s_ws_buf_len >= (size_t)ev->payload_len && ev->payload_len > 0) {
                s_ws_buf[s_ws_buf_len] = '\0';
                handle_ws_message(s_ws_buf, s_ws_buf_len);
                s_ws_buf_len = 0;
            }
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGE(TAG, "WS error");
            break;
        default: break;
    }
}

static void ws_connect(const char *uri)
{
    esp_websocket_client_config_t cfg = {
        .uri                  = uri,
        .buffer_size          = 4096,
        .reconnect_timeout_ms = 10000,
        .network_timeout_ms   = 10000,
    };
    s_ws = esp_websocket_client_init(&cfg);
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY,
                                  ws_event_handler, NULL);
    esp_websocket_client_start(s_ws);
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
    ESP_LOGI(TAG, "Talk mode → %s", s_talk_mode ? "VAD" : "push-to-talk");

    // Flash LED: cyan = VAD, green = push-to-talk
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

    // Long press: toggle talk mode (fires once per hold)
    if (pressed && held_since_ms && !long_fired &&
        now - held_since_ms >= POWER_BTN_LONG_MS) {
        long_fired = true;
        toggle_talk_mode();
    }
}

// ─── Recording ────────────────────────────────────────────────────────────

static void start_recording(void)
{
    if (s_recording) return;
    s_rec_samples = 0;
    s_recording   = true;
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

    if (peak < 50) { ESP_LOGW(TAG, "Mic silent"); return; }
    if (s_rec_samples < (size_t)(MIC_SAMPLE_RATE / 2)) { ESP_LOGW(TAG, "Too short"); return; }

    char *text = post_wav_get_text(s_rec_buf, s_rec_samples);
    s_rec_samples = 0;
    if (!text) return;
    ESP_LOGI(TAG, "STT: \"%s\"", text);
    if (strlen(text) > 0) send_user_text(text);
    free(text);
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
        // Maintain rolling preroll ring buffer
        for (size_t i = 0; i < frames; i++) {
            s_preroll_buf[s_preroll_head] = mono[i];
            s_preroll_head = (s_preroll_head + 1) % VAD_PREROLL_FRAMES;
            if (s_preroll_head == 0) s_preroll_full = true;
        }

        bool playing_back = s_stream_active || (now_ms() - s_last_speaking_ms) < VAD_SUPPRESS_MS;
        if (energy >= VAD_SPEECH_THRESHOLD) {
            if (playing_back) {
                // Interrupt: user is speaking — drain audio and start fresh recording.
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

            // Flush preroll into recording buffer
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
        // In speech: append chunk
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

        if (energy < VAD_SILENCE_THRESHOLD) {
            if (s_silence_since_ms == 0) {
                s_silence_since_ms = now_ms();
            } else if (now_ms() - s_silence_since_ms >= VAD_SILENCE_MS) {
                ESP_LOGI(TAG, "VAD: end of speech (rms=%d)", energy);
                s_vad_in_speech  = false;
                s_preroll_head   = 0;
                s_preroll_full   = false;
                stop_and_send();
            }
        } else {
            s_silence_since_ms = 0;
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
    // Pin playback to APP_CPU (core 1) so WiFi on PRO_CPU (core 0) cannot preempt it.
    xTaskCreatePinnedToCore(playback_task, "playback", 4096, NULL, 18, NULL, 1);

    wifi_connect(WIFI_SSID, WIFI_PASSWORD);

    char ws_uri[192];
    snprintf(ws_uri, sizeof(ws_uri), "ws://%s:%d/ws", SERVER_HOST, SERVER_PORT);
    ws_connect(ws_uri);

    vad_init();
    ESP_LOGI(TAG, "Ready — mode=%s (long-press power to toggle)",
             s_talk_mode ? "VAD" : "push-to-talk");

    bool last_pressed = false;

    while (1) {
        handle_power_button();

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
