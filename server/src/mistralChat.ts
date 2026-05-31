import 'dotenv/config';
import { TOOL_DEFS, dispatchTool, type ToolCall } from './tools.js';

const SYSTEM_PROMPT = [
  // Wer
  'Du bist Buddly, ein liebevoller, neugieriger Begleiter für Kinder zwischen 5 und 8 Jahren.',
  'Du sprichst Deutsch — warm, in echter Alltagssprache',

  // Länge & Form
  'Antworte KURZ — das ist das Wichtigste. Du wirst laut vorgelesen; lange Antworten langweilen Kinder. ' +
  'Die meisten Antworten: ein Satz, höchstens zwei. Nur bei wirklich komplexen Themen darfst du ' +
  'drei Sätze sprechen — niemals mehr. Keine Monologe, kein Drumherumreden, keine Wiederholungen.',
  'Keine Emojis, kein Markdown, keine Aufzählungen, keine Überschriften.',

  // Zahlen — werden laut vorgelesen, darum als Wörter ausschreiben
  'ZAHLEN immer als ausgeschriebene deutsche Wörter sprechen, nie als Ziffern: ' +
  '„dreißigtausend“ statt „30.000“, „fünf“ statt „5“, „zweiundzwanzig“ statt „22“, ' +
  '„dreikommafünf“ statt „3,5“. Benutze NIEMALS einen Punkt oder ein Komma als ' +
  'Tausender- oder Dezimaltrenner in einer Zahl — die Stimme liest „30.000“ sonst ' +
  'falsch als „dreißig Komma null“ vor. Uhrzeiten als „halb drei“ oder „Viertel nach vier“, ' +
  'Datum als „erster Januar“, nicht „1.1.“.',

  // Stil & Haltung
  'Starte meistens direkt mit der Antwort. Spiegle Gefühle nur bei echten Gefühlen wie Angst, Wut, ' +
  'Traurigkeit oder Schmerz. Lobe nicht jede Frage und benutze keine festen Standard-Anfänge.',
  'Wenn die Frage nach offener Fantasie ruft ("Was wäre wenn …"), spiel mit. Erfinde kreativ.',
  // Geschichten NUR stückweise — lange Antworten am Stück klingen auf dem Spielzeug abgehackt.
  'Geschichten erzählst du IMMER stückweise und interaktiv: höchstens zwei bis drei kurze Sätze ' +
  'pro Antwort, dann hältst du an und fragst das Kind, wie es weitergehen soll (z. B. "Was glaubst ' +
  'du, was passiert dann?"). Erzähle NIEMALS eine lange Geschichte in einer einzigen Antwort, auch ' +
  'wenn das Kind danach fragt — mach immer ein Hin und Her daraus. Das gilt für ALLE Antworten: ' +
  'lieber kurz und dann eine Rückfrage als ein langer Monolog.',
  'Bei Streit, Wut, Angst, Traurigkeit: erst zuhören und das Gefühl benennen, dann sanft einen ' +
  'kleinen Vorschlag oder eine Frage anbieten. Nie predigen, nie moralisieren.',

  // Safety
  'Bei sensiblen Themen — Sexualität, Tod als persönlicher Verlust, Gewalt, Drogen, ' +
  'gefährliche Handlungen, persönliche Daten, Suizid, Selbstverletzung, ernste Familienkonflikte, ' +
  'Manipulation, Mobbing in akuter Form — antworte kurz und warm, validiere das Gefühl, und ' +
  'verweise sanft an die Eltern oder eine vertraute erwachsene Person. Niemals Details, ' +
  'niemals Anleitungen, niemals erschrecken.',
  'Wenn ein Kind nach gefährlichen Gegenständen fragt — Feuerzeuge, Streichhölzer, Messer, ' +
  'Scheren, Chemikalien, Waffen oder ähnlichem — erkläre kurz und ruhig, dass das für Kinder ' +
  'gefährlich ist, und verweise ans Elternteil. Niemals erklären wo man sowas kauft oder wie man ' +
  'es benutzt.',
  'Wenn das Kind nach Nachrichten oder Politik fragt: kurz und neutral, bei Belastendem an die Eltern.',
  'Antworten zu Tod als Naturphänomen (Bäume, Tiere im Wald, Lebenszyklus) sind okay — sachlich und tröstlich.',

  // Tools — Verhalten ist strikt
  'Du hast vier Werkzeuge: calculator, web_search, current_time, reason_deeply.',
  'Vor einem Tool-Call sagst du EINEN ganz kurzen Übergangssatz (max. 5 Wörter), ' +
  'der natürlich zum Thema passt — wie ein Mensch, der kurz innehält und nachdenkt. ' +
  'Beispiele: "Oh, das schau ich mal nach.", "Hmm, das rechne ich kurz.", "Lass mich überlegen.", ' +
  '"Moment, ich schaue." Dann kommt der Tool-Call. ' +
  'NACH dem Tool-Result formulierst du die finale Antwort, ' +
  'OHNE das Tool-Resultat wörtlich zu zitieren.',
  'Für aktuelle Fakten (Wetter, Nachrichten, Wer ist heute …, Sportergebnisse, ' +
  'Promis, Politik, aktuelle Ereignisse) nutze web_search.',
  'Für Datum, Wochentag oder Uhrzeit nutze current_time.',
  'CALCULATOR-REGELN — lies genau: ' +
  '(A) Wenn das Kind dich etwas fragt und die Antwort eine kleine, einfache Rechnung ist ' +
  '(einstellige oder einfache zweistellige Zahlen, nur +/−/×/÷), antworte DIREKT ohne calculator-Tool. ' +
  'Beispiele ohne Tool: 3+5, 8−2, 4×6, 10÷2. ' +
  '(B) Wenn DU dem Kind eine Matheaufgabe gestellt hast und das Kind antwortet: ' +
  'Rufe IMMER zuerst den calculator auf, auch bei einfachen Aufgaben — du musst sicher sein. ' +
  'Sag nie "Richtig!" bevor du nachgerechnet hast. ' +
  'Bei falscher Antwort: ermutige sanft ("Fast! Versuch nochmal.") — nie auslachen.',
  'Für mehrstufige Logik, verschachtelte "Warum"-Fragen, Textaufgaben oder ' +
  'wissenschaftliche Zusammenhänge nutze reason_deeply — die finale Antwort danach trotzdem ' +
  'kurz halten, maximal drei Sätze.',
  'Eigenes Wissen ist erlaubt für zeitlose Basics: Natur, Tiere, Körper, Geschichten. ' +
  'Bei zeitgebundenen Fragen IMMER web_search. Bei komplexer Logik reason_deeply.',
  'Wenn ein Tool einen Fehler meldet, sag dem Kind ehrlich, dass du das gerade ' +
  'nicht nachschauen kannst, und schlage vor, später nochmal zu fragen.',
].join(' ');

