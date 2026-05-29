import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase, Message, Conversation } from '@/lib/supabase';
import { theme } from '@/styles/theme';

export default function ConversationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: conv }, { data: msgs }] = await Promise.all([
        supabase.from('conversations').select('*').eq('id', id).single(),
        supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', id)
          .order('created_at', { ascending: true }),
      ]);
      setConversation(conv);
      setMessages(msgs ?? []);
      setLoading(false);
    })();
  }, [id]);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

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
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ Zurück</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {conversation?.title ?? 'Gespräch'}
        </Text>
        <Text style={styles.date}>
          {conversation ? new Date(conversation.created_at).toLocaleDateString('de-DE') : ''}
        </Text>
      </View>

      {messages.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Keine Nachrichten.</Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}>
              <Text style={[styles.bubbleText, item.role === 'user' ? styles.userText : styles.aiText]}>
                {item.content}
              </Text>
              <Text style={[styles.bubbleTime, item.role === 'user' ? styles.userTime : styles.aiTime]}>
                {formatTime(item.created_at)}
              </Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  back: { marginBottom: 4 },
  backText: { color: theme.colors.primary, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '700', color: theme.colors.text },
  date: { fontSize: 13, color: theme.colors.textMuted, marginTop: 2 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: theme.colors.textMuted, fontSize: 15 },
  bubble: { maxWidth: '80%', borderRadius: 16, padding: 12 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: theme.colors.primary, borderBottomRightRadius: 4 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: theme.colors.surface, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: theme.colors.border },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  userText: { color: theme.colors.white },
  aiText: { color: theme.colors.text },
  bubbleTime: { fontSize: 11, marginTop: 4 },
  userTime: { color: 'rgba(255,255,255,0.6)', textAlign: 'right' },
  aiTime: { color: theme.colors.textMuted },
});
