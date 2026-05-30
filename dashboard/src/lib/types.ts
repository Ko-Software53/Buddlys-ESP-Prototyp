// Mirrors the anonymized `educator_conversations` / `educator_messages` views.
export interface ConversationRow {
  id: string;
  device_code: string;
  created_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  message_count: number;
  topics: string[];
  use_case: string | null;
  summary: string | null;
  flagged: boolean;
  auto_flagged: boolean;
  flag_reason: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface CommentRow {
  id: string;
  conversation_id: string;
  author_id: string;
  comment: string;
  created_at: string;
}
