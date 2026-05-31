// ─────────────────────────────────────────────────────────────────────────────
// Cost estimation for Buddly conversations.
//
// ⚠️  EVERYTHING IN THE "RATES" BLOCK IS AN EDITABLE ESTIMATE.
// We do NOT store real token/character counts per turn, so all figures here are
// *approximations* derived from message text (precise-ish) or from message_count
// + duration (rough). Provider list prices are mostly quoted in USD; we convert
// with USD_TO_EUR. Tune every constant below to your real contracts before using
// these numbers to set plan prices.
// ─────────────────────────────────────────────────────────────────────────────

// ── Rates (EDIT ME) ──────────────────────────────────────────────────────────

export const USD_TO_EUR = 0.92; // fx rate used to convert USD list prices → EUR

// Rough multilingual chars-per-token. German tends a little denser than English.
const CHARS_PER_TOKEN = 4;

// LLM (Mistral API, pay-as-you-go) — USD per 1,000,000 tokens.
// Default = Mistral Small 3 tier. Override per model if you run others.
const LLM_USD_PER_MTOK_IN = 0.1;
const LLM_USD_PER_MTOK_OUT = 0.3;

// System prompt + tools resent on every turn (tokens). The whole context is
// re-billed each turn, so this matters a lot for input cost.
const SYSTEM_PROMPT_TOKENS = 350;

// STT (Voxtral transcription) — USD per minute of audio transcribed.
const STT_USD_PER_MIN = 0.001;

// TTS — USD per 1,000,000 characters synthesized. One entry per provider.
const TTS_USD_PER_MCHAR: Record<string, number> = {
  cartesia: 25, // Cartesia Sonic pay-as-you-go, ~$0.025 / 1k chars
  mistral: 15, // Mistral TTS (placeholder — confirm real price)
  omnivoice: 0, // self-hosted on your own GPU → no per-char fee (see GPU costs below)
};
const TTS_USD_PER_MCHAR_DEFAULT = 25;

// ── Self-hosting (rented GPU) ────────────────────────────────────────────────
// Fixed monthly cost of renting a GPU 24/7 (≈730 h/month). One reserved GPU
// serves many toys until you saturate it; this is a capacity cost, not per-use.
const HOURS_PER_MONTH = 730;

export interface Gpu {
  name: string;
  vramGb: number;
  usdPerHour: number; // typical on-demand cloud rate (RunPod/Lambda-ish)
}

// Small editable catalogue. Prices drift — update them.
export const GPUS: Record<string, Gpu> = {
  l4: { name: 'NVIDIA L4 24 GB', vramGb: 24, usdPerHour: 0.45 },
  a10: { name: 'NVIDIA A10 24 GB', vramGb: 24, usdPerHour: 0.55 },
  l40s: { name: 'NVIDIA L40S 48 GB', vramGb: 48, usdPerHour: 0.9 },
  a100_40: { name: 'NVIDIA A100 40 GB', vramGb: 40, usdPerHour: 1.3 },
  a100_80: { name: 'NVIDIA A100 80 GB', vramGb: 80, usdPerHour: 1.8 },
  h100: { name: 'NVIDIA H100 80 GB', vramGb: 80, usdPerHour: 2.8 },
};

export const gpuMonthlyEur = (g: Gpu) => g.usdPerHour * HOURS_PER_MONTH * USD_TO_EUR;

// Recommended GPU to self-host the LLM. Mistral Small (~24B) in fp16 needs
// ~48 GB VRAM incl. KV-cache; an A100 40 GB works in 8-bit, L40S 48 GB / A100
// 80 GB run it comfortably with headroom for concurrency.
export const LLM_SELFHOST_GPU = GPUS.a100_80;
// TTS (Omnivoice) is far smaller — a 24 GB card is plenty.
export const TTS_SELFHOST_GPU = GPUS.l4;

// ── Usage model ──────────────────────────────────────────────────────────────

export interface Usage {
  sttMinutes: number; // audio transcribed (user speech)
  llmInTokens: number; // prompt tokens billed (context grows every turn)
  llmOutTokens: number; // tokens generated
  ttsChars: number; // characters spoken back
}

const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
// Spoken duration of a piece of text at ~150 words/min (≈5 chars/word).
const speakMinutes = (chars: number) => chars / 5 / 150;

interface Msg { role: 'user' | 'assistant'; content: string }

/** Precise-ish usage from the actual transcript (used on the detail page). */
export function usageFromMessages(messages: Msg[]): Usage {
  let history = 0; // running context tokens (system added per turn separately)
  const u: Usage = { sttMinutes: 0, llmInTokens: 0, llmOutTokens: 0, ttsChars: 0 };
  for (const m of messages) {
    const t = tokens(m.content);
    if (m.role === 'user') {
      u.sttMinutes += speakMinutes(m.content.length);
      history += t;
    } else {
      // input billed for this turn = system prompt + everything before the reply
      u.llmInTokens += SYSTEM_PROMPT_TOKENS + history;
      u.llmOutTokens += t;
      u.ttsChars += m.content.length;
      history += t;
    }
  }
  return u;
}

// Averages for the rough estimate when we don't load the transcript (list/overview).
const AVG_USER_CHARS = 60;
const AVG_ASSISTANT_CHARS = 180;

