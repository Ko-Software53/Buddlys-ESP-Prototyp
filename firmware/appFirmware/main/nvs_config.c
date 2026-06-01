#include "nvs_config.h"
#include "settings.h"
#include "nvs.h"

#include <ctype.h>
#include <string.h>

#define NS "buddly"

static bool parse_port(const char *s, uint16_t *port)
{
    unsigned long v = 0;
    if (!s || !*s) return false;
    while (*s) {
        if (!isdigit((unsigned char)*s)) return false;
        v = v * 10 + (unsigned long)(*s - '0');
        if (v == 0 || v > 65535) return false;
        s++;
    }
    *port = (uint16_t)v;
    return true;
}

static bool normalize_server_host(const char *in, char *out, size_t out_sz, uint16_t *port)
{
    char tmp[192];
    if (!in || !out || out_sz == 0 || !port) return false;
    if (strnlen(in, sizeof(tmp)) >= sizeof(tmp)) return false;
    strcpy(tmp, in);

    char *p = tmp;
    while (isspace((unsigned char)*p)) p++;
    char *end = p + strlen(p);
    while (end > p && isspace((unsigned char)end[-1])) *--end = '\0';

    if (strncmp(p, "wss://", 6) == 0) p += 6;
    else if (strncmp(p, "ws://", 5) == 0) p += 5;
    else if (strncmp(p, "https://", 8) == 0) p += 8;
    else if (strncmp(p, "http://", 7) == 0) p += 7;

    char *cut = strpbrk(p, "/?#");
    if (cut) *cut = '\0';

    char *host = p;
    char *colon = strrchr(host, ':');
    if (colon) {
        bool ipv6ish = false;
        for (char *c = host; c < colon; c++) {
            if (*c == ':') {
                ipv6ish = true;
                break;
            }
        }
        if (!ipv6ish) {
            uint16_t parsed_port;
            if (!parse_port(colon + 1, &parsed_port)) return false;
            *colon = '\0';
            *port = parsed_port;
        }
    }

    if (*port == 0) *port = SERVER_PORT;
    if (host[0] == '\0' || strlen(host) >= out_sz) return false;

    for (const char *c = host; *c; c++) {
        unsigned char ch = (unsigned char)*c;
        if (!(isalnum(ch) || ch == '-' || ch == '.')) return false;
    }

    strcpy(out, host);
    return true;
}

bool nvs_load_wifi_config(char *ssid, char *pass, char *srv_host, uint16_t *srv_port)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;

    size_t ssid_sz = 33, pass_sz = 65, host_sz = 128;
    bool ok =
        nvs_get_str(h, "wifi_ssid", ssid,     &ssid_sz) == ESP_OK &&
        nvs_get_str(h, "wifi_pass", pass,     &pass_sz) == ESP_OK &&
        nvs_get_str(h, "srv_host",  srv_host, &host_sz) == ESP_OK;

    uint16_t port = SERVER_PORT;
    nvs_get_u16(h, "srv_port", &port);
    *srv_port = port;

    nvs_close(h);
    return ok && ssid[0] != '\0' &&
           normalize_server_host(srv_host, srv_host, 128, srv_port);
}

bool nvs_save_wifi_config(const char *ssid, const char *pass,
                          const char *srv_host, uint16_t srv_port)
{
    char normalized_host[128];
    uint16_t normalized_port = srv_port ? srv_port : SERVER_PORT;
    if (!normalize_server_host(srv_host, normalized_host, sizeof(normalized_host),
                               &normalized_port)) {
        return false;
    }

    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;

    bool ok =
        nvs_set_str(h, "wifi_ssid", ssid)     == ESP_OK &&
        nvs_set_str(h, "wifi_pass", pass)     == ESP_OK &&
        nvs_set_str(h, "srv_host",  normalized_host) == ESP_OK &&
        nvs_set_u16(h, "srv_port",  normalized_port) == ESP_OK &&
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
