import 'dotenv/config';
import { supabase } from './supabase.js';

const MISTRAL_EMBED_URL = 'https://api.mistral.ai/v1/embeddings';

/**
 * Generate embeddings for a batch of texts using mistral-embed.
 * mistral-embed accepts an array of inputs per request, so batching here
 * cuts the number of API round-trips (and cost/time) dramatically during ingest.
 * Returns one 1024-dim vector per input, in the same order.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');
  if (texts.length === 0) return [];

  const res = await fetch(MISTRAL_EMBED_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-embed',
      input: texts,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Mistral Embed HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  const embeddings: number[][] = (data?.data ?? []).map((d: any) => d?.embedding);

  if (embeddings.length !== texts.length || embeddings.some((e) => !Array.isArray(e))) {
    throw new Error('Ungültige Antwort von Mistral Embed API');
  }

  return embeddings;
}

/**
 * Generate an embedding for a single text using mistral-embed.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

/**
 * Search the global knowledge base in Supabase using the given query text.
 */
export async function searchGlobalKnowledge(query: string, matchCount: number = 3): Promise<string> {
  if (!supabase) return 'Fehler: Supabase nicht konfiguriert.';

  const NO_INFO = 'Keine relevanten Informationen in der Wissensdatenbank gefunden.';

  try {
    const embedding = await generateEmbedding(query);

    // 0.5 cosine is a permissive starting point for mistral-embed; tune later.
    const { data, error } = await supabase.rpc('match_global_knowledge', {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: matchCount,
    });

    if (error) {
      // Don't surface raw DB errors to the LLM (it would paraphrase them to the
      // child). Treat a failure as "no info" so Buddly says it honestly.
      console.error('[rag] Supabase RPC error:', error.message);
      return NO_INFO;
    }

    if (!data || data.length === 0) {
      return NO_INFO;
    }

    // Combine retrieved documents into a single context string
    const results = data.map((doc: any, index: number) => {
      return `[Quelle ${index + 1}: ${doc.title}]\n${doc.content}\n`;
    });

    return results.join('\n');
  } catch (err: any) {
    console.error('[rag] Error searching global knowledge:', err.message);
    return NO_INFO;
  }
}