/** Rough usage from a conversation row (no transcript loaded). */
export function usageFromRow(row: { message_count: number; duration_seconds: number | null }): Usage {
  const turns = Math.max(0, Math.round((row.message_count || 0) / 2));
  const userT = tokens('x'.repeat(AVG_USER_CHARS));
  const outT = tokens('x'.repeat(AVG_ASSISTANT_CHARS));
  // Context grows linearly over turns → average half the final history per turn.
  const perTurnHistory = (userT + outT) / 2;
  return {
    sttMinutes: speakMinutes(turns * AVG_USER_CHARS),
    llmInTokens: turns * SYSTEM_PROMPT_TOKENS + perTurnHistory * (turns * (turns + 1)) / 2,
    llmOutTokens: turns * outT,
    ttsChars: turns * AVG_ASSISTANT_CHARS,
  };
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  sttMinutes: a.sttMinutes + b.sttMinutes,
  llmInTokens: a.llmInTokens + b.llmInTokens,
  llmOutTokens: a.llmOutTokens + b.llmOutTokens,
  ttsChars: a.ttsChars + b.ttsChars,
});

export const emptyUsage: Usage = { sttMinutes: 0, llmInTokens: 0, llmOutTokens: 0, ttsChars: 0 };

// ── Cost ─────────────────────────────────────────────────────────────────────

const usd2eur = (usd: number) => usd * USD_TO_EUR;

export interface CostBreakdown {
  stt: number;
  llm: number;
  tts: number;
  total: number; // variable (per-use) cost only — excludes fixed GPU rental
}

/** Per-use (variable) EUR cost of some usage on a given TTS provider. */
export function variableCost(u: Usage, ttsProvider = 'cartesia'): CostBreakdown {
  const stt = usd2eur(u.sttMinutes * STT_USD_PER_MIN);
  const llm = usd2eur(
    (u.llmInTokens / 1e6) * LLM_USD_PER_MTOK_IN + (u.llmOutTokens / 1e6) * LLM_USD_PER_MTOK_OUT,
  );
  const ttsRate = TTS_USD_PER_MCHAR[ttsProvider] ?? TTS_USD_PER_MCHAR_DEFAULT;
  const tts = usd2eur((u.ttsChars / 1e6) * ttsRate);
  return { stt, llm, tts, total: stt + llm + tts };
}

/** Convenience: single-number EUR estimate for one conversation. */
export const conversationCost = (u: Usage, ttsProvider = 'cartesia') =>
  variableCost(u, ttsProvider).total;

// ── Monthly scenario projection ──────────────────────────────────────────────
// Given the usage observed over `windowDays`, scale to 30 days and price each
// architecture choice so you can see what a plan must cost to stay profitable.

export interface Scenario {
  key: string;
  name: string;
  monthlyEur: number; // variable + fixed
  variableEur: number;
  fixedEur: number; // GPU rental etc.
  note: string;
}

export function monthlyScenarios(totalUsage: Usage, windowDays: number): Scenario[] {
  const scale = windowDays > 0 ? 30 / windowDays : 1;
  const m = (u: Usage): Usage => ({
    sttMinutes: u.sttMinutes * scale,
    llmInTokens: u.llmInTokens * scale,
    llmOutTokens: u.llmOutTokens * scale,
    ttsChars: u.ttsChars * scale,
  });
  const mu = m(totalUsage);

  const llmGpu = gpuMonthlyEur(LLM_SELFHOST_GPU);
  const ttsGpu = gpuMonthlyEur(TTS_SELFHOST_GPU);

  // Variable cost with LLM zeroed out (LLM runs on the rented GPU instead).
  const noLlm = (u: Usage, tts: string): number =>
    variableCost(u, tts).total - variableCost(u, tts).llm;

  return [
    {
      key: 'cartesia',
      name: 'Managed · Cartesia TTS',
      variableEur: variableCost(mu, 'cartesia').total,
      fixedEur: 0,
      monthlyEur: variableCost(mu, 'cartesia').total,
      note: 'Mistral API (LLM) + Voxtral STT + Cartesia TTS. Reines Pay-as-you-go.',
    },
    {
      key: 'mistralTts',
      name: 'Managed · Mistral TTS',
      variableEur: variableCost(mu, 'mistral').total,
      fixedEur: 0,
      monthlyEur: variableCost(mu, 'mistral').total,
      note: 'Mistral API (LLM) + Voxtral STT + Mistral TTS.',
    },
    {
      key: 'omnivoice',
      name: 'Self-host TTS · Omnivoice',
      variableEur: variableCost(mu, 'omnivoice').total,
      fixedEur: ttsGpu,
      monthlyEur: variableCost(mu, 'omnivoice').total + ttsGpu,
      note: `Managed LLM + STT, aber TTS selbst gehostet auf ${TTS_SELFHOST_GPU.name} (${eur(ttsGpu)}/Mon. fix).`,
    },
    {
      key: 'selfLlmCartesia',
      name: 'Self-host LLM (GPU) + Cartesia',
      variableEur: noLlm(mu, 'cartesia'),
      fixedEur: llmGpu,
      monthlyEur: noLlm(mu, 'cartesia') + llmGpu,
      note: `LLM selbst gehostet auf ${LLM_SELFHOST_GPU.name} (${eur(llmGpu)}/Mon. fix) + Voxtral STT + Cartesia TTS.`,
    },
    {
      key: 'selfAll',
      name: 'Self-host LLM + TTS (GPU)',
      variableEur: noLlm(mu, 'omnivoice'),
      fixedEur: llmGpu + ttsGpu,
      monthlyEur: noLlm(mu, 'omnivoice') + llmGpu + ttsGpu,
      note: `LLM auf ${LLM_SELFHOST_GPU.name} + TTS (Omnivoice) auf ${TTS_SELFHOST_GPU.name}, nur STT extern. ${eur(llmGpu + ttsGpu)}/Mon. fix.`,
    },
  ];
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function eur(value: number): string {
  if (!isFinite(value)) return '–';
  // sub-cent figures: show more precision so a single cheap conversation isn't "0 €"
  const digits = value !== 0 && Math.abs(value) < 1 ? (Math.abs(value) < 0.01 ? 4 : 3) : 2;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value);
}
