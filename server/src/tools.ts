import { evaluate } from 'mathjs';
import { webSearch } from './webSearch.js';
import { reasonDeeply } from './reasoning.js';

/**
 * Tool-Definitionen + Dispatcher.
 *
 * Mistral Chat-Completions akzeptieren `tools: [...]` im OpenAI-Format.
 * Bei Bedarf antwortet der LLM mit `tool_calls`, wir führen sie aus
 * und schicken die Ergebnisse als role:"tool" zurück (Round-Trip #2).
 */

export interface MistralToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFS: MistralToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description:
        'Rechnet Mathe-Ausdrücke aus. Nutze dies IMMER und AUSNAHMSLOS für JEDE Rechnung, ' +
        'die das Kind dir stellt oder die du überprüfen musst. Egal wie einfach ' +
        'die Rechnung erscheint (selbst 3 + 5 oder 10 - 4), versuche niemals, ' +
        'es im Kopf auszurechnen. Rufe immer zuerst dieses Tool auf!',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'Ein Mathe-Ausdruck in Standard-Notation, z. B. "5 * 7", "sqrt(144)", "20% of 80".',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Sucht aktuelle Fakten im Web. Verwende dies IMMER wenn das Kind nach ' +
        'aktuellem Wissen fragt (Nachrichten, Wetter, Bedeutungen, "Wer ist …", ' +
        '"Was ist heute …", Sportergebnisse, Promis, Politik) ODER wenn du dir ' +
        'bei einer Faktenfrage nicht hundertprozentig sicher bist. Die Ergebnisse ' +
        'enthalten mehrere Quellen mit Titeln und URLs. Stütze deine Antwort ' +
        'NUR auf das, was die Quellen bestätigen — erfinde nichts dazu. ' +
        'Nicht bei Mathe (da nimm den calculator) und nicht bei Gefühls-/Smalltalk-Fragen.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Suchanfrage auf Deutsch, kurz und konkret.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'current_time',
      description:
        'Gibt das aktuelle Datum und die Uhrzeit zurück. Nutze dies, ' +
        'wenn das Kind fragt wie spät es ist oder welcher Tag.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reason_deeply',
      description:
        'Tieferes Nachdenken bei komplexen Fragen. Nutze dies NUR wenn du ' +
        'aus dem Kopf nicht sicher beantworten kannst: mehrstufige Logik, ' +
        'verschachtelte Warum-Fragen (z. B. "Warum ist der Himmel blau aber ' +
        'beim Sonnenuntergang rot?"), Mathe-Textaufgaben mit mehreren Schritten, ' +
        'physikalische/biologische Zusammenhänge, die du sonst zu vage erklären ' +
        'würdest. NICHT für Smalltalk, Gefühle, einfache Fakten oder Geschichten.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'Die Frage des Kindes, ggf. leicht umformuliert, damit der ' +
              'Reasoning-Assistent sie versteht. Auf Deutsch.',
          },
        },
        required: ['question'],
      },
    },
  },
];

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-String wie von Mistral geliefert
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
}

export async function dispatchTool(call: ToolCall): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { tool_call_id: call.id, name: call.name, content: 'Fehler: ungültige Argumente.' };
  }

  try {
    let content: string;
    switch (call.name) {
      case 'calculator':
        content = doCalc(String(args.expression ?? ''));
        break;
      case 'web_search':
        content = await webSearch(String(args.query ?? ''));
        break;
      case 'current_time':
        content = doNow();
        break;
      case 'reason_deeply':
        content = await reasonDeeply(String(args.question ?? ''));
        break;
      default:
        content = `Unbekanntes Tool: ${call.name}`;
    }
    return { tool_call_id: call.id, name: call.name, content };
  } catch (err) {
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Fehler im Tool ${call.name}: ${(err as Error).message}`,
    };
  }
}

function doCalc(expr: string): string {
  const cleaned = expr.trim();
  if (!cleaned) return 'Kein Ausdruck angegeben.';
  const result = evaluate(cleaned);
  const formatted =
    typeof result === 'number'
      ? result.toLocaleString('de-DE', { maximumFractionDigits: 10, useGrouping: false })
      : String(result);
  return `Ergebnis: ${formatted}`;
}

function doNow(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(now);
}
