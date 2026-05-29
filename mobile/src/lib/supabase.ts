import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export type Device = {
  id: string;
  device_id: string;
  owner_id: string;
  name: string;
  model: string;
  tts_provider: string;
  temperature: number;
  language: string;
  created_at: string;
  last_seen_at: string | null;
  battery_level: number | null;
  wifi_ssid: string | null;
  // Child profile
  child_name: string | null;
  child_age: number | null;
  interests: string[] | null;
  avoid_topics: string[] | null;
  learning_goals: string[] | null;
  personality: string | null;
  daily_limit_minutes: number | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  onboarded_at: string | null;
};

// Editable child-profile fields, shared by the onboarding wizard and edit screen.
export type ChildProfile = {
  child_name: string;
  child_age: number | null;
  interests: string[];
  avoid_topics: string[];
  learning_goals: string[];
  personality: string | null;
  daily_limit_minutes: number | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
};

export const PERSONALITIES = [
  { id: 'playful', label: 'Verspielt', emoji: '🤸' },
  { id: 'calm', label: 'Ruhig', emoji: '🌙' },
  { id: 'curious', label: 'Neugierig', emoji: '🔭' },
  { id: 'funny', label: 'Lustig', emoji: '😄' },
  { id: 'gentle', label: 'Sanft', emoji: '🧸' },
] as const;

export const INTEREST_SUGGESTIONS = [
  'Tiere', 'Weltraum', 'Dinosaurier', 'Fußball', 'Malen', 'Musik',
  'Autos', 'Prinzessinnen', 'Natur', 'Roboter', 'Bauen', 'Geschichten',
];

export const LEARNING_SUGGESTIONS = [
  'Zählen üben', 'Erste Englischwörter', 'Buchstaben lernen', 'Farben & Formen',
  'Vorlesen & Geschichten', 'Beruhigen vorm Schlafen',
];

export type Conversation = {
  id: string;
  device_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  message_count: number | null;
  topics: string[] | null;
  summary: string | null;
  messages?: Message[];
};

export type Message = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};
