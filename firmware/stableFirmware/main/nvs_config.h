#pragma once
#include <stdint.h>
#include <stdbool.h>

// WiFi + server config stored in NVS namespace "buddly".
// Returns true if all keys were present and read successfully.
bool nvs_load_wifi_config(char *ssid,     // out, buf[33]
                          char *pass,     // out, buf[65]
                          char *srv_host, // out, buf[128]
                          uint16_t *srv_port); // out

bool nvs_save_wifi_config(const char *ssid, const char *pass,
                          const char *srv_host, uint16_t srv_port);

void nvs_clear_wifi_config(void);
