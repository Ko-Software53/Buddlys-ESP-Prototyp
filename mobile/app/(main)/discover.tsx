import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { PermissionsAndroid } from 'react-native';
import {
  waitForBleReady, scanForBuddlys, connectToBuddly,
  readDeviceStatus, BuddlyDevice,
} from '@/lib/bleManager';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { BrandSignet } from '@/components/BrandMark';
import { shadow, theme } from '@/styles/theme';

type ScanState = 'idle' | 'scanning' | 'connecting' | 'error';

export default function Discover() {
  const { user } = useAuth();
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [devices, setDevices] = useState<BuddlyDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);

  const stopScan = useCallback(() => {
    stopScanRef.current?.();
    stopScanRef.current = null;
    setScanState('idle');
  }, []);

  useEffect(() => () => stopScanRef.current?.(), []);

  const requestAndroidPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    const grants = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(grants).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  };

  const startScan = async () => {
    setError(null);
    setDevices([]);

    try {
      const hasPerms = await requestAndroidPermissions();
      if (!hasPerms) {
        setError('Bluetooth-Berechtigungen fehlen. Bitte in den Einstellungen erlauben.');
        return;
      }
      await waitForBleReady();
    } catch (e) {
      setError((e as Error).message);
      return;
    }

    setScanState('scanning');
    const stop = scanForBuddlys(
      (d) => setDevices(prev => [...prev.filter(p => p.id !== d.id), d]),
      (e) => {
        setError(e.message);
        setScanState('error');
      },
    );
    stopScanRef.current = stop;

    // Auto-stop after 15 seconds
    setTimeout(() => {
      if (stopScanRef.current) {
        stop();
        stopScanRef.current = null;
        setScanState(prev => prev === 'scanning' ? 'idle' : prev);
      }
    }, 15_000);
  };

  const onSelectDevice = async (found: BuddlyDevice) => {
    stopScan();
    setScanState('connecting');

    try {
      const connected = await connectToBuddly(found.raw);
      const status = await readDeviceStatus(connected);

      // If already connected to WiFi, register device & go to conversations
      if (status.wifi === 'connected') {
        await ensureDeviceRegistered(status.device_id, found.name);
        router.replace('/(main)/conversations');
        return;
      }

      // Needs provisioning
      router.push({
        pathname: '/(main)/wifi-setup',
        params: { deviceId: found.id, deviceName: found.name, hardwareId: status.device_id },
      });
    } catch (e) {
      Alert.alert('Verbindung fehlgeschlagen', (e as Error).message);
      setScanState('idle');
    }
  };

  const ensureDeviceRegistered = async (hardwareId: string, name: string) => {
    if (!user) return;
    const { data } = await supabase
      .from('devices')
      .select('id')
      .eq('device_id', hardwareId)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (!data) {
      await supabase.from('devices').insert({
        device_id: hardwareId,
        owner_id: user.id,
        name,
      });
    }
  };

  const signalStrength = (rssi: number) => {
    if (rssi > -60) return '●●●';
    if (rssi > -75) return '●●○';
    return '●○○';
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <BrandSignet size={44} />
          <View>
            <Text style={styles.title}>Suche Buddlys</Text>
            <Text style={styles.subtitle}>in der Nähe</Text>
          </View>
        </View>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {scanState === 'connecting' && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={styles.centerText}>Verbinde …</Text>
        </View>
      )}

      {scanState !== 'connecting' && (
        <>
          {devices.length > 0 && (
            <FlatList
              data={[...devices].sort((a, b) => b.rssi - a.rssi)}
              keyExtractor={(item) => item.id}
              style={styles.list}
              contentContainerStyle={{ gap: 10, paddingHorizontal: 20, paddingTop: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.deviceCard}
                  onPress={() => onSelectDevice(item)}
                >
                  <View style={styles.deviceIcon}>
                    <BrandSignet size={36} />
                  </View>
                  <View style={styles.deviceInfo}>
                    <Text style={styles.deviceName}>{item.name}</Text>
                    <Text style={styles.deviceRssi}>{signalStrength(item.rssi)} {item.rssi} dBm</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              )}
            />
          )}

          {devices.length === 0 && scanState === 'idle' && (
            <View style={styles.center}>
              <BrandSignet size={58} />
              <Text style={styles.emptyText}>
                Halte dein Buddly-Gerät bereit und tippe auf Suchen.
              </Text>
            </View>
          )}

          {scanState === 'scanning' && devices.length === 0 && (
            <View style={styles.center}>
              <ActivityIndicator color={theme.colors.primary} size="large" />
              <Text style={styles.centerText}>Suche läuft …</Text>
            </View>
          )}

          <View style={styles.footer}>
            {scanState === 'scanning' ? (
              <TouchableOpacity style={styles.btnSecondary} onPress={stopScan}>
                <Text style={styles.btnSecondaryText}>Suche stoppen</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.btn} onPress={startScan}>
                <Text style={styles.btnText}>
                  {devices.length > 0 ? 'Erneut suchen' : 'Suchen'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingHorizontal: theme.spacing.screen, paddingTop: 16, paddingBottom: 12 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 30, fontWeight: '800', color: theme.colors.text },
  subtitle: { fontSize: 30, fontWeight: '800', color: theme.colors.primary, marginTop: -4 },
  errorBox: { marginHorizontal: 20, marginBottom: 12, backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.md, padding: 12, borderWidth: 1, borderColor: '#F8B6C2' },
  errorText: { color: theme.colors.danger, fontSize: 14 },
  list: { flex: 1 },
  deviceCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  deviceIcon: { marginRight: 14 },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 17, fontWeight: '700', color: theme.colors.text },
  deviceRssi: { fontSize: 13, color: theme.colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 24, color: theme.colors.primary, fontWeight: '300' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, paddingHorizontal: 40 },
  centerText: { fontSize: 16, color: theme.colors.textMuted, textAlign: 'center' },
  emptyText: { fontSize: 15, color: theme.colors.textMuted, textAlign: 'center', lineHeight: 22 },
  footer: { padding: 20, paddingBottom: 8 },
  btn: { backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', ...shadow },
  btnText: { color: theme.colors.white, fontWeight: '700', fontSize: 17 },
  btnSecondary: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  btnSecondaryText: { color: theme.colors.primary, fontWeight: '700', fontSize: 17 },
});
