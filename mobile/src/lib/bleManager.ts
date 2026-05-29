import { BleManager, Device, State, BleError } from 'react-native-ble-plx';
import { decode as atob, encode as btoa } from 'base-64';
import {
  BUDDLY_SERVICE_UUID,
  STATUS_CHAR_UUID,
  WIFI_SCAN_CHAR_UUID,
  WIFI_CONFIG_CHAR_UUID,
  BUDDLY_DEVICE_NAME_PREFIX,
} from './bleConstants';

export type BuddlyDevice = {
  id: string;
  name: string;
  rssi: number;
  raw: Device;
};

export type WifiNetwork = {
  ssid: string;
  rssi: number;
  auth: number; // 0=open, 2=WPA, 3=WPA2, 4=WPA/WPA2
};

export type DeviceStatus = {
  device_id: string;
  wifi: 'idle' | 'connecting' | 'connected' | 'failed';
  ip?: string;
};

const manager = new BleManager();

export function getBleManager() {
  return manager;
}

export function waitForBleReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sub = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        sub.remove();
        resolve();
      } else if (state === State.PoweredOff || state === State.Unsupported) {
        sub.remove();
        reject(new Error('Bluetooth ist nicht verfügbar oder deaktiviert.'));
      }
    }, true);
  });
}

export function scanForBuddlys(
  onFound: (device: BuddlyDevice) => void,
  onError: (err: BleError | Error) => void,
): () => void {
  const seen = new Set<string>();

  manager.startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
    if (err) { onError(err); return; }
    if (!device) return;
    const name = device.localName || device.name || '';
    if (!name.startsWith(BUDDLY_DEVICE_NAME_PREFIX)) return;
    if (seen.has(device.id)) return;
    seen.add(device.id);
    onFound({ id: device.id, name, rssi: device.rssi ?? -100, raw: device });
  });

  return () => manager.stopDeviceScan();
}

export async function connectToBuddly(device: Device): Promise<Device> {
  const connected = await device.connect({ autoConnect: false, requestMTU: 256 });
  await connected.discoverAllServicesAndCharacteristics();
  return connected;
}

export async function readDeviceStatus(device: Device): Promise<DeviceStatus> {
  const char = await device.readCharacteristicForService(
    BUDDLY_SERVICE_UUID,
    STATUS_CHAR_UUID,
  );
  const json = JSON.parse(atob(char.value ?? ''));
  return json as DeviceStatus;
}

export function subscribeToStatus(
  device: Device,
  onStatus: (status: DeviceStatus) => void,
) {
  return device.monitorCharacteristicForService(
    BUDDLY_SERVICE_UUID,
    STATUS_CHAR_UUID,
    (_err, char) => {
      if (!char?.value) return;
      try {
        onStatus(JSON.parse(atob(char.value)));
      } catch {}
    },
  );
}

// Firmware sends one {"type":"net",...} notification per AP, then {"type":"scan_done"}.
// Each notification is small enough to fit in any MTU.
export function subscribeToWifiScan(
  device: Device,
  onNetworks: (networks: WifiNetwork[]) => void,
) {
  const accumulated: WifiNetwork[] = [];

  return device.monitorCharacteristicForService(
    BUDDLY_SERVICE_UUID,
    WIFI_SCAN_CHAR_UUID,
    (_err, char) => {
      if (!char?.value) return;
      try {
        const parsed = JSON.parse(atob(char.value));
        if (parsed.type === 'net') {
          accumulated.push({ ssid: parsed.ssid, rssi: parsed.rssi, auth: parsed.auth });
        } else if (parsed.type === 'scan_done') {
          onNetworks([...accumulated]);
          accumulated.length = 0;
        }
      } catch {}
    },
  );
}

export async function triggerWifiScan(device: Device): Promise<void> {
  const payload = btoa(JSON.stringify({ cmd: 'scan' }));
  await device.writeCharacteristicWithResponseForService(
    BUDDLY_SERVICE_UUID,
    WIFI_SCAN_CHAR_UUID,
    payload,
  );
}

export async function sendWifiCredentials(
  device: Device,
  ssid: string,
  password: string,
  serverHost: string,
  serverPort: number,
): Promise<void> {
  const payload = btoa(JSON.stringify({ ssid, password, server_host: serverHost, server_port: serverPort }));
  await device.writeCharacteristicWithResponseForService(
    BUDDLY_SERVICE_UUID,
    WIFI_CONFIG_CHAR_UUID,
    payload,
  );
}
