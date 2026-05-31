-- Allow educators to delete conversations from the dashboard.
-- Messages (public.messages) and comments (public.conversation_comments) both
-- reference conversations with ON DELETE CASCADE, so removing the conversation
-- row cleans them up automatically — only a DELETE policy on conversations is
-- needed. Safe to re-run (guarded by IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversations'
      AND policyname = 'conversations_educator_delete'
  ) THEN
    CREATE POLICY "conversations_educator_delete" ON public.conversations
      FOR DELETE USING (public.is_educator(auth.uid()));
  END IF;
END $$;
