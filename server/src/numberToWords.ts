const ONES = [
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn',
  'siebzehn', 'achtzehn', 'neunzehn',
];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

function intToGerman(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    return o === 0 ? TENS[t] : ONES[o].replace('eins', 'ein') + 'und' + TENS[t];
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), rest = n % 100;
    const prefix = (h === 1 ? 'ein' : ONES[h].replace('eins', 'ein')) + 'hundert';
    return rest === 0 ? prefix : prefix + intToGerman(rest);
  }
  if (n < 1_000_000) {
    const t = Math.floor(n / 1000), rest = n % 1000;
    const tStr = t === 1 ? 'ein' : intToGerman(t);
    return tStr + 'tausend' + (rest === 0 ? '' : intToGerman(rest));
  }
  if (n < 1_000_000_000) {
    const m = Math.floor(n / 1_000_000), rest = n % 1_000_000;
    const mStr = m === 1 ? 'eine Million' : intToGerman(m) + ' Millionen';
    return rest === 0 ? mStr : mStr + ' ' + intToGerman(rest);
  }
  return String(n);
}

/** Liest eine vierstellige Zahl in "Hunderter"-Form: 1945 → "neunzehnhundertfünfundvierzig".
 *  Im Deutschen die übliche Lesart für Jahreszahlen (und umgangssprachlich für Mengen)
 *  von 1100–1999. Ab 2000 ist die Kardinalform bereits korrekt ("zweitausendvierundzwanzig"). */
function germanHundredsForm(n: number): string {
  const hi = Math.floor(n / 100); // 11..19
  const lo = n % 100;
  return intToGerman(hi) + 'hundert' + (lo === 0 ? '' : intToGerman(lo));
}

/** Ersetzt Zahlen im Text durch ausgeschriebene deutsche Wörter, damit TTS-Engines
 *  keine Digit-Strings falsch vorlesen. Wird auf jeden TTS-Chunk angewendet. */
export function spellOutNumbers(text: string): string {
  // Uhrzeiten zuerst: "8:30" → "acht Uhr dreißig" (konsumiert evtl. nachfolgendes " Uhr")
  let result = text.replace(/\b(\d{1,2}):(\d{2})(\s+Uhr\b)?/g, (match, h, m) => {
    const hN = parseInt(h, 10), mN = parseInt(m, 10);
    if (hN > 23 || mN > 59) return match;
    const minStr = mN === 0 ? '' : ' ' + intToGerman(mN);
    return intToGerman(hN) + ' Uhr' + minStr;
  });

  // Zahlen mit optionalem Vorzeichen, Dezimalstelle und Prozent
  result = result.replace(/-?\d+(?:[.,]\d+)?%?/g, (match) => {
    const hasPercent = match.endsWith('%');
    const numStr = hasPercent ? match.slice(0, -1) : match;
    const isNeg = numStr.startsWith('-');
    const absStr = isNeg ? numStr.slice(1) : numStr;

    let word: string;
    if (absStr.includes('.') || absStr.includes(',')) {
      const [intPart, decPart] = absStr.split(/[.,]/);
      const intWord = intToGerman(parseInt(intPart, 10) || 0);
      const decWords = decPart.split('').map((d) => ONES[parseInt(d, 10)]).join(' ');
      word = `${intWord} Komma ${decWords}`;
    } else {
      const n = parseInt(absStr, 10);
      if (isNaN(n) || n >= 1_000_000_000) return match;
      // Reine vierstellige Zahlen 1100–1999 als Jahreszahl lesen
      // (1945 → "neunzehnhundertfünfundvierzig" statt "...eintausend..."). 2000+
      // bleibt Kardinalform, die als Jahr ohnehin korrekt klingt.
      word = absStr.length === 4 && n >= 1100 && n <= 1999
        ? germanHundredsForm(n)
        : intToGerman(n);
    }

    if (isNeg) word = 'minus ' + word;
    if (hasPercent) word += ' Prozent';
    return word;
  });

  return result;
}
