#include "ble_prov.h"
#include "nvs_config.h"
#include "settings.h"

#include <string.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_mac.h"
#include "esp_bt.h"
#include "cJSON.h"

static const char *TAG = "ble_prov";

// ─── UUIDs (little-endian, as required by NimBLE) ────────────────────────────
// Service:    4FAFC201-1FB5-459E-8FCC-C5C9C331914B
// STATUS chr: BEB5483E-36E1-4688-B7F5-EA07361B26A8  READ+NOTIFY
// SCAN chr:   BEB5483F-36E1-4688-B7F5-EA07361B26A8  WRITE+NOTIFY
// CONFIG chr: BEB54840-36E1-4688-B7F5-EA07361B26A8  WRITE

static const ble_uuid128_t svc_uuid =
    BLE_UUID128_INIT(0x4B,0x91,0x31,0xC3,0xC9,0xC5,0xCC,0x8F,
                     0x9E,0x45,0xB5,0x1F,0x01,0xC2,0xAF,0x4F);

static const ble_uuid128_t status_uuid =
    BLE_UUID128_INIT(0xA8,0x26,0x1B,0x36,0x07,0xEA,0xF5,0xB7,
                     0x88,0x46,0xE1,0x36,0x3E,0x48,0xB5,0xBE);

static const ble_uuid128_t scan_uuid =
    BLE_UUID128_INIT(0xA8,0x26,0x1B,0x36,0x07,0xEA,0xF5,0xB7,
                     0x88,0x46,0xE1,0x36,0x3F,0x48,0xB5,0xBE);

static const ble_uuid128_t config_uuid =
    BLE_UUID128_INIT(0xA8,0x26,0x1B,0x36,0x07,0xEA,0xF5,0xB7,
                     0x88,0x46,0xE1,0x36,0x40,0x48,0xB5,0xBE);

// ─── State ────────────────────────────────────────────────────────────────────

static uint16_t s_status_handle;
static uint16_t s_scan_handle;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static EventGroupHandle_t s_prov_eg;

#define PROV_DONE_BIT BIT0

static char s_device_id[20];   // "ESP32_AABBCC"
static char s_adv_name[16];    // "Buddly-XXXX"
static char s_wifi_status[12] = "idle";
static char s_wifi_ip[20]     = "";
static bool s_ble_started     = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

static void notify_status(void)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    char buf[200];
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"status\",\"device_id\":\"%s\","
        "\"wifi\":\"%s\",\"ip\":\"%s\"}",
        s_device_id, s_wifi_status, s_wifi_ip);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, (uint16_t)n);
    if (om) ble_gatts_notify_custom(s_conn_handle, s_status_handle, om);
}

static void notify_scan_network(const char *ssid, int rssi, int auth)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    char buf[120];
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"net\",\"ssid\":\"%s\",\"rssi\":%d,\"auth\":%d}",
        ssid, rssi, auth);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, (uint16_t)n);
    if (om) ble_gatts_notify_custom(s_conn_handle, s_scan_handle, om);
}

static void notify_scan_done(void)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    const char *msg = "{\"type\":\"scan_done\"}";
    struct os_mbuf *om = ble_hs_mbuf_from_flat(msg, strlen(msg));
    if (om) ble_gatts_notify_custom(s_conn_handle, s_scan_handle, om);
}

// ─── WiFi scan task (runs off BLE stack so blocking scan is OK) ───────────────

static void wifi_scan_task(void *arg)
{
    wifi_scan_config_t cfg = {
        .ssid = NULL, .bssid = NULL, .channel = 0, .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time.active = { .min = 100, .max = 300 },
    };
    esp_err_t err = esp_wifi_scan_start(&cfg, true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "scan_start failed: %s", esp_err_to_name(err));
        notify_scan_done();
        vTaskDelete(NULL);
        return;
    }

    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    if (count > 20) count = 20;

    wifi_ap_record_t *recs = malloc(count * sizeof(wifi_ap_record_t));
    if (recs) {
        esp_wifi_scan_get_ap_records(&count, recs);
        for (uint16_t i = 0; i < count; i++) {
            // Sanitise SSID — skip hidden (empty) networks
            if (recs[i].ssid[0] == '\0') continue;
            notify_scan_network((char *)recs[i].ssid, recs[i].rssi, recs[i].authmode);
            // Small delay so BLE stack can flush each notification
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        free(recs);
    }

    notify_scan_done();
    vTaskDelete(NULL);
}

