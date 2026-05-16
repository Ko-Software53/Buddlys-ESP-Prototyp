import 'dotenv/config';

/**
 * Deep-Reasoning via Mistral's Reasoning-Modell (Magistral).
 *
 * Wird nur bei genuin komplexen Fragen aufgerufen — Logikrätseln,
 * mehrstufigen "Warum"-Fragen, Mathe-Textaufgaben mit Reasoning.
 * Die Antwort wird vom schnellen Buddly-Modell anschliessend in
 * 2-4 kindgerechte Sätze umformuliert.
 */

const URL = 'https://api.mistral.ai/v1/chat/completions';

const SYS = [
  'Du bist ein Wissenschafts- und Logik-Assistent.',
  'Du erklärst komplexe Sachverhalte einem Kind im Alter 5-8 Jahren.',
  'Denke gründlich nach, prüfe Fakten, gehe die Logik Schritt für Schritt durch.',
  'Antworte auf Deutsch.',
  'Die Antwort soll faktisch korrekt und vollständig sein — der Buddly-Assistent',
  'wird sie anschließend in kindgerechte Sprache umformulieren, du musst also nicht',
  'kindlich klingen, nur klar und richtig.',
].join(' ');

export async function reasonDeeply(question: string): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt');
  const model = process.env.MISTRAL_REASONING_MODEL || 'magistral-small-latest';

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: question },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Reasoning HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const msg = data.choices?.[0]?.message;
  const content = (msg?.content || '').trim();
  return content || 'Konnte gerade nicht tiefer nachdenken.';
}
