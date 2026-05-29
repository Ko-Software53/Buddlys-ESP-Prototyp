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

const EMPTY: ChildProfile = {
  child_name: '',
  child_age: null,
  interests: [],
  avoid_topics: [],
  learning_goals: [],
  personality: null,
  daily_limit_minutes: null,
  quiet_hours_start: null,
  quiet_hours_end: null,
};

const AGES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function Onboarding() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const [profile, setProfile] = useState<ChildProfile>(EMPTY);
  const [step, setStep] = useState(0);
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

  const patch = (p: Partial<ChildProfile>) => setProfile((cur) => ({ ...cur, ...p }));

  const finish = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('devices')
      .update({ ...profile, onboarded_at: new Date().toISOString() })
      .eq('id', deviceId);
    setSaving(false);
    if (error) {
      Alert.alert('Fehler beim Speichern', error.message);
      return;
    }
    router.replace('/(main)/dashboard');
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={theme.colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  const steps = [
    {
      title: 'Wie heißt dein Kind?',
      hint: 'Buddly spricht dein Kind ab und zu mit dem Namen an.',
      body: <TextField value={profile.child_name} onChangeText={(t) => patch({ child_name: t })} placeholder="z. B. Mia" maxLength={40} />,
    },
    {
      title: 'Wie alt ist dein Kind?',
      hint: 'Damit passt Buddly Sprache und Erklärungen an.',
      body: (
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
      ),
    },
    {
      title: 'Wofür interessiert es sich?',
      hint: 'Buddly greift diese Themen gern auf.',
      body: <ChipEditor value={profile.interests} onChange={(v) => patch({ interests: v })} suggestions={INTEREST_SUGGESTIONS} placeholder="Interesse hinzufügen…" />,
    },
    {
      title: 'Themen, die Buddly meiden soll',
      hint: 'Diese Themen vermeidet Buddly und lenkt sanft ab.',
      body: <ChipEditor value={profile.avoid_topics} onChange={(v) => patch({ avoid_topics: v })} placeholder="z. B. Gruselgeschichten" />,
    },
    {
      title: 'Wie soll Buddly sein?',
      hint: 'Der Charakter prägt den Tonfall.',
      body: <PersonalityPicker value={profile.personality} onChange={(id) => patch({ personality: id })} />,
    },
    {
      title: 'Lernziele (optional)',
      hint: 'Buddly fördert das spielerisch, wenn es passt.',
      body: <ChipEditor value={profile.learning_goals} onChange={(v) => patch({ learning_goals: v })} suggestions={LEARNING_SUGGESTIONS} placeholder="Lernziel hinzufügen…" />,
    },
    {
      title: 'Nutzungsregeln (optional)',
      hint: 'Zeitlimit und Ruhezeiten.',
      body: (
        <UsageControls
          dailyLimit={profile.daily_limit_minutes}
          onDailyLimit={(v) => patch({ daily_limit_minutes: v })}
          quietStart={profile.quiet_hours_start}
          quietEnd={profile.quiet_hours_end}
          onQuiet={(s, e) => patch({ quiet_hours_start: s, quiet_hours_end: e })}
        />
      ),
    },
  ];

  const isLast = step === steps.length - 1;
  const canAdvance = step !== 0 || profile.child_name.trim().length > 0;
  const cur = steps[step];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Einrichtung · {step + 1}/{steps.length}</Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${((step + 1) / steps.length) * 100}%` }]} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Section title={cur.title} hint={cur.hint}>{cur.body}</Section>
      </ScrollView>

      <View style={styles.footer}>
        {step > 0 && (
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep((s) => s - 1)}>
            <Text style={styles.secondaryBtnText}>Zurück</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.primaryBtn, !canAdvance && styles.btnDisabled]}
          disabled={!canAdvance || saving}
          onPress={() => (isLast ? finish() : setStep((s) => s + 1))}
        >
          {saving
            ? <ActivityIndicator color={theme.colors.white} />
            : <Text style={styles.primaryBtnText}>{isLast ? 'Fertig' : 'Weiter'}</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  kicker: { fontSize: 13, fontWeight: '700', color: theme.colors.primary, marginBottom: 10 },
  progressBar: { height: 6, backgroundColor: theme.colors.backgroundDeep, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: theme.colors.primary, borderRadius: 3 },
  optionGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ageDot: { width: 52, height: 52, borderRadius: 26, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border },
  ageDotActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  ageText: { fontSize: 17, fontWeight: '700', color: theme.colors.textMuted },
  ageTextActive: { color: theme.colors.primaryDark },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: theme.colors.border },
  primaryBtn: { flex: 1, backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', ...shadow },
  primaryBtnText: { color: theme.colors.white, fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
  secondaryBtn: { paddingHorizontal: 22, borderRadius: theme.radius.lg, paddingVertical: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: theme.colors.border },
  secondaryBtnText: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 16 },
});
