#include "codec_init.h"
#include "codec_board.h"
#include "esp_codec_dev.h"
#include "settings.h"
#include "esp_log.h"

static const char *TAG = "board";

void init_board(void)
{
    ESP_LOGI(TAG, "Init codec board: %s", BOARD_NAME);
    set_codec_board_type(BOARD_NAME);
    codec_init_cfg_t cfg = {
        .in_mode     = CODEC_I2S_MODE_TDM,
        .in_use_tdm  = true,
        .reuse_dev   = false,
    };
    int ret = init_codec(&cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "init_codec failed: %d", ret);
        return;
    }
    esp_codec_dev_set_out_vol(get_playback_handle(), DEFAULT_VOLUME);
    ESP_LOGI(TAG, "Codec board ready");
}
