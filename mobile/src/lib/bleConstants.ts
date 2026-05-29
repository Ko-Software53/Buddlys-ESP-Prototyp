// Custom Buddly BLE GATT Service
// All UUIDs must match the firmware implementation in main/ble_prov.c

export const BUDDLY_SERVICE_UUID = '4FAFC201-1FB5-459E-8FCC-C5C9C331914B';

// READ + NOTIFY — sends JSON status & device_id on connect and on WiFi events
// Payload: {"type":"status","device_id":"ESP32_AABBCC","wifi":"idle"|"connecting"|"connected"|"failed","ip":"..."}
export const STATUS_CHAR_UUID = 'BEB5483E-36E1-4688-B7F5-EA07361B26A8';

// WRITE (cmd) + NOTIFY (results)
// Write: {"cmd":"scan"} to trigger a WiFi scan
// Notify: {"type":"scan_result","networks":[{"ssid":"...","rssi":-70,"auth":4}]}
export const WIFI_SCAN_CHAR_UUID = 'BEB5483F-36E1-4688-B7F5-EA07361B26A8';

// WRITE — delivers WiFi credentials and server config to the device
// Payload: {"ssid":"...","password":"...","server_host":"...","server_port":3001}
export const WIFI_CONFIG_CHAR_UUID = 'BEB54840-36E1-4688-B7F5-EA07361B26A8';

// Devices advertise as "Buddly-XXXX" where XXXX is last 4 hex chars of MAC
export const BUDDLY_DEVICE_NAME_PREFIX = 'Buddly-';