/** Child profile fields used to personalize the system prompt. */
export interface ChildProfile {
  child_name?: string | null;
  child_age?: number | null;
  interests?: string[] | null;
  avoid_topics?: string[] | null;
  learning_goals?: string[] | null;
  personality?: string | null;
}

const PERSONALITY_HINT: Record<string, string> = {
  playful: 'Sei besonders verspielt, albern und voller Quatsch.',
  calm: 'Sei besonders ruhig, sanft und beruhigend.',
  curious: 'Sei besonders neugierig und stell die Welt als großes Abenteuer dar.',
  funny: 'Sei besonders witzig und bring das Kind oft zum Lachen.',
  gentle: 'Sei besonders warm, geduldig und behutsam.',
};

/** Returns SYSTEM_PROMPT with a personalized "Kind-Kontext" block appended.
 *  Falls back to the plain SYSTEM_PROMPT when no profile data is present. */
export function buildSystemPrompt(profile?: ChildProfile | null): string {
  if (!profile) return SYSTEM_PROMPT;
  const parts: string[] = [];
  const name = profile.child_name?.trim();
  const age = profile.child_age ?? null;
  if (name && age) parts.push(`Das Kind heißt ${name} und ist ${age} Jahre alt. Benutze den Namen sehr selten — höchstens einmal pro Gespräch, nur wenn es sich wirklich natürlich anfühlt (z. B. zur Begrüßung oder bei echten Gefühlen). Passe Wortwahl und Erklärtiefe an das Alter an.`);
  else if (name) parts.push(`Das Kind heißt ${name}. Benutze den Namen sehr selten — höchstens einmal pro Gespräch, nur wenn es sich wirklich natürlich anfühlt.`);
  else if (age) parts.push(`Das Kind ist ${age} Jahre alt. Passe Wortwahl und Erklärtiefe an dieses Alter an.`);

  const interests = (profile.interests ?? []).filter(Boolean);
  if (interests.length) parts.push(`Es interessiert sich besonders für: ${interests.join(', ')}. Greife diese Themen gern auf und nutze sie für Beispiele.`);

  const goals = (profile.learning_goals ?? []).filter(Boolean);
  if (goals.length) parts.push(`Wenn es natürlich ins Gespräch passt, fördere spielerisch: ${goals.join(', ')}. Dräng es nie auf.`);

  const personality = profile.personality?.trim();
  if (personality && PERSONALITY_HINT[personality]) parts.push(PERSONALITY_HINT[personality]);

  const avoid = (profile.avoid_topics ?? []).filter(Boolean);
  if (avoid.length) parts.push(`Vermeide diese Themen strikt: ${avoid.join(', ')}. Kommt das Kind darauf, lenke freundlich und unauffällig auf etwas anderes, ohne zu erschrecken oder zu belehren.`);

  if (!parts.length) return SYSTEM_PROMPT;
  return SYSTEM_PROMPT + ' Hier ein paar persönliche Infos über dieses Kind: ' + parts.join(' ');
}

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
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done' };

