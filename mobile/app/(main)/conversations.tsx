import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { supabase, Conversation, Device } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { BrandSignet } from '@/components/BrandMark';
import { shadow, theme } from '@/styles/theme';

type ConversationWithDevice = Conversation & { device?: Device };

export default function Conversations() {
  const { user, signOut } = useAuth();
  const [conversations, setConversations] = useState<ConversationWithDevice[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;

    const [{ data: devs }, { data: convs }] = await Promise.all([
      supabase.from('devices').select('*').eq('owner_id', user.id),
      supabase
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(100),
    ]);

    const devMap = Object.fromEntries((devs ?? []).map(d => [d.id, d]));
    const enriched = (convs ?? []).map(c => ({ ...c, device: devMap[c.device_id] }));
    setDevices(devs ?? []);
    setConversations(enriched);
    setLoading(false);
    setRefreshing(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    if (isToday) {
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
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
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <BrandSignet size={38} />
          <Text style={styles.title}>Gespräche</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {devices.length > 0 && (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => router.push(`/(main)/device/${devices[0].id}`)}
            >
              <Text style={{ fontSize: 20 }}>⚙️</Text>
              {devices[0].battery_level != null && (
                <Text style={[styles.batteryBadge, {
                  color: devices[0].battery_level >= 50
                    ? theme.colors.success
                    : devices[0].battery_level >= 20
                    ? '#F0A500'
                    : theme.colors.danger,
                }]}>
                  {devices[0].battery_level}%
                </Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.iconBtn} onPress={signOut}>
            <Text style={{ fontSize: 20 }}>🚪</Text>
          </TouchableOpacity>
        </View>
      </View>

      {devices.length === 0 && (
        <View style={styles.emptyDevices}>
          <BrandSignet size={58} />
          <Text style={styles.emptyTitle}>Noch kein Buddly verbunden</Text>
          <Text style={styles.emptySub}>Verbinde deinen Buddly unter "Verbinden".</Text>
        </View>
      )}

      {devices.length > 0 && conversations.length === 0 && (
        <View style={styles.emptyDevices}>
          <BrandSignet size={58} />
          <Text style={styles.emptyTitle}>Noch keine Gespräche</Text>
          <Text style={styles.emptySub}>Sprich mit deinem Buddly und deine Gespräche erscheinen hier.</Text>
        </View>
      )}

      {conversations.length > 0 && (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
          contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingTop: 8 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => router.push(`/(main)/conversation/${item.id}`)}
            >
              <View style={styles.cardLeft}>
                <Text style={styles.cardTitle}>
                  {item.title ?? `Gespräch vom ${formatDate(item.created_at)}`}
                </Text>
                <Text style={styles.cardSub}>
                  {item.device?.name ?? 'Buddly'} · {formatDate(item.updated_at)}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 28, fontWeight: '800', color: theme.colors.text },
  iconBtn: { padding: 6, paddingHorizontal: 10, backgroundColor: theme.colors.surface, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' },
  batteryBadge: { fontSize: 10, fontWeight: '700', marginTop: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyDevices: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
  emptySub: { fontSize: 14, color: theme.colors.textMuted, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadow,
  },
  cardLeft: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text },
  cardSub: { fontSize: 13, color: theme.colors.textMuted, marginTop: 3 },
  chevron: { fontSize: 24, color: theme.colors.primary },
});
