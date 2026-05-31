/**
 * Keep-Warm Self-Ping
 *
 * Pings the server's own /health endpoint at a fixed interval to prevent
 * cold-start shutdowns on platforms like Railway. Runs as a lightweight
 * setInterval inside the same process — no external cron or extra service.
 */

const INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the keep-warm loop. Call once after the HTTP server is listening.
 * @param port  The port the Express server is bound to.
 */
export function startKeepWarm(port: number): void {
  if (timer) return; // already running

  const url = `http://localhost:${port}/health`;

  const ping = async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(url);
      const body = await res.json();
      console.log(
        `[keep-warm] ${res.status} ${JSON.stringify(body)} (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      console.error(
        `[keep-warm] ping failed (${Date.now() - t0}ms):`,
        (err as Error).message,
      );
    }
  };

  timer = setInterval(ping, INTERVAL_MS);
  // Don't prevent the process from exiting if this is the only active handle.
  timer.unref();

  console.log(
    `[keep-warm] pinging ${url} every ${INTERVAL_MS / 1000}s to stay warm`,
  );
}

/** Stop the keep-warm loop (e.g. during graceful shutdown). */
export function stopKeepWarm(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[keep-warm] stopped');
  }
}
