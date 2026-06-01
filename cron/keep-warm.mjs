// Keep-Warm Worker
//
// Hält den Buddlys-Haupt-Service auf Railway wach, damit das Spielzeug nach
// langer Pause (z.B. morgens nach dem Aufwachen aus dem Deep-Sleep) NICHT auf
// einen Cold-Start trifft. Ein Cold-Start verzoegert das erste TTS-Audio so
// stark, dass der Jitter-Buffer leerlaeuft -> Stottern -> WebSocket-Abbruch.
//
// WICHTIG — Deployment als NORMALER (always-on) Service, NICHT als Cron-Job:
//   - Railway Cron hat ein Minimum von 5 Minuten; "*/2" wird abgelehnt.
//   - Railway schlaeft einen Service nach ~10 Min ohne ausgehenden Traffic ein.
//   Dieser Worker laeuft daher dauerhaft und pingt selbst alle 2 Minuten.
//   Dadurch bleibt sowohl der Haupt-Service als auch dieser Worker wach.
//
// Railway-Setup:
//   - Neuer Service im selben Projekt, selbes Repo, Root = /cron
//   - Start Command:  node keep-warm.mjs   (laeuft dauerhaft, kein Cron!)
//   - KEIN Cron Schedule setzen.
//   - Restart Policy: ON_FAILURE (Default) reicht — der Prozess endet nie.
//
// Alternative (einfacher, aber gleicher Kostenaufwand): im Haupt-Service unter
// Settings -> Serverless / App Sleeping DEAKTIVIEREN. Dann ist dieser Worker
// ueberfluessig.

const URL =
  process.env.HEALTH_URL ||
  'https://buddlys-esp-prototyp-production.up.railway.app/health';

// Ping-Intervall. Muss deutlich unter Railways ~10-Min-Sleep-Fenster liegen.
const INTERVAL_MS = Number(process.env.KEEP_WARM_INTERVAL_MS) || 120_000; // 2 min
const TIMEOUT_MS = Number(process.env.KEEP_WARM_TIMEOUT_MS) || 10_000;

async function ping() {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    const ms = Date.now() - t0;
    const tag = res.ok ? 'OK' : 'BAD';
    // Lange Antwortzeit (> ~1.5s) deutet auf einen Cold-Boot hin.
    const cold = ms > 1_500 ? ' <-- moegl. COLD START' : '';
    console.log(`[keep-warm] ${tag} ${res.status} ${body.slice(0, 120)} (${ms}ms)${cold}`);
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`[keep-warm] FAILED after ${ms}ms:`, err.message);
  }
}

console.log(
  `[keep-warm] started — pinging ${URL} every ${INTERVAL_MS / 1000}s`,
);

// Sofort einmal pingen, danach im Intervall. Der Prozess endet bewusst nie.
await ping();
setInterval(ping, INTERVAL_MS);
