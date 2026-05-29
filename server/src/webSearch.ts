import 'dotenv/config';

/**
 * Web-Search via Tavily.
 *   POST https://api.tavily.com/search
 *   Body: { api_key, query, search_depth, max_results, include_answer }
 *
 * Wir bitten Tavily um `include_answer:true` — dann bekommen wir einen
 * kompakten Text statt einer SERP-Liste, perfekt für Sprach-Antworten.
 *
 * Fallback ohne Key: knapper Hinweis-String. So weiß der LLM, dass die
 * Suche nicht ging, statt halluziniert "Ergebnis"-Text zu erfinden.
 */

const TAVILY_URL = 'https://api.tavily.com/search';

export async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Keine Suchanfrage angegeben.';

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return 'Web-Suche ist nicht konfiguriert (TAVILY_API_KEY fehlt).';
  }

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return `Web-Suche fehlgeschlagen (HTTP ${res.status}): ${body.slice(0, 120)}`;
    }
    const data = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };

    // Tavily's AI-generated `answer` field is unreliable (wrong units, hallucinations).
    // Use raw result snippets instead — they contain the actual source text.
    const snippets = (data.results || [])
      .map((r) => r.content || r.title)
      .filter(Boolean)
      .slice(0, 3)
      .join('\n\n');
    return snippets || 'Keine relevanten Treffer gefunden.';
  } catch (err) {
    return `Web-Suche Fehler: ${(err as Error).message}`;
  }
}
