#include "nvs_config.h"
#include "nvs.h"

#define NS "buddly"

bool nvs_load_wifi_config(char *ssid, char *pass, char *srv_host, uint16_t *srv_port)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;

    size_t ssid_sz = 33, pass_sz = 65, host_sz = 128;
    bool ok =
        nvs_get_str(h, "wifi_ssid", ssid,     &ssid_sz) == ESP_OK &&
        nvs_get_str(h, "wifi_pass", pass,     &pass_sz) == ESP_OK &&
        nvs_get_str(h, "srv_host",  srv_host, &host_sz) == ESP_OK;

    uint16_t port = 3001;
    nvs_get_u16(h, "srv_port", &port);
    *srv_port = port;

    nvs_close(h);
    return ok && ssid[0] != '\0';
}

bool nvs_save_wifi_config(const char *ssid, const char *pass,
                          const char *srv_host, uint16_t srv_port)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;

    bool ok =
        nvs_set_str(h, "wifi_ssid", ssid)     == ESP_OK &&
        nvs_set_str(h, "wifi_pass", pass)     == ESP_OK &&
        nvs_set_str(h, "srv_host",  srv_host) == ESP_OK &&
        nvs_set_u16(h, "srv_port",  srv_port) == ESP_OK &&
        nvs_commit(h)                          == ESP_OK;

    nvs_close(h);
    return ok;
}

void nvs_clear_wifi_config(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
}
