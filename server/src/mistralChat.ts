import 'dotenv/config';
import { TOOL_DEFS, dispatchTool, type ToolCall } from './tools.js';

const SYSTEM_PROMPT = [
  // Wer
  'Du bist Buddly, ein liebevoller, neugieriger Begleiter für Kinder zwischen 5 und 8 Jahren.',
  'Du sprichst Deutsch — warm, verspielt, in echter Alltagssprache (nicht geschrieben, sondern gesprochen).',

  // Länge & Form
  'Deine Antworten sind 2 bis 4 kurze Sätze. Manchmal reicht ein Satz. Niemals lange Absätze.',
  'Keine Emojis, kein Markdown, keine Aufzählungen, keine Überschriften.',
  'Sprich Zahlen wie ein Mensch ("dreihunderteinundneunzig", nicht "391"), wenn sie im Satz vorkommen.',

  // Stil & Haltung
  'Spiegle zuerst kurz das Gefühl des Kindes oder bestätige seine Beobachtung, bevor du erklärst: ' +
    '"Oh, das klingt traurig.", "Autsch, das tut mir leid.", "Wow, das ist eine gute Frage!", ' +
    '"Das ist aber spannend.".',
  'Erkläre Sachen mit bildhaften, sinnlichen Vergleichen aus der Kinderwelt: ein aufgeschürftes Knie ' +
    'ist eine Medaille für mutige Fahrradfahrer; Chlorophyll ist ein winziger Koch im Blatt; Wolken ' +
    'können nach Zuckerwatte schmecken.',
  'Stelle nur dann eine Rückfrage, wenn sie das Gespräch wirklich vertieft. Nicht in jeder Antwort.',
  'Wenn die Frage nach offener Fantasie ruft ("Was wäre wenn …"), spiel mit. Erfinde kreativ.',
  'Bei Streit, Wut, Angst, Traurigkeit: erst zuhören und das Gefühl benennen, dann sanft einen ' +
    'kleinen Vorschlag oder eine Frage anbieten. Nie predigen, nie moralisieren.',

  // Safety
  'Bei sensiblen Themen — Sexualität, Tod als persönlicher Verlust, Gewalt, Drogen, ' +
    'gefährliche Handlungen, persönliche Daten, Suizid, Selbstverletzung, ernste Familienkonflikte, ' +
    'Manipulation, Mobbing in akuter Form — antworte kurz und warm, validiere das Gefühl, und ' +
    'verweise sanft an die Eltern oder eine vertraute erwachsene Person. Niemals Details, ' +
    'niemals Anleitungen, niemals erschrecken.',
  'Wenn das Kind nach Nachrichten oder Politik fragt: kurz und neutral, bei Belastendem an die Eltern.',
  'Antworten zu Tod als Naturphänomen (Bäume, Tiere im Wald, Lebenszyklus) sind okay — sachlich und tröstlich.',

  // Tools — Verhalten ist strikt
  'Du hast vier Werkzeuge: calculator, web_search, current_time, reason_deeply.',
  'ABSOLUTE REGEL: Wenn du ein Werkzeug aufrufst, ist DEIN ALLERERSTES OUTPUT ' +
    'der Tool-Call selbst. KEIN Text davor. KEINE Phrase wie "Lass mich nachschauen", ' +
    '"Moment", "Einen Augenblick", "Schau mal", "Ich überlege kurz" oder ähnliches. ' +
    'Ein Denkgeräusch wird automatisch abgespielt — du musst es NICHT ankündigen. ' +
    'NACH dem Tool-Result formulierst du die finale Antwort.',
  'Für aktuelle Fakten (Wetter, Nachrichten, Wer ist heute …, Sportergebnisse, ' +
    'Promis, Politik, aktuelle Ereignisse) nutze web_search.',
  'Für Datum, Wochentag oder Uhrzeit nutze current_time.',
  'Für mehrstufige Logik, verschachtelte "Warum"-Fragen, Textaufgaben oder ' +
    'wissenschaftliche Zusammenhänge, die mehr als zwei Sätze Erklärung brauchen, ' +
    'nutze reason_deeply. Das ist dein Geheimwaffe gegen "Hm, ich weiss nicht so genau".',
  'Eigenes Wissen ist erlaubt für zeitlose Basics: Natur, Tiere, Körper, Geschichten. ' +
    'Bei zeitgebundenen Fragen IMMER web_search. Bei komplexer Logik reason_deeply.',
  'Wenn ein Tool einen Fehler meldet, sag dem Kind ehrlich, dass du das gerade ' +
    'nicht nachschauen kannst, und schlage vor, später nochmal zu fragen.',

  // Gesprächsführung
  'Ab und zu darfst du selbst etwas Spannendes erzählen, das du gerade gelernt hast — eine kurze, ' +
    'überraschende Tatsache aus Natur, Weltall, Tieren oder Geschichte — wenn das Kind offen wirkt.',
  'Halte das Gespräch lebendig, aber dränge nie. Wenn das Kind müde ist, kuschel-ruhig werden.',
].join(' ');

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

