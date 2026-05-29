import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { supabase, Conversation, Device } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { shadow, theme } from '@/styles/theme';

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };
const fmtMinutes = (sec: number) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} Min`;
  return `${Math.floor(m / 60)} Std ${m % 60} Min`;
};

export default function Dashboard() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const { data: devs } = await supabase.from('devices').select('*').eq('owner_id', user.id);
    const list = devs ?? [];
    setDevices(list);
    const devId = selectedId && list.some((d) => d.id === selectedId) ? selectedId : list[0]?.id ?? null;
    setSelectedId(devId);

    if (devId) {
      const { data: cs } = await supabase
        .from('conversations')
        .select('*')
        .eq('device_id', devId)
        .gte('created_at', startOfMonth().toISOString())
        .order('created_at', { ascending: false });
      setConvs(cs ?? []);
    } else {
      setConvs([]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [user, selectedId]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = () => { setRefreshing(true); load(); };

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;

  const stats = useMemo(() => {
    const todayStart = startOfToday().getTime();
    let secToday = 0, secMonth = 0, sessToday = 0, sessMonth = 0;
    const topicCounts = new Map<string, number>();
    const dayMinutes = new Array(7).fill(0); // index 0 = 6 days ago … 6 = today
    const now = Date.now();

    for (const c of convs) {
      const t = new Date(c.created_at).getTime();
      const dur = c.duration_seconds ?? 0;
      secMonth += dur; sessMonth++;
      if (t >= todayStart) { secToday += dur; sessToday++; }
      for (const topic of c.topics ?? []) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      const daysAgo = Math.floor((now - t) / 86400000);
      if (daysAgo >= 0 && daysAgo < 7) dayMinutes[6 - daysAgo] += dur / 60;
    }

    const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const recent = convs.filter((c) => c.summary).slice(0, 5);
    return { secToday, secMonth, sessToday, sessMonth, topTopics, dayMinutes, recent };
  }, [convs]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={theme.colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  if (!selectedDevice) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Noch kein Buddly</Text>
          <Text style={styles.emptyText}>Verbinde zuerst ein Gerät, um die Übersicht zu sehen.</Text>
          <TouchableOpacity style={styles.connectBtn} onPress={() => router.push('/(main)/discover')}>
            <Text style={styles.connectBtnText}>Buddly verbinden</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const maxDay = Math.max(1, ...stats.dayMinutes);
  const dayLabels = ['', '', '', '', '', 'Gestern', 'Heute'];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Übersicht</Text>
          <Text style={styles.subtitle}>{selectedDevice.child_name || selectedDevice.name}</Text>
        </View>

        {devices.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.devRow}>
            {devices.map((d) => {
              const active = d.id === selectedId;
              return (
                <TouchableOpacity key={d.id} style={[styles.devChip, active && styles.devChipActive]} onPress={() => { setSelectedId(d.id); setLoading(true); }}>
                  <Text style={[styles.devChipText, active && styles.devChipTextActive]}>{d.child_name || d.name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* Talk-time cards */}
        <View style={styles.cardRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{fmtMinutes(stats.secToday)}</Text>
            <Text style={styles.statLabel}>Heute gesprochen</Text>
            <Text style={styles.statSub}>{stats.sessToday} Gespräche</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{fmtMinutes(stats.secMonth)}</Text>
            <Text style={styles.statLabel}>Diesen Monat</Text>
            <Text style={styles.statSub}>{stats.sessMonth} Gespräche</Text>
          </View>
        </View>

        {/* 7-day trend */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Letzte 7 Tage</Text>
          <View style={styles.trendRow}>
            {stats.dayMinutes.map((m, i) => (
              <View key={i} style={styles.trendCol}>
                <View style={styles.trendBarBg}>
                  <View style={[styles.trendBarFill, { height: `${Math.round((m / maxDay) * 100)}%` }]} />
                </View>
                <Text style={styles.trendLabel}>{dayLabels[i] ? dayLabels[i] : `${Math.round(m)}`}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Favorite topics */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lieblingsthemen</Text>
          {stats.topTopics.length === 0 ? (
            <Text style={styles.placeholder}>Noch keine Themen erkannt. Sie erscheinen nach den ersten Gesprächen.</Text>
          ) : (
            <View style={styles.topicWrap}>
              {stats.topTopics.map(([topic, count]) => (
                <View key={topic} style={styles.topicChip}>
                  <Text style={styles.topicText}>{topic}</Text>
                  <Text style={styles.topicCount}>{count}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Learning goals */}
        {(selectedDevice.learning_goals?.length ?? 0) > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Lernziele</Text>
            <View style={styles.topicWrap}>
              {selectedDevice.learning_goals!.map((g) => (
                <View key={g} style={styles.goalChip}><Text style={styles.goalText}>🎯 {g}</Text></View>
              ))}
            </View>
          </View>
        )}

        {/* Recent insights */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Worüber gesprochen wurde</Text>
          {stats.recent.length === 0 ? (
            <Text style={styles.placeholder}>Hier erscheinen kurze Zusammenfassungen der letzten Gespräche.</Text>
          ) : (
            stats.recent.map((c) => (
              <View key={c.id} style={styles.insightRow}>
                <Text style={styles.insightText}>{c.summary}</Text>
                <Text style={styles.insightDate}>
                  {new Date(c.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
          <TouchableOpacity
            style={styles.editBtn}
            onPress={() => router.push({ pathname: '/(main)/profile/[deviceId]', params: { deviceId: selectedDevice.id } })}
          >
            <Text style={styles.editBtnText}>Kind-Profil bearbeiten</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: '800', color: theme.colors.text },
  subtitle: { fontSize: 15, color: theme.colors.textMuted, marginTop: 2 },
  devRow: { paddingHorizontal: 20, gap: 8, paddingBottom: 8 },
  devChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  devChipActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  devChipText: { fontSize: 14, fontWeight: '600', color: theme.colors.textMuted },
  devChipTextActive: { color: theme.colors.primaryDark },
  cardRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 8 },
  statCard: { flex: 1, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: 16, borderWidth: 1, borderColor: theme.colors.border, ...shadow },
  statValue: { fontSize: 22, fontWeight: '800', color: theme.colors.primary },
  statLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text, marginTop: 4 },
  statSub: { fontSize: 12, color: theme.colors.textSoft, marginTop: 2 },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 12 },
  trendRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 120, gap: 6 },
  trendCol: { flex: 1, alignItems: 'center' },
  trendBarBg: { width: '100%', height: 90, backgroundColor: theme.colors.backgroundDeep, borderRadius: 6, justifyContent: 'flex-end', overflow: 'hidden' },
  trendBarFill: { width: '100%', backgroundColor: theme.colors.primary, borderRadius: 6, minHeight: 3 },
  trendLabel: { fontSize: 10, color: theme.colors.textSoft, marginTop: 6 },
  topicWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  topicChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.primarySoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  topicText: { fontSize: 14, fontWeight: '600', color: theme.colors.primaryDark },
  topicCount: { fontSize: 12, fontWeight: '700', color: theme.colors.white, backgroundColor: theme.colors.primary, borderRadius: 999, minWidth: 18, height: 18, textAlign: 'center', overflow: 'hidden', lineHeight: 18 },
  goalChip: { backgroundColor: theme.colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.colors.border },
  goalText: { fontSize: 13, fontWeight: '600', color: theme.colors.text },
  placeholder: { fontSize: 14, color: theme.colors.textSoft, lineHeight: 20 },
  insightRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, backgroundColor: theme.colors.surface, borderRadius: theme.radius.md, padding: 14, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  insightText: { flex: 1, fontSize: 14, color: theme.colors.text, lineHeight: 20 },
  insightDate: { fontSize: 12, color: theme.colors.textSoft },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: theme.colors.text, marginBottom: 8 },
  emptyText: { fontSize: 15, color: theme.colors.textMuted, textAlign: 'center', marginBottom: 20 },
  connectBtn: { backgroundColor: theme.colors.primary, borderRadius: theme.radius.lg, paddingVertical: 14, paddingHorizontal: 28, ...shadow },
  connectBtnText: { color: theme.colors.white, fontWeight: '700', fontSize: 15 },
  editBtn: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.md, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: theme.colors.primary },
  editBtnText: { color: theme.colors.primary, fontWeight: '700', fontSize: 15 },
});
