idf_component_register(
    SRCS "main.c" "board.c" "nvs_config.c" "ble_prov.c" "afe_frontend.c"
    INCLUDE_DIRS "."
    # Spoken status clips (16 kHz mono s16le raw PCM) baked into the binary so the
    # toy can talk to the child while the link is still coming up. Regenerate with
    # server/scripts/gen_feedback_clips.mjs. Symbol names: clip_ready.pcm ->
    # _binary_clip_ready_pcm_start / _end (see externs in main.c).
    EMBED_FILES
        "audio/clip_waking.pcm"
        "audio/clip_ready.pcm"
        "audio/clip_reconnect.pcm"
    REQUIRES
        codec_board
        libfvad
        esp-sr
        esp_wifi
        esp_event
        esp_netif
        nvs_flash
        esp_http_client
        esp_websocket_client
        esp_adc
        mbedtls
        json
        log
        bt
        efuse
)
