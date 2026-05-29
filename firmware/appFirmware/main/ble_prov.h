#pragma once
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

// BLE Provisioning GATT service — protocol summary
//
// Service UUID:  4FAFC201-1FB5-459E-8FCC-C5C9C331914B
//
// STATUS   BEB5483E  READ+NOTIFY  JSON {"type":"status","device_id":"ESP32_AABBCC","wifi":"idle"|"connecting"|"connected"|"failed","ip":"..."}
// SCAN     BEB5483F  WRITE+NOTIFY Write {"cmd":"scan"} to start; notified with {"type":"net","ssid":"...","rssi":-70,"auth":4} per AP, then {"type":"scan_done"}
// CONFIG   BEB54840  WRITE        Write {"ssid":"...","password":"...","server_host":"...","server_port":3001}
//
// auth values: 0=open, 2=WPA, 3=WPA2, 4=WPA/WPA2
// Device advertises as "Buddly-XXYY" (last 4 hex nibbles of MAC).

#define BLE_PROV_DONE_BIT BIT0

void              ble_prov_init(void);
void              ble_prov_stop(void);
bool              ble_prov_needed(void);           // true if NVS has no WiFi creds
EventGroupHandle_t ble_prov_event_group(void);     // bit PROV_DONE_BIT set when config written

// Call from main after WiFi connects/fails so BLE app gets notified
void              ble_prov_notify_wifi_status(const char *status, const char *ip);

// Returns "ESP32_AABBCC" — include in every WS user_text message as device_id
const char       *ble_prov_device_id(void);
