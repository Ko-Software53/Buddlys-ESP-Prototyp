import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

export const supabase = url && key
  ? createClient(url, key, {
      auth: { persistSession: false },
      realtime: { transport: ws as unknown as typeof WebSocket },
    })
  : null;

export async function getDeviceConfig(hardwareId: string) {
  if (!supabase) return null;
  const { data } = await supabase
    .from('devices')
    .select('id, owner_id, model, tts_provider, temperature, language, child_name, child_age, interests, avoid_topics, learning_goals, personality')
    .eq('device_id', hardwareId)
    .maybeSingle();
  return data;
}

export async function touchDevice(hardwareId: string) {
  if (!supabase) return;
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('device_id', hardwareId);
}

export async function updateDeviceBattery(hardwareId: string, level: number) {
  if (!supabase) return;
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  await supabase
    .from('devices')
    .update({ battery_level: clamped, last_seen_at: new Date().toISOString() })
    .eq('device_id', hardwareId);
}

export async function createConversation(deviceRowId: string, userId: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('conversations')
    .insert({ device_id: deviceRowId, user_id: userId })
    .select('id')
    .single();
  if (error) { console.error('[supabase] createConversation:', error.message); return null; }
  return data.id;
}

export async function finalizeConversation(
  conversationId: string,
  opts: { durationSeconds: number; messageCount: number; endedAt?: string },
) {
  if (!supabase || !conversationId) return;
  await supabase
    .from('conversations')
    .update({
      ended_at: opts.endedAt ?? new Date().toISOString(),
      duration_seconds: Math.max(0, Math.round(opts.durationSeconds)),
      message_count: opts.messageCount,
    })
    .eq('id', conversationId);
}

export async function tagConversation(
  conversationId: string,
  topics: string[],
  summary: string,
) {
  if (!supabase || !conversationId) return;
  await supabase
    .from('conversations')
    .update({ topics: topics.slice(0, 3), summary: summary.slice(0, 500) })
    .eq('id', conversationId);
}

export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  if (!supabase || !conversationId) return;
  await Promise.all([
    supabase.from('messages').insert({ conversation_id: conversationId, role, content }),
    supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId),
  ]);
}
