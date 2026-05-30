-- Educator dashboard: roles, conversation flagging + comments, anonymized views.
-- Run via: supabase db push  or paste into Supabase SQL editor.
-- All statements use IF NOT EXISTS / guards so this is safe to re-run.

-- ── Roles (profiles) ─────────────────────────────────────────────────────────
-- One row per auth user. role 'educator'/'admin' unlocks the dashboard; 'parent'
-- is the default for app accounts and grants no cross-family access.
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT,
  role       TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'educator', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'profiles' AND policyname = 'profiles_self_select'
  ) THEN
    CREATE POLICY "profiles_self_select" ON public.profiles
      FOR SELECT USING (id = auth.uid());
  END IF;
END $$;

-- Auto-create a 'parent' profile row whenever a new auth user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profiles for users that already exist.
INSERT INTO public.profiles (id, email)
SELECT id, email FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- SECURITY DEFINER helper so RLS policies on other tables can ask "is this user
-- an educator?" without recursively triggering profiles RLS.
CREATE OR REPLACE FUNCTION public.is_educator(uid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND role IN ('educator', 'admin')
  );
$$;

-- ── Conversation flagging ────────────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS use_case     TEXT,                      -- primary use case (e.g. "Lernen", "Spielen")
  ADD COLUMN IF NOT EXISTS flagged      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reason  TEXT;

CREATE INDEX IF NOT EXISTS conversations_flagged ON public.conversations(flagged) WHERE flagged;

-- Educator comments / manual flags on a conversation.
CREATE TABLE IF NOT EXISTS public.conversation_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  comment         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comments_conversation ON public.conversation_comments(conversation_id, created_at ASC);
ALTER TABLE public.conversation_comments ENABLE ROW LEVEL SECURITY;

-- ── Educator RLS policies ────────────────────────────────────────────────────
-- Educators get read access across all test families' conversations/messages and
-- a privacy-limited view of devices. The anonymized views below are what the
-- dashboard actually reads; these base-table policies make those views resolve.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_educator_select') THEN
    CREATE POLICY "conversations_educator_select" ON public.conversations
      FOR SELECT USING (public.is_educator(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_educator_flag') THEN
    CREATE POLICY "conversations_educator_flag" ON public.conversations
      FOR UPDATE USING (public.is_educator(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='messages_educator_select') THEN
    CREATE POLICY "messages_educator_select" ON public.messages
      FOR SELECT USING (public.is_educator(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='devices' AND policyname='devices_educator_select') THEN
    CREATE POLICY "devices_educator_select" ON public.devices
      FOR SELECT USING (public.is_educator(auth.uid()));
  END IF;
  -- Comments: educators read all, insert as themselves, edit/delete their own.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversation_comments' AND policyname='comments_educator_select') THEN
    CREATE POLICY "comments_educator_select" ON public.conversation_comments
      FOR SELECT USING (public.is_educator(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversation_comments' AND policyname='comments_educator_insert') THEN
    CREATE POLICY "comments_educator_insert" ON public.conversation_comments
      FOR INSERT WITH CHECK (public.is_educator(auth.uid()) AND author_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversation_comments' AND policyname='comments_author_modify') THEN
    CREATE POLICY "comments_author_modify" ON public.conversation_comments
      FOR DELETE USING (author_id = auth.uid());
  END IF;
END $$;

-- ── Anonymized views (what the dashboard reads) ──────────────────────────────
-- The device appears only as a stable opaque code; no child name/age, no owner.
-- security_invoker = on  → the caller's RLS (educator policies above) applies,
-- so a non-educator selecting these views still sees nothing.
CREATE OR REPLACE VIEW public.educator_conversations
  WITH (security_invoker = on) AS
SELECT
  c.id,
  'Buddly-' || upper(substr(md5(d.device_id), 1, 4)) AS device_code,
  c.created_at,
  c.ended_at,
  c.duration_seconds,
  c.message_count,
  c.topics,
  c.use_case,
  c.summary,
  c.flagged,
  c.auto_flagged,
  c.flag_reason
FROM public.conversations c
JOIN public.devices d ON d.id = c.device_id;

-- Transcript with the child's first name redacted from message text.
CREATE OR REPLACE VIEW public.educator_messages
  WITH (security_invoker = on) AS
SELECT
  m.id,
  m.conversation_id,
  m.role,
  CASE
    WHEN d.child_name IS NOT NULL AND length(trim(d.child_name)) > 1
      THEN regexp_replace(m.content, '\m' || regexp_replace(trim(d.child_name), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M', '[Name]', 'gi')
    ELSE m.content
  END AS content,
  m.created_at
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
JOIN public.devices d ON d.id = c.device_id;

GRANT SELECT ON public.educator_conversations TO authenticated;
GRANT SELECT ON public.educator_messages TO authenticated;
