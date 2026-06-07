#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_codec_dev.h"
#include "codec_init.h"
#include "esp_afe_sr_models.h"
#include "model_path.h"
#include "settings.h"
#include "afe_frontend.h"

static const char *TAG = "afe";

static esp_afe_sr_iface_t *s_afe       = NULL;
static esp_afe_sr_data_t  *s_afe_data  = NULL;
static int   s_feed_chunk  = 0;   // samples PER CHANNEL the AFE wants per feed()
static int   s_feed_nch    = 0;   // channels the AFE expects (== MIC_TDM_CHANNELS)
static bool  s_ready       = false;

// Echo-cancelled mono output is produced by the fetch task at realtime and parked
// in this ring until the capture loop consumes it. The ring OVERWRITES the oldest
// samples when full: between turns (push-to-talk idle, warm-up) nobody reads it, so
// it must not block the fetch task — it just keeps the most recent ~300 ms. In VAD
// mode the capture loop reads continuously, so the ring stays near-empty and adds
// no meaningful latency.
#define AFE_RING_SAMPLES (MIC_SAMPLE_RATE * 300 / 1000)   // ~300 ms cleaned audio
static int16_t          *s_ring   = NULL;
static int               s_rhead  = 0;   // write index
static int               s_rtail  = 0;   // read index
static int               s_rcount = 0;   // valid samples in the ring
static SemaphoreHandle_t s_ring_mtx = NULL;

static void ring_write(const int16_t *src, int len)
{
    xSemaphoreTake(s_ring_mtx, portMAX_DELAY);
    for (int i = 0; i < len; i++) {
        s_ring[s_rhead] = src[i];
        s_rhead = (s_rhead + 1) % AFE_RING_SAMPLES;
        if (s_rcount == AFE_RING_SAMPLES) s_rtail = (s_rtail + 1) % AFE_RING_SAMPLES; // drop oldest
        else s_rcount++;
    }
    xSemaphoreGive(s_ring_mtx);
}

static bool ring_read(int16_t *dst, int n)
{
    bool ok = false;
    xSemaphoreTake(s_ring_mtx, portMAX_DELAY);
    if (s_rcount >= n) {
        for (int i = 0; i < n; i++) {
            dst[i] = s_ring[s_rtail];
            s_rtail = (s_rtail + 1) % AFE_RING_SAMPLES;
            s_rcount--;
        }
        ok = true;
    }
    xSemaphoreGive(s_ring_mtx);
    return ok;
}

// Continuously read the 4-slot TDM mic+reference and feed it to the AFE. Blocks at
// realtime on the I2S RX DMA. The feed buffer is the raw interleaved codec data;
// BUDDLY_AFE_INPUT_FORMAT tells the AFE which slot is the reference vs the mics, so
// no re-interleaving is needed here. Pinned to CPU0 (with the WS/upload tasks);
// realtime playback stays protected on CPU1.
static void afe_feed_task(void *arg)
{
    esp_codec_dev_handle_t rec = get_record_handle();
    const int n = s_feed_chunk * s_feed_nch;             // interleaved samples
    int16_t *buf = heap_caps_malloc(n * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) buf = malloc(n * sizeof(int16_t));
    if (!buf) { ESP_LOGE(TAG, "feed buffer alloc failed"); vTaskDelete(NULL); return; }

    while (1) {
        if (esp_codec_dev_read(rec, buf, n * sizeof(int16_t)) == 0) {
            s_afe->feed(s_afe_data, buf);
        } else {
            vTaskDelay(1);
        }
    }
}

// Pull echo-cancelled mono frames out of the AFE (blocks until one is ready) and
// stage them in the ring. Decoupled from the capture loop so the AFE is drained
// even when the main loop is busy/blocked elsewhere.
static void afe_fetch_task(void *arg)
{
    while (1) {
        afe_fetch_result_t *res = s_afe->fetch(s_afe_data);
        if (!res || res->ret_value == ESP_FAIL) { vTaskDelay(1); continue; }
        int got = res->data_size / (int)sizeof(int16_t);   // mono samples this block
        if (got > 0) ring_write((const int16_t *)res->data, got);
    }
}

bool afe_frontend_init(void)
{
    // No neural models are needed: AFE_TYPE_VC with WebRTC AEC/NS/VAD is purely
    // algorithmic. esp_srmodel_init still works against an empty `model` partition.
    srmodel_list_t *models = esp_srmodel_init("model");

    afe_config_t *cfg = afe_config_init(BUDDLY_AFE_INPUT_FORMAT, models,
                                        AFE_TYPE_VC, AFE_MODE_LOW_COST);
    if (!cfg) { ESP_LOGE(TAG, "afe_config_init failed"); return false; }

    s_afe = esp_afe_handle_from_config(cfg);
    if (!s_afe) { ESP_LOGE(TAG, "esp_afe_handle_from_config failed"); afe_config_free(cfg); return false; }

    s_afe_data = s_afe->create_from_config(cfg);
    if (!s_afe_data) { ESP_LOGE(TAG, "afe create_from_config failed"); afe_config_free(cfg); return false; }

    s_feed_chunk = s_afe->get_feed_chunksize(s_afe_data);
    s_feed_nch   = s_afe->get_feed_channel_num(s_afe_data);
    int fetch_chunk = s_afe->get_fetch_chunksize(s_afe_data);
    afe_config_free(cfg);

    ESP_LOGI(TAG, "AFE ready: format=%s feed_chunk=%d feed_nch=%d fetch_chunk=%d",
             BUDDLY_AFE_INPUT_FORMAT, s_feed_chunk, s_feed_nch, fetch_chunk);
    if (s_feed_nch != MIC_TDM_CHANNELS) {
        ESP_LOGW(TAG, "AFE wants %d feed channels but record opened as %d — fix MIC_TDM_CHANNELS/input format",
                 s_feed_nch, MIC_TDM_CHANNELS);
    }

    s_ring = heap_caps_malloc(AFE_RING_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_ring) s_ring = malloc(AFE_RING_SAMPLES * sizeof(int16_t));
    s_ring_mtx = xSemaphoreCreateMutex();
    if (!s_ring || !s_ring_mtx) { ESP_LOGE(TAG, "ring alloc failed"); return false; }

    s_ready = true;
    xTaskCreatePinnedToCore(afe_feed_task,  "afe_feed",  4096, NULL, 6, NULL, 0);
    xTaskCreatePinnedToCore(afe_fetch_task, "afe_fetch", 4096, NULL, 6, NULL, 0);
    return true;
}

bool afe_frontend_read_frame(int16_t *out, int n_samples)
{
    if (!s_ready || n_samples <= 0 || n_samples > AFE_RING_SAMPLES) return false;
    // Wait (at realtime, ~one frame) for the fetch task to stage enough audio.
    while (!ring_read(out, n_samples)) vTaskDelay(pdMS_TO_TICKS(2));
    return true;
}
