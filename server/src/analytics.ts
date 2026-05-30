import 'dotenv/config';

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

export interface ConversationInsights {
  topics: string[];
  summary: string;
  /** Coarse primary use case, one of USE_CASES (or '' if unclear). */
  useCase: string;
}

/** Allowed use-case buckets so the dashboard can aggregate cleanly. */
export const USE_CASES = [
  'Lernen',
  'Geschichten',
  'Spielen',
  'Gefühle',
  'Wissensfragen',
  'Smalltalk',
  'Einschlafen',
  'Sonstiges',
] as const;

const CLASSIFY_PROMPT =
  'Du analysierst ein Gespräch zwischen einem Kind und einem Sprachspielzeug. ' +
  'Gib ausschließlich ein JSON-Objekt mit genau drei Feldern zurück: ' +
  '"topics" (Array aus 1 bis 3 kurzen deutschen Themenschlagwörtern, z. B. "Dinosaurier", ' +
  '"Mathe", "Gefühle"), "summary" (ein einziger kurzer deutscher Satz für die Eltern, der ' +
  'zusammenfasst, worüber gesprochen wurde) und "useCase" (genau einer dieser Werte, der den ' +
  'Hauptzweck des Gesprächs beschreibt: ' + USE_CASES.join(', ') + '). ' +
  'Keine weiteren Felder, kein Markdown.';

/** Tags a finished conversation with 1–3 topics + a one-line summary via a cheap
 *  Mistral call. Returns null on any failure (caller treats analytics as best-effort). */
export async function classifyConversation(
  transcript: string,
): Promise<ConversationInsights | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey || !transcript.trim()) return null;
  // Use a small, cheap model for classification regardless of the chat model.
  const model = process.env.MISTRAL_MODEL_ANALYTICS || 'mistral-small-2506';

  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: transcript.slice(0, 6000) },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[analytics] classify HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;

    const parsed = JSON.parse(content) as { topics?: unknown; summary?: unknown; useCase?: unknown };
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim())
          .slice(0, 3)
      : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    // Snap the model's useCase onto an allowed bucket (case-insensitive); fall
    // back to '' so the dashboard can group unknowns separately.
    const rawUseCase = typeof parsed.useCase === 'string' ? parsed.useCase.trim() : '';
    const useCase =
      USE_CASES.find((u) => u.toLowerCase() === rawUseCase.toLowerCase()) ?? '';
    if (!topics.length && !summary) return null;
    return { topics, summary, useCase };
  } catch (e) {
    console.error('[analytics] classify failed:', (e as Error).message);
    return null;
  }
}