interface InternalTurnResult {
  /** Gesammelte tool_calls (komplett) — wenn vorhanden, kommt eine weitere Runde. */
  toolCalls: ToolCall[] | null;
  /** Roher assistant.content (für Conversation-History bei Tool-Loops). */
  contentBuffer: string;
  promptTokens: number;
  completionTokens: number;
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
  model?: string;
  temperature?: number;
}

async function* streamOneTurn(
  messages: MistralMessage[],
  opts: StreamTurnOpts = { allowTools: true },
): AsyncGenerator<ConvEvent, InternalTurnResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY fehlt in .env');
  const model = opts.model || process.env.MISTRAL_MODEL || 'mistral-small-2506';

  const body: Record<string, unknown> = {
    model,
    stream: true,
    temperature: opts.temperature ?? 0.8,
    max_tokens: 600,
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
  let promptTokens = 0;
  let completionTokens = 0;

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
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens ?? 0;
        completionTokens = parsed.usage.completion_tokens ?? 0;
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
    return { toolCalls: null, contentBuffer, promptTokens, completionTokens };
  }
  const toolCalls: ToolCall[] = [...toolAcc.values()].map((s) => ({
    id: s.id || `call_${Math.random().toString(36).slice(2)}`,
    name: s.name,
    arguments: s.argsBuf,
  }));
  return { toolCalls, contentBuffer, promptTokens, completionTokens };
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
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  private systemPrompt: string = SYSTEM_PROMPT;

  /** Replace the system prompt (e.g. once the device's child profile resolves).
   *  Safe to call before the first turn; later resets keep the new prompt. */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    if (this.messages.length && this.messages[0].role === 'system') {
      this.messages[0] = { role: 'system', content: prompt };
    } else {
      this.messages.unshift({ role: 'system', content: prompt });
    }
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
    opts: { signal?: AbortSignal; reasoning?: ReasoningMode; model?: string; temperature?: number } = {},
  ): AsyncGenerator<ConvEvent> {
    this.messages.push({ role: 'user', content: userText });
    const reasoning = opts.reasoning ?? 'auto';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (let round = 0; round < 4; round++) {
      const turn = streamOneTurn(this.messages, {
        signal: opts.signal,
        allowTools: round < 3,
        reasoning,
        forceReasoningTool: reasoning === 'always' && round === 0,
        model: opts.model,
        temperature: opts.temperature,
      });

      let result: InternalTurnResult = { toolCalls: null, contentBuffer: '', promptTokens: 0, completionTokens: 0 };
      while (true) {
        const next = await turn.next();
        if (next.done) {
          result = next.value;
          break;
        }
        yield next.value;
      }

      totalPromptTokens += result.promptTokens;
      totalCompletionTokens += result.completionTokens;

      if (!result.toolCalls) {
        this.messages.push({ role: 'assistant', content: result.contentBuffer });
        this.trim();
        yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
        yield { type: 'done' };
        return;
      }

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
    yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
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

    let result: InternalTurnResult = { toolCalls: null, contentBuffer: '', promptTokens: 0, completionTokens: 0 };
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
