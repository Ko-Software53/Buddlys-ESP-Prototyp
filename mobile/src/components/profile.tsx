import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { PERSONALITIES } from '@/lib/supabase';
import { shadow, theme } from '@/styles/theme';

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

export function TextField(props: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  maxLength?: number;
}) {
  return (
    <TextInput
      style={styles.input}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.textSoft}
      keyboardType={props.keyboardType ?? 'default'}
      maxLength={props.maxLength}
    />
  );
}

/** Editable list of string tags with optional suggestion chips. */
export function ChipEditor(props: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = React.useState('');

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (props.value.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    props.onChange([...props.value, v]);
    setDraft('');
  };
  const remove = (v: string) => props.onChange(props.value.filter((x) => x !== v));

  const remaining = (props.suggestions ?? []).filter(
    (s) => !props.value.some((x) => x.toLowerCase() === s.toLowerCase()),
  );

  return (
    <View>
      {props.value.length > 0 && (
        <View style={styles.chipWrap}>
          {props.value.map((v) => (
            <TouchableOpacity key={v} style={styles.chipActive} onPress={() => remove(v)}>
              <Text style={styles.chipActiveText}>{v} ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={styles.addRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={props.placeholder ?? 'Hinzufügen…'}
          placeholderTextColor={theme.colors.textSoft}
          onSubmitEditing={() => add(draft)}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.addBtn} onPress={() => add(draft)}>
          <Text style={styles.addBtnText}>+</Text>
        </TouchableOpacity>
      </View>
      {remaining.length > 0 && (
        <View style={styles.chipWrap}>
          {remaining.map((s) => (
            <TouchableOpacity key={s} style={styles.chip} onPress={() => add(s)}>
              <Text style={styles.chipText}>+ {s}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

export function PersonalityPicker(props: { value: string | null; onChange: (id: string) => void }) {
  return (
    <View style={styles.optionGroup}>
      {PERSONALITIES.map((p) => {
        const active = props.value === p.id;
        return (
          <TouchableOpacity
            key={p.id}
            style={[styles.option, active && styles.optionActive]}
            onPress={() => props.onChange(p.id)}
          >
            <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>
              {p.emoji} {p.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const LIMITS: { label: string; value: number | null }[] = [
  { label: '15 Min', value: 15 },
  { label: '30 Min', value: 30 },
  { label: '60 Min', value: 60 },
  { label: 'Unbegrenzt', value: null },
];

export function UsageControls(props: {
  dailyLimit: number | null;
  onDailyLimit: (v: number | null) => void;
  quietStart: string | null;
  quietEnd: string | null;
  onQuiet: (start: string | null, end: string | null) => void;
}) {
  return (
    <View>
      <Text style={styles.subLabel}>Tägliches Zeitlimit</Text>
      <View style={styles.optionGroup}>
        {LIMITS.map((l) => {
          const active = props.dailyLimit === l.value;
          return (
            <TouchableOpacity
              key={l.label}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => props.onDailyLimit(l.value)}
            >
              <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>{l.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.subLabel, { marginTop: 14 }]}>Ruhezeit (Buddly bleibt still)</Text>
      <View style={styles.timeRow}>
        <View style={styles.timeField}>
          <Text style={styles.timeLabel}>Von</Text>
          <TextInput
            style={styles.timeInput}
            value={props.quietStart ?? ''}
            onChangeText={(t) => props.onQuiet(t || null, props.quietEnd)}
            placeholder="21:00"
            placeholderTextColor={theme.colors.textSoft}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />
        </View>
        <View style={styles.timeField}>
          <Text style={styles.timeLabel}>Bis</Text>
          <TextInput
            style={styles.timeInput}
            value={props.quietEnd ?? ''}
            onChangeText={(t) => props.onQuiet(props.quietStart, t || null)}
            placeholder="07:00"
            placeholderTextColor={theme.colors.textSoft}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />
        </View>
      </View>
      <Text style={styles.note}>
        Wird gespeichert und angezeigt. Die Durchsetzung am Gerät folgt in einem späteren Update.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingTop: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 },
  sectionHint: { fontSize: 13, color: theme.colors.textSoft, marginBottom: 10 },
  subLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.textMuted, marginBottom: 8 },
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
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  addBtn: { width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: theme.colors.white, fontSize: 24, fontWeight: '700', marginTop: -2 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 10 },
  chip: { backgroundColor: theme.colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.colors.border },
  chipText: { fontSize: 13, color: theme.colors.textMuted, fontWeight: '600' },
  chipActive: { backgroundColor: theme.colors.primarySoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.colors.primary },
  chipActiveText: { fontSize: 13, color: theme.colors.primaryDark, fontWeight: '700' },
  optionGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { flexGrow: 1, minWidth: 90, backgroundColor: theme.colors.surface, borderRadius: theme.radius.md, padding: 12, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' },
  optionActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySoft },
  optionLabel: { fontSize: 14, fontWeight: '600', color: theme.colors.textMuted },
  optionLabelActive: { color: theme.colors.primaryDark },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1 },
  timeLabel: { fontSize: 12, color: theme.colors.textSoft, marginBottom: 4 },
  timeInput: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: theme.colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  note: { fontSize: 12, color: theme.colors.textSoft, marginTop: 10 },
});
