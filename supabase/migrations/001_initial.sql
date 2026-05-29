-- Buddlys Supabase schema
-- Run via: supabase db push  or paste into Supabase SQL editor

-- Devices: links ESP32 hardware ID to a user account
CREATE TABLE IF NOT EXISTS public.devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     TEXT UNIQUE NOT NULL,          -- e.g. "ESP32_AABBCC" derived from MAC
  owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Mein Buddly',
  model         TEXT NOT NULL DEFAULT 'mistral-small-2506',
  tts_provider  TEXT NOT NULL DEFAULT 'cartesia',
  temperature   FLOAT NOT NULL DEFAULT 0.8,
  language      TEXT NOT NULL DEFAULT 'de',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- Conversations: one per talking session
CREATE TABLE IF NOT EXISTS public.conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages within a conversation
CREATE TABLE IF NOT EXISTS public.messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS conversations_user_id_updated ON public.conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_id ON public.messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS devices_owner_id ON public.devices(owner_id);

-- Enable RLS on all tables
ALTER TABLE public.devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;

-- Device policies (owner sees only their devices)
CREATE POLICY "devices_owner_all" ON public.devices
  FOR ALL USING (owner_id = auth.uid());

-- Conversation policies
CREATE POLICY "conversations_owner_all" ON public.conversations
  FOR ALL USING (user_id = auth.uid());

-- Message policies (user sees messages in their own conversations)
CREATE POLICY "messages_owner_all" ON public.messages
  FOR ALL USING (
    conversation_id IN (
      SELECT id FROM public.conversations WHERE user_id = auth.uid()
    )
  );

-- Service role can insert messages (used by the Node server with service key)
CREATE POLICY "messages_service_insert" ON public.messages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "conversations_service_insert" ON public.conversations
  FOR INSERT WITH CHECK (true);

CREATE POLICY "devices_service_update" ON public.devices
  FOR UPDATE USING (true);