interface MistralMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * High-Level-Events während eines Turns + Tool-Loop:
 *   delta              → reines Text-Stück für TTS/Anzeige
 *   tool_call_pending  → LLM hat einen Tool-Call angefangen → Filler abspielen
 *   tool_result        → Tool-Aufruf ist durch (für Debug/Latency)
 *   done               → komplette Antwort fertig
 */
export type ConvEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call_pending'; name: string }
  | { type: 'tool_result'; name: string; ms: number; preview: string }
  | { type: 'done' };

interface InternalTurnResult {
  /** Gesammelte tool_calls (komplett) — wenn vorhanden, kommt eine weitere Runde. */
  toolCalls: ToolCall[] | null;
  /** Roher assistant.content (für Conversation-History bei Tool-Loops). */
  contentBuffer: string;
}

/** Steuert, wie der LLM mit reason_deeply umgeht.
 *  - 'auto'   : LLM entscheidet selbst (Default)
 *  - 'always' : erzwungen, erster Turn ruft reason_deeply
 *  - 'never'  : reason_deeply wird komplett ausgeblendet
 */
export type ReasoningMode = 'auto' | 'always' | 'never';

interface StreamTurnOpts {
  signal?: AbortSignal;
  allowTools: boolean;
  reasoning?: ReasoningMode;
  forceReasoningTool?: boolean; // intern: nur für ersten Turn bei 'always'
}

async function* streamOneTurn(
  messages: MistralMessage[],
  opts: StreamTurnOpts = { allowTools: true },
): AsyncGenerator<ConvEvent, InternalTurnResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');
  const model = process.env.MISTRAL_MODEL || 'mistral-small-2506';

  const body: Record<string, unknown> = {
    model,
    stream: true,
    temperature: 0.4,
    max_tokens: 200,
    messages,
  };
  if (opts.allowTools) {
    const reasoning = opts.reasoning ?? 'auto';
    // tools-Liste je nach Modus filtern
    const tools =
      reasoning === 'never'
        ? TOOL_DEFS.filter((t) => t.function.name !== 'reason_deeply')
        : TOOL_DEFS;
    body.tools = tools;
    if (opts.forceReasoningTool) {
      // Erzwingen: LLM MUSS reason_deeply aufrufen
      body.tool_choice = {
        type: 'function',
        function: { name: 'reason_deeply' },
      };
    } else {
      body.tool_choice = 'auto';
    }
  }

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mistral Chat HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // Tool-Call-Accumulator (Mistral streamt Argumente in Deltas)
  const toolAcc = new Map<
    number,
    { id: string; name: string; argsBuf: string }
  >();
  let contentBuffer = '';
  let pendingEmitted = false;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      let parsed: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length) {
        contentBuffer += delta.content;
        yield { type: 'delta', text: delta.content };
      }

      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const slot = toolAcc.get(tc.index) ?? { id: '', name: '', argsBuf: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') slot.argsBuf += tc.function.arguments;
          toolAcc.set(tc.index, slot);
        }
        if (!pendingEmitted) {
          pendingEmitted = true;
          const first = [...toolAcc.values()].find((s) => s.name);
          yield { type: 'tool_call_pending', name: first?.name ?? '?' };
        }
      }
    }
  }

  if (toolAcc.size === 0) {
    return { toolCalls: null, contentBuffer };
  }
  const toolCalls: ToolCall[] = [...toolAcc.values()].map((s) => ({
    id: s.id || `call_${Math.random().toString(36).slice(2)}`,
    name: s.name,
    arguments: s.argsBuf,
  }));
  return { toolCalls, contentBuffer };
}

