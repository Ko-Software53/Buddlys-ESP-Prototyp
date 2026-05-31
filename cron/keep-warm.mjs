/**
 * Keep-Warm Cron Job
 *
 * Pingt den Buddlys-Server /health Endpoint an, damit Railway den
 * Haupt-Service nicht einschlafen lässt.
 *
 * Railway-Setup:
 *   - Neuer Service im selben Projekt, selbes Repo
 *   - Start Command:  node cron/keep-warm.mjs
 *   - Cron Schedule:  */2 * * * *
 */

const URL =
  process.env.HEALTH_URL ||
  'https://buddlys-esp-prototyp-production.up.railway.app/health';

const TIMEOUT_MS = 10_000;

try {
  const t0 = Date.now();
  const res = await fetch(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  const ms = Date.now() - t0;

  console.log(`[keep-warm] ${res.status} ${body} (${ms}ms)`);

  if (!res.ok) process.exit(1);
} catch (err) {
  console.error('[keep-warm] FAILED:', err.message);
  process.exit(1);
}
