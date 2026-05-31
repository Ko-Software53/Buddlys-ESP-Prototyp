import 'dotenv/config';

/**
 * Web-Search via Tavily.
 *   POST https://api.tavily.com/search
 *   Body: { api_key, query, search_depth, max_results, include_answer }
 *
 * Returns structured results with source context (title + URL + snippet)
 * so the LLM can judge relevance and trustworthiness.
 *
 * Uses `search_depth: 'advanced'` for more accurate extraction.
 *
 * Fallback ohne Key: knapper Hinweis-String. So weiß der LLM, dass die
 * Suche nicht ging, statt halluziniert "Ergebnis"-Text zu erfinden.
 */

const TAVILY_URL = 'https://api.tavily.com/search';

/**
 * Enriches the query with today's date for time-sensitive searches.
 */
function enrichQuery(query: string): string {
  const timeSensitivePatterns = [
    /\baktuell/i,
    /\bheute\b/i,
    /\bjetzt\b/i,
    /\bmoment/i,
    /\bgerade\b/i,
    /\bdieses jahr/i,
    /\b202\d\b/,
    /\bwetter\b/i,
    /\bnachricht/i,
    /\bnews\b/i,
    /\bpräsident/i,
    /\bpresident/i,
    /\bkanzler/i,
    /\bmeister/i,
    /\bwer ist\b/i,
    /\bwie viel kostet/i,
    /\bwie alt ist/i,
  ];
  const isTimeSensitive = timeSensitivePatterns.some((p) => p.test(query));
  if (isTimeSensitive) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return `${query} (Stand: ${dateStr})`;
  }
  return query;
}

export async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Keine Suchanfrage angegeben.';

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return 'Web-Suche ist nicht konfiguriert (TAVILY_API_KEY fehlt).';
  }

  const enrichedQuery = enrichQuery(q);

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: enrichedQuery,
        search_depth: 'advanced',
        max_results: 5,
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

    const results = data.results || [];

    // Build structured output with source context
    const formattedResults = results
      .filter((r) => r.content || r.title)
      .slice(0, 5)
      .map((r, i) => {
        const parts: string[] = [];
        parts.push(`[Quelle ${i + 1}]`);
        if (r.title) parts.push(`Titel: ${r.title}`);
        if (r.url) parts.push(`URL: ${r.url}`);
        if (r.content) parts.push(`Inhalt: ${r.content}`);
        return parts.join('\n');
      })
      .join('\n\n');

    if (!formattedResults) return 'Keine relevanten Treffer gefunden.';

    // Include Tavily's AI answer as an additional reference (but not the sole source)
    let output = '';
    if (data.answer) {
      output += `Zusammenfassung: ${data.answer}\n\n`;
    }
    output += `Quellen:\n${formattedResults}`;

    return output;
  } catch (err) {
    return `Web-Suche Fehler: ${(err as Error).message}`;
  }
}
