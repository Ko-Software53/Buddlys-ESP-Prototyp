import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  supabase, ChildProfile, INTEREST_SUGGESTIONS, LEARNING_SUGGESTIONS,
} from '@/lib/supabase';
import {
  Section, TextField, ChipEditor, PersonalityPicker, UsageControls,
} from '@/components/profile';
import { theme, shadow } from '@/styles/theme';

const AGES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function ProfileEdit() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('devices').select('*').eq('id', deviceId).single();
      if (data) {
        setProfile({
          child_name: data.child_name ?? '',
          child_age: data.child_age ?? null,
          interests: data.interests ?? [],
          avoid_topics: data.avoid_topics ?? [],
          learning_goals: data.learning_goals ?? [],
          personality: data.personality ?? null,
          daily_limit_minutes: data.daily_limit_minutes ?? null,
          quiet_hours_start: data.quiet_hours_start ?? null,
          quiet_hours_end: data.quiet_hours_end ?? null,
        });
      }
      setLoading(false);
    })();
  }, [deviceId]);

  const patch = (p: Partial<ChildProfile>) => setProfile((cur) => (cur ? { ...cur, ...p } : cur));

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    const { error } = await supabase
      .from('devices')
      .update({ ...profile, onboarded_at: new Date().toISOString() })
      .eq('id', deviceId);
    setSaving(false);
    if (error) Alert.alert('Fehler beim Speichern', error.message);
    else Alert.alert('Gespeichert', 'Das Profil wurde aktualisiert.');
  };

  if (loading || !profile) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={theme.colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹ Zurück</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Kind-Profil</Text>
          <Text style={styles.subtitle}>Personalisiert, wie Buddly spricht</Text>
        </View>

        <Section title="Name">
          <TextField value={profile.child_name} onChangeText={(t) => patch({ child_name: t })} placeholder="z. B. Mia" maxLength={40} />
        </Section>

        <Section title="Alter">
          <View style={styles.optionGroup}>
            {AGES.map((a) => {
              const active = profile.child_age === a;
              return (
                <TouchableOpacity key={a} style={[styles.ageDot, active && styles.ageDotActive]} onPress={() => patch({ child_age: a })}>
                  <Text style={[styles.ageText, active && styles.ageTextActive]}>{a}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        <Section title="Interessen">
          <ChipEditor value={profile.interests} onChange={(v) => patch({ interests: v })} suggestions={INTEREST_SUGGESTIONS} placeholder="Interesse hinzufügen…" />
        </Section>

        <Section title="Themen vermeiden">
          <ChipEditor value={profile.avoid_topics} onChange={(v) => patch({ avoid_topics: v })} placeholder="z. B. Gruselgeschichten" />
        </Section>

        <Section title="Charakter">
          <PersonalityPicker value={profile.personality} onChange={(id) => patch({ personality: id })} />
        </Section>

        <Section title="Lernziele">
          <ChipEditor value={profile.learning_goals} onChange={(v) => patch({ learning_goals: v })} suggestions={LEARNING_SUGGESTIONS} placeholder="Lernziel hinzufügen…" />
        </Section>

        <Section title="Nutzungsregeln">
          <UsageControls
            dailyLimit={profile.daily_limit_minutes}
            onDailyLimit={(v) => patch({ daily_limit_minutes: v })}
            quietStart={profile.quiet_hours_start}
            quietEnd={profile.quiet_hours_end}
            onQuiet={(s, e) => patch({ quiet_hours_start: s, quiet_hours_end: e })}
          />
        </Section>

        <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
          <TouchableOpacity style={[styles.saveBtn, saving && styles.btnDisabled]} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color={theme.colors.white} /> : <Text style={styles.saveBtnText}>Speichern</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  back: { marginBottom: 6 },
  backText: { color: theme.colors.primary, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 24, fontWeight: '800', color: theme.colors.text },
  subtitle: { fontSize: 13, color: theme.colors.textMuted, marginTop: 3 },
  optionGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ageDot: { width: 52, height: 52, borderRadius: 26, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border },
  ageDotActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  ageText: { fontSize: 17, fontWeight: '700', color: theme.colors.textMuted },
  ageTextActive: { color: theme.colors.primaryDark },
  saveBtn: { backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', ...shadow },
  saveBtnText: { color: theme.colors.white, fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
});