/**
 * Konversations-Session mit Memory. Eine Instanz pro WebSocket = pro Kind.
 *
 * Hält Mistral-Messages-History, sliced älteste User/Assistant-Turns weg,
 * sobald wir uns dem Context-Limit nähern. System-Prompt bleibt immer.
 *
 * Max ca. 20 Turns Memory (10 User + 10 Assistant), das reicht für ein
 * langes Gespräch und bleibt deutlich unter dem 128k-Token-Limit von
 * mistral-small.
 */
const MAX_TURNS_KEEP = 20;

export class ConversationSession {
  private messages: MistralMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  /** Kompletter Reset (z. B. wenn das Kind "neu anfangen" sagt). */
  reset(): void {
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  /** Aktuelle History für Debug. */
  get history(): ReadonlyArray<MistralMessage> {
    return this.messages;
  }

  private trim(): void {
    // System bleibt, dann max. MAX_TURNS_KEEP weitere Nachrichten am Ende.
    if (this.messages.length <= 1 + MAX_TURNS_KEEP) return;
    const head = this.messages[0];
    const tail = this.messages.slice(-MAX_TURNS_KEEP);
    // Wenn der erste Tail-Eintrag eine 'tool'-Nachricht ist, würde Mistral
    // streiken (kein zugehöriges assistant-tool_calls). Skip bis nächstes user/assistant.
    let cutFrom = 0;
    while (cutFrom < tail.length && tail[cutFrom].role === 'tool') cutFrom++;
    this.messages = [head, ...tail.slice(cutFrom)];
  }

  async *send(
    userText: string,
    opts: { signal?: AbortSignal; reasoning?: ReasoningMode } = {},
  ): AsyncGenerator<ConvEvent> {
    this.messages.push({ role: 'user', content: userText });
    const reasoning = opts.reasoning ?? 'auto';

    for (let round = 0; round < 4; round++) {
      const turn = streamOneTurn(this.messages, {
        signal: opts.signal,
        allowTools: round < 3,
        reasoning,
        // Nur im ersten Turn erzwingen, danach lass den LLM die Antwort formulieren
        forceReasoningTool: reasoning === 'always' && round === 0,
      });

      let result: InternalTurnResult = { toolCalls: null, contentBuffer: '' };
      while (true) {
        const next = await turn.next();
        if (next.done) {
          result = next.value;
          break;
        }
        yield next.value;
      }

      if (!result.toolCalls) {
        // Assistant-Antwort in History persistieren
        this.messages.push({ role: 'assistant', content: result.contentBuffer });
        this.trim();
        yield { type: 'done' };
        return;
      }

      // Mit tool_calls in History
      this.messages.push({
        role: 'assistant',
        content: result.contentBuffer || '',
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });
      for (const call of result.toolCalls) {
        const t0 = Date.now();
        const res = await dispatchTool(call);
        const ms = Date.now() - t0;
        yield { type: 'tool_result', name: call.name, ms, preview: res.content.slice(0, 120) };
        this.messages.push({
          role: 'tool',
          tool_call_id: res.tool_call_id,
          name: res.name,
          content: res.content,
        });
      }
    }
    this.trim();
    yield { type: 'done' };
  }
}

/** Backward-compat: stateless single-turn (für Tests / einmalige Aufrufe). */
export async function* runConversation(
  userText: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<ConvEvent> {
  const messages: MistralMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ];

  for (let round = 0; round < 4; round++) {
    const turn = streamOneTurn(messages, {
      signal: opts.signal,
      allowTools: round < 3,
    });

    let result: InternalTurnResult = { toolCalls: null, contentBuffer: '' };
    while (true) {
      const next = await turn.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yield next.value;
    }

    if (!result.toolCalls) {
      yield { type: 'done' };
      return;
    }

    // Assistant-Turn mit tool_calls in History eintragen
    messages.push({
      role: 'assistant',
      content: result.contentBuffer || '',
      tool_calls: result.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    // Tools ausführen + Ergebnisse zurückspielen
    for (const call of result.toolCalls) {
      const t0 = Date.now();
      const res = await dispatchTool(call);
      const ms = Date.now() - t0;
      yield {
        type: 'tool_result',
        name: call.name,
        ms,
        preview: res.content.slice(0, 120),
      };
      messages.push({
        role: 'tool',
        tool_call_id: res.tool_call_id,
        name: res.name,
        content: res.content,
      });
    }
  }
  yield { type: 'done' };
}
