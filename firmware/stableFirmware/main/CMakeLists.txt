idf_component_register(
    SRCS "main.c" "board.c" "nvs_config.c"
    INCLUDE_DIRS "."
    REQUIRES
        codec_board
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
)
