/**
 * Streaming-Chunker: nimmt Text-Deltas vom LLM entgegen und gibt fertige
 * Sprach-Chunks aus, sobald entweder ein Satzendezeichen erkannt wird
 * oder der interne Buffer eine harte Maximalgrösse erreicht.
 *
 * Ziel: TTS soll möglichst früh starten, ohne mitten im Wort zu schneiden.
 */

export interface ChunkerOptions {
  /** Minimale Chunk-Länge, bevor wir an einem Satzendezeichen schneiden. */
  minLen?: number;
  /** Harte Obergrenze. Bei Überschreitung wird am letzten Whitespace getrennt. */
  maxLen?: number;
  /** Zusätzliche Terminatoren (z. B. ',' für Cartesia-Clause-Streaming). */
  extraTerminators?: string[];
}

const SENTENCE_TERMINATORS = new Set(['.', '?', '!', '…']);
const TERMINATORS = SENTENCE_TERMINATORS; // kept for backwards compat

export class SentenceChunker {
  private buffer = '';
  private readonly minLen: number;
  private readonly maxLen: number;
  private readonly terminators: Set<string>;

  constructor(opts: ChunkerOptions = {}) {
    this.minLen = opts.minLen ?? 24;
    this.maxLen = opts.maxLen ?? 120;
    this.terminators = opts.extraTerminators
      ? new Set([...SENTENCE_TERMINATORS, ...opts.extraTerminators])
      : SENTENCE_TERMINATORS;
  }

  /** Neuen Text-Delta einspeisen, fertige Chunks zurückgeben. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    while (true) {
      const next = this.extract();
      if (!next) break;
      out.push(next);
    }
    return out;
  }

  /** Restpuffer am Ende rausgeben (kann leer sein). */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length ? rest : null;
  }

  private extract(): string | null {
    if (!this.buffer.length) return null;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (!this.terminators.has(ch)) continue;
      if (i + 1 < this.minLen) continue;
      // "262.144" oder "1.000" → Punkt vor Ziffer ist kein Satzende
      if (ch === '.' && /\d/.test(this.buffer[i + 1] ?? '')) continue;
      // Folge-Whitespace mit einsammeln
      let end = i + 1;
      while (end < this.buffer.length && /\s/.test(this.buffer[end])) end++;
      // Wir brauchen einen Buchstaben/Whitespace ODER das Buffer-Ende danach,
      // sonst könnte mitten in "..." oder Ähnlichem geschnitten werden.
      const chunk = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      return chunk;
    }

    if (this.buffer.length >= this.maxLen) {
      let cut = this.buffer.lastIndexOf(' ', this.maxLen);
      if (cut < this.minLen) cut = this.maxLen;
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      return chunk.length ? chunk : null;
    }

    return null;
  }
}
