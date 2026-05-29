-- Child profiles + conversation analytics
-- Run via: supabase db push  or paste into Supabase SQL editor
-- All columns use IF NOT EXISTS so this is safe to re-run / apply over a drifted DB.

-- ── Child profile on devices ────────────────────────────────────────────────
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS child_name          TEXT,
  ADD COLUMN IF NOT EXISTS child_age           INTEGER,
  ADD COLUMN IF NOT EXISTS interests           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS avoid_topics        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS learning_goals      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS personality         TEXT,
  ADD COLUMN IF NOT EXISTS daily_limit_minutes INTEGER,            -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS quiet_hours_start   TEXT,               -- 'HH:MM'
  ADD COLUMN IF NOT EXISTS quiet_hours_end     TEXT,               -- 'HH:MM'
  ADD COLUMN IF NOT EXISTS onboarded_at        TIMESTAMPTZ,        -- NULL → app shows onboarding
  ADD COLUMN IF NOT EXISTS wifi_ssid           TEXT;               -- reconcile drift (used by app, missing in 001)

-- child_age sanity bound (guard so a re-run doesn't duplicate the constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_child_age_range'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_child_age_range
      CHECK (child_age IS NULL OR (child_age >= 1 AND child_age <= 18));
  END IF;
END $$;

-- ── Conversation analytics ──────────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ended_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS message_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS topics           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS summary          TEXT;

CREATE INDEX IF NOT EXISTS conversations_device_created
  ON public.conversations(device_id, created_at DESC);

-- The Node server (service key) finalizes conversations with an UPDATE; only a
-- service INSERT policy existed before.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversations'
      AND policyname = 'conversations_service_update'
  ) THEN
    CREATE POLICY "conversations_service_update" ON public.conversations
      FOR UPDATE USING (true);
  END IF;
END $$;