// ─── GATT access callbacks ───────────────────────────────────────────────────

static int cb_status(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_UNLIKELY;
    char buf[200];
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"status\",\"device_id\":\"%s\","
        "\"wifi\":\"%s\",\"ip\":\"%s\"}",
        s_device_id, s_wifi_status, s_wifi_ip);
    return os_mbuf_append(ctxt->om, buf, (uint16_t)n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int cb_scan(uint16_t conn, uint16_t attr,
                   struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    // Kick off scan in a separate task; don't block the BLE stack
    xTaskCreate(wifi_scan_task, "ble_scan", 4096, NULL, 5, NULL);
    return 0;
}

static int cb_config(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    char *buf = malloc(len + 1);
    if (!buf) return BLE_ATT_ERR_INSUFFICIENT_RES;
    os_mbuf_copydata(ctxt->om, 0, len, buf);
    buf[len] = '\0';

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (!root) return BLE_ATT_ERR_UNLIKELY;

    cJSON *ssid_j  = cJSON_GetObjectItem(root, "ssid");
    cJSON *pass_j  = cJSON_GetObjectItem(root, "password");
    cJSON *host_j  = cJSON_GetObjectItem(root, "server_host");
    cJSON *port_j  = cJSON_GetObjectItem(root, "server_port");

    if (!cJSON_IsString(ssid_j) || !cJSON_IsString(pass_j) || !cJSON_IsString(host_j)) {
        cJSON_Delete(root);
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t port = SERVER_PORT;
    if (cJSON_IsNumber(port_j) && port_j->valueint > 0 && port_j->valueint <= 65535) {
        port = (uint16_t)port_j->valueint;
    }
    bool saved = nvs_save_wifi_config(ssid_j->valuestring, pass_j->valuestring,
                                      host_j->valuestring, port);
    cJSON_Delete(root);

    if (!saved) {
        ESP_LOGE(TAG, "nvs_save_wifi_config failed");
        return BLE_ATT_ERR_UNLIKELY;
    }

    ESP_LOGI(TAG, "Credentials saved — provisioning complete");
    xEventGroupSetBits(s_prov_eg, PROV_DONE_BIT);
    return 0;
}

// ─── GATT service table ───────────────────────────────────────────────────────

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {   // STATUS — read current state; app also subscribes for notify
                .uuid       = &status_uuid.u,
                .access_cb  = cb_status,
                .val_handle = &s_status_handle,
                .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {   // WIFI_SCAN — write {"cmd":"scan"} to trigger; results arrive as notifications
                .uuid       = &scan_uuid.u,
                .access_cb  = cb_scan,
                .val_handle = &s_scan_handle,
                .flags      = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
            },
            {   // WIFI_CONFIG — write JSON credentials
                .uuid      = &config_uuid.u,
                .access_cb = cb_config,
                .flags     = BLE_GATT_CHR_F_WRITE,
            },
            { 0 }
        },
    },
    { 0 }
};

// ─── Advertising ─────────────────────────────────────────────────────────────

static int gap_event_cb(struct ble_gap_event *event, void *arg);

static void start_advertising(void)
{
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min  = BLE_GAP_ADV_ITVL_MS(200),
        .itvl_max  = BLE_GAP_ADV_ITVL_MS(300),
    };

    struct ble_hs_adv_fields fields = {0};
    fields.flags                = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name                 = (uint8_t *)s_adv_name;
    fields.name_len             = (uint8_t)strlen(s_adv_name);
    fields.name_is_complete     = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc) { ESP_LOGE(TAG, "adv_set_fields: %d", rc); return; }

    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &params,
                           gap_event_cb, NULL);
    if (rc) ESP_LOGE(TAG, "adv_start: %d", rc);
    else    ESP_LOGI(TAG, "Advertising as %s", s_adv_name);
}

