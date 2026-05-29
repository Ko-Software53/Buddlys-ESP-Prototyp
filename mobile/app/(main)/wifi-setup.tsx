import { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { getBleManager } from '@/lib/bleManager';
import {
  connectToBuddly, subscribeToWifiScan, subscribeToStatus,
  triggerWifiScan, sendWifiCredentials, WifiNetwork,
} from '@/lib/bleManager';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import Constants from 'expo-constants';
import { Device } from 'react-native-ble-plx';
import { BrandSignet } from '@/components/BrandMark';
import { shadow, theme } from '@/styles/theme';

type Step = 'scanning' | 'select' | 'password' | 'connecting' | 'done' | 'error';

export default function WifiSetup() {
  const { deviceId, deviceName, hardwareId } = useLocalSearchParams<{
    deviceId: string; deviceName: string; hardwareId: string;
  }>();
  const { user } = useAuth();

  const [step, setStep] = useState<Step>('scanning');
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [selected, setSelected] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  const scanSubRef = useRef<{ remove: () => void } | null>(null);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    let device: Device | null = null;

    (async () => {
      try {
        const ble = getBleManager();
        const raw = await ble.connectToDevice(deviceId, { requestMTU: 256 });
        await raw.discoverAllServicesAndCharacteristics();
        device = raw;
        setConnectedDevice(raw);

        // Subscribe to WiFi scan results
        scanSubRef.current = subscribeToWifiScan(raw, (nets) => {
          setNetworks([...nets].sort((a, b) => b.rssi - a.rssi));
          if (nets.length > 0) setStep('select');
        });

        // Subscribe to status notifications (WiFi connection result)
        statusSubRef.current = subscribeToStatus(raw, async (status) => {
          if (status.wifi === 'connected') {
            await registerDevice();
            setStep('done');
          } else if (status.wifi === 'failed') {
            setErrorMsg('Verbindung fehlgeschlagen. Passwort prüfen.');
            setStep('error');
          }
        });

        await triggerWifiScan(raw);
      } catch (e) {
        setErrorMsg((e as Error).message);
        setStep('error');
      }
    })();

    return () => {
      scanSubRef.current?.remove();
      statusSubRef.current?.remove();
      device?.cancelConnection();
    };
  }, []);

  const registerDevice = async () => {
    if (!user || !hardwareId) return;
    const { data } = await supabase
      .from('devices')
      .select('id')
      .eq('device_id', hardwareId)
      .maybeSingle();
    if (!data) {
      await supabase.from('devices').insert({
        device_id: hardwareId,
        owner_id: user.id,
        name: deviceName || 'Mein Buddly',
      });
    }
  };

  const sendCredentials = async () => {
    if (!selected || !connectedDevice) return;
    setStep('connecting');
    try {
      // Server host: in production this comes from app config or your deployed URL
      const serverHost = Constants.expoConfig?.extra?.serverHost ?? '192.168.2.84';
      const serverPort = 3001;
      await sendWifiCredentials(connectedDevice, selected.ssid, password, serverHost, serverPort);
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  };

  const authLabel = (auth: number) => {
    if (auth === 0) return 'Offen';
    if (auth === 2) return 'WPA';
    return 'WPA2';
  };

  const signalIcon = (rssi: number) => {
    if (rssi > -60) return '▮▮▮';
    if (rssi > -75) return '▮▮▯';
    return '▮▯▯';
  };

  if (step === 'scanning') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={styles.centerTitle}>Verbinde mit {deviceName}</Text>
          <Text style={styles.centerSub}>Suche verfügbare WLANs …</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'connecting') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={styles.centerTitle}>Buddly verbindet sich …</Text>
          <Text style={styles.centerSub}>Mit {selected?.ssid} verbinden</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'done') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <BrandSignet size={64} />
          <Text style={styles.centerTitle}>Buddly ist verbunden!</Text>
          <Text style={styles.centerSub}>Dein Gerät ist jetzt online und mit deinem Konto verknüpft.</Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.replace('/(main)/conversations')}>
            <Text style={styles.btnText}>Weiter zu Gesprächen</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'error') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={{ fontSize: 48 }}>⚠️</Text>
          <Text style={styles.centerTitle}>Fehler</Text>
          <Text style={styles.errorMsg}>{errorMsg}</Text>
          <TouchableOpacity style={styles.btnSecondary} onPress={() => router.back()}>
            <Text style={styles.btnSecondaryText}>Zurück</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'password' && selected) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setStep('select')} style={styles.back}>
              <Text style={styles.backText}>‹ Zurück</Text>
            </TouchableOpacity>
            <Text style={styles.title}>WLAN-Passwort</Text>
            <Text style={styles.networkName}>{selected.ssid}</Text>
          </View>

          <View style={styles.passForm}>
            {selected.auth !== 0 ? (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Passwort"
                  placeholderTextColor={theme.colors.textSoft}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoFocus
                />
                <TouchableOpacity
                  style={[styles.btn, !password && styles.btnDisabled]}
                  onPress={sendCredentials}
                  disabled={!password}
                >
                  <Text style={styles.btnText}>Verbinden</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.btn} onPress={sendCredentials}>
                <Text style={styles.btnText}>Verbinden (kein Passwort)</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // step === 'select'
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>WLAN auswählen</Text>
        <Text style={styles.subtitle}>Welches WLAN soll Buddly nutzen?</Text>
      </View>

      <FlatList
        data={networks}
        keyExtractor={(item) => item.ssid}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingTop: 8 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.networkRow}
            onPress={() => { setSelected(item); setPassword(''); setStep('password'); }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.ssid}>{item.ssid}</Text>
              <Text style={styles.netMeta}>{authLabel(item.auth)} · {signalIcon(item.rssi)}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
      />

      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.btnSecondary}
          onPress={() => { setNetworks([]); setStep('scanning'); connectedDevice && triggerWifiScan(connectedDevice); }}
        >
          <Text style={styles.btnSecondaryText}>Erneut scannen</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  back: { marginBottom: 8 },
  backText: { color: theme.colors.primary, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 28, fontWeight: '800', color: theme.colors.text },
  subtitle: { fontSize: 15, color: theme.colors.textMuted, marginTop: 4 },
  networkName: { fontSize: 18, fontWeight: '700', color: theme.colors.primary, marginTop: 4 },
  networkRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  ssid: { fontSize: 16, fontWeight: '700', color: theme.colors.text },
  netMeta: { fontSize: 13, color: theme.colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 24, color: theme.colors.primary },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, paddingHorizontal: 32 },
  centerTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
  centerSub: { fontSize: 15, color: theme.colors.textMuted, textAlign: 'center', lineHeight: 22 },
  errorMsg: { fontSize: 14, color: theme.colors.danger, textAlign: 'center', lineHeight: 20 },
  passForm: { paddingHorizontal: 20, gap: 12, marginTop: 16 },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: theme.colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  footer: { padding: 20, paddingBottom: 8 },
  btn: { backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', ...shadow },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: theme.colors.white, fontWeight: '700', fontSize: 16 },
  btnSecondary: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  btnSecondaryText: { color: theme.colors.primary, fontWeight: '700', fontSize: 16 },
});
