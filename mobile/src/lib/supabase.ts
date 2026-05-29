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
};

export type Conversation = {
  id: string;
  device_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages?: Message[];
};

export type Message = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};