// ─── GAP event handler ───────────────────────────────────────────────────────

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                s_conn_handle = event->connect.conn_handle;
                ESP_LOGI(TAG, "Connected, handle=%d", s_conn_handle);
            } else {
                s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
                start_advertising();
            }
            break;
        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "Disconnected, reason=%d", event->disconnect.reason);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            // Re-advertise unless provisioning is done
            if (!(xEventGroupGetBits(s_prov_eg) & PROV_DONE_BIT))
                start_advertising();
            break;
        case BLE_GAP_EVENT_MTU:
            ESP_LOGI(TAG, "MTU updated: %d", event->mtu.value);
            break;
        default: break;
    }
    return 0;
}

// ─── NimBLE host task ─────────────────────────────────────────────────────────

static void nimble_host_task(void *arg)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

// ─── Sync callback (called when BLE host is ready) ───────────────────────────

static void on_ble_sync(void)
{
    ble_hs_util_ensure_addr(0);
    start_advertising();
}

static void on_ble_reset(int reason)
{
    ESP_LOGE(TAG, "BLE host reset, reason=%d", reason);
}

// ─── Public API ───────────────────────────────────────────────────────────────

static void ensure_device_id(void)
{
    if (s_device_id[0] != '\0') return;
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    snprintf(s_device_id, sizeof(s_device_id),
             "ESP32_%02X%02X%02X", mac[3], mac[4], mac[5]);
    snprintf(s_adv_name,  sizeof(s_adv_name),
             "Buddly-%02X%02X", mac[4], mac[5]);
}

void ble_prov_init(void)
{
    s_ble_started = true;
    ensure_device_id();

    s_prov_eg = xEventGroupCreate();

    nimble_port_init();

    ble_hs_cfg.sync_cb  = on_ble_sync;
    ble_hs_cfg.reset_cb = on_ble_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(s_gatt_svcs);
    if (rc) { ESP_LOGE(TAG, "count_cfg: %d", rc); return; }
    rc = ble_gatts_add_svcs(s_gatt_svcs);
    if (rc) { ESP_LOGE(TAG, "add_svcs: %d", rc); return; }

    ble_svc_gap_device_name_set(s_adv_name);

    nimble_port_freertos_init(nimble_host_task);
    ESP_LOGI(TAG, "BLE provisioning ready, device_id=%s", s_device_id);
}

void ble_prov_stop(void)
{
    if (!s_ble_started) return;
    ble_gap_adv_stop();
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        // Wait for disconnect to complete
        for (int i = 0; i < 20 && s_conn_handle != BLE_HS_CONN_HANDLE_NONE; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
    int rc = nimble_port_stop();
    if (rc == 0) {
        nimble_port_deinit();
    }
    esp_bt_controller_disable();
    esp_bt_controller_deinit();
    esp_bt_controller_mem_release(ESP_BT_MODE_BLE);
    s_ble_started = false;
    ESP_LOGI(TAG, "BLE fully released");
}

bool ble_prov_needed(void)
{
    char ssid[33] = {0};
    char pass[65] = {0};
    char host[128] = {0};
    uint16_t port = 0;
    return !nvs_load_wifi_config(ssid, pass, host, &port);
}

EventGroupHandle_t ble_prov_event_group(void)
{
    return s_prov_eg;
}

void ble_prov_notify_wifi_status(const char *status, const char *ip)
{
    if (!s_ble_started) return;
    strncpy(s_wifi_status, status, sizeof(s_wifi_status) - 1);
    strncpy(s_wifi_ip,     ip,     sizeof(s_wifi_ip) - 1);
    notify_status();
}

const char *ble_prov_device_id(void)
{
    ensure_device_id();
    return s_device_id;
}
