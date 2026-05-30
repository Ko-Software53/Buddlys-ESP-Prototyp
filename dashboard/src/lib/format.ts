export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '–';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')} min`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const weekdayLabel = (d: number) => WEEKDAYS[d] ?? '?';

/** Count occurrences of each string across rows, return sorted top-N. */
export function topCounts(values: string[], limit = 8): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const v of values) {
    const k = v.trim();
    if (!k) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
