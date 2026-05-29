import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase, Device } from '@/lib/supabase';
import { shadow, theme } from '@/styles/theme';

const MODELS = [
  { id: 'mistral-small-2506', label: 'Small 2506', desc: 'Schnell & günstig' },
  { id: 'mistral-small-2603', label: 'Small 4', desc: 'Neuester Small' },
  { id: 'mistral-medium-2505', label: 'Medium 2505', desc: 'Klüger' },
];

const TTS_PROVIDERS = [
  { id: 'cartesia', label: 'Cartesia', desc: 'Natürliche Stimme' },
  { id: 'mistral', label: 'Mistral TTS', desc: 'Voxtral PCM' },
];

const LANGUAGES = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
];

export default function DeviceConfig() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [device, setDevice] = useState<Device | null>(null);
  const [name, setName] = useState('');
  const [model, setModel] = useState('mistral-small-2506');
  const [ttsProvider, setTtsProvider] = useState('cartesia');
  const [language, setLanguage] = useState('de');
  const [temperature, setTemperature] = useState(0.8);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('devices').select('*').eq('id', id).single();
      if (data) {
        setDevice(data);
        setName(data.name);
        setModel(data.model);
        setTtsProvider(data.tts_provider);
        setLanguage(data.language);
        setTemperature(data.temperature);
      }
      setLoading(false);
    })();
  }, [id]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('devices')
      .update({ name, model, tts_provider: ttsProvider, language, temperature })
      .eq('id', id);
    setSaving(false);
    if (error) {
      Alert.alert('Fehler beim Speichern', error.message);
    } else {
      Alert.alert('Gespeichert', 'Einstellungen wurden übernommen.');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹ Zurück</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Buddly Einstellungen</Text>
          <Text style={styles.subtitle}>{device?.device_id}</Text>
        </View>

        <Section title="Name">
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="z. B. Mein Buddly"
            placeholderTextColor={theme.colors.textSoft}
          />
        </Section>

        <Section title="KI-Modell">
          <View style={styles.optionGroup}>
            {MODELS.map(m => (
              <TouchableOpacity
                key={m.id}
                style={[styles.option, model === m.id && styles.optionActive]}
                onPress={() => setModel(m.id)}
              >
                <Text style={[styles.optionLabel, model === m.id && styles.optionLabelActive]}>
                  {m.label}
                </Text>
                <Text style={styles.optionDesc}>{m.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        <Section title="Stimme">
          <View style={styles.optionGroup}>
            {TTS_PROVIDERS.map(p => (
              <TouchableOpacity
                key={p.id}
                style={[styles.option, ttsProvider === p.id && styles.optionActive]}
                onPress={() => setTtsProvider(p.id)}
              >
                <Text style={[styles.optionLabel, ttsProvider === p.id && styles.optionLabelActive]}>
                  {p.label}
                </Text>
                <Text style={styles.optionDesc}>{p.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        <Section title="Sprache">
          <View style={styles.optionGroup}>
            {LANGUAGES.map(l => (
              <TouchableOpacity
                key={l.id}
                style={[styles.option, language === l.id && styles.optionActive]}
                onPress={() => setLanguage(l.id)}
              >
                <Text style={[styles.optionLabel, language === l.id && styles.optionLabelActive]}>
                  {l.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        <Section title={`Kreativität: ${temperature.toFixed(1)}`}>
          <View style={styles.sliderRow}>
            {[0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5].map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.sliderDot, temperature === v && styles.sliderDotActive]}
                onPress={() => setTemperature(v)}
              >
                <Text style={[styles.sliderLabel, temperature === v && styles.sliderLabelActive]}>
                  {v.toFixed(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.sliderHint}>Niedrig = präzise · Hoch = kreativ</Text>
        </Section>

        <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={save}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={theme.colors.white} />
              : <Text style={styles.saveBtnText}>Speichern</Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  back: { marginBottom: 6 },
  backText: { color: theme.colors.primary, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 24, fontWeight: '800', color: theme.colors.text },
  subtitle: { fontSize: 13, color: theme.colors.textMuted, marginTop: 3, fontFamily: 'monospace' },
  section: { paddingHorizontal: 20, paddingTop: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: theme.colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  optionGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    flex: 1, minWidth: 100,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  optionActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySoft },
  optionLabel: { fontSize: 14, fontWeight: '600', color: theme.colors.textMuted },
  optionLabelActive: { color: theme.colors.primaryDark },
  optionDesc: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  sliderRow: { flexDirection: 'row', gap: 6 },
  sliderDot: { flex: 1, backgroundColor: theme.colors.surface, borderRadius: theme.radius.sm, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  sliderDotActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  sliderLabel: { fontSize: 13, color: theme.colors.textMuted },
  sliderLabelActive: { color: theme.colors.primaryDark, fontWeight: '700' },
  sliderHint: { fontSize: 12, color: theme.colors.textSoft, marginTop: 6, textAlign: 'center' },
  saveBtn: { backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', ...shadow },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: theme.colors.white, fontWeight: '700', fontSize: 16 },
});
