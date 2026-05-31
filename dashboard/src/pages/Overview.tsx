import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { supabase } from '../supabase';
import type { ConversationRow } from '../lib/types';
import { fmtDate, fmtDuration, topCounts, weekdayLabel } from '../lib/format';
import {
  addUsage, conversationCost, emptyUsage, eur, monthlyScenarios, usageFromRow,
} from '../lib/cost';

// Minimal: one Buddly-blue accent, one muted tone. No multi-color charts.
const ACCENT = '#086BDE';
const ACCENT_SOFT = '#EEF4FD';
const MUTED = '#C2CAD4';
const GRID = '#F0F2F5';
const tick = { fontSize: 11, fill: '#A0A8B4' } as const;
const tooltipStyle = {
  border: '1px solid #ECEEF2', borderRadius: 8, fontSize: 12,
  boxShadow: 'none', color: '#1A2233',
} as const;

export default function Overview() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('educator_conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRows((data as ConversationRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const stats = useMemo(() => {
    const total = rows.length;
    const durations = rows.map((r) => r.duration_seconds ?? 0).filter((d) => d > 0);
    const totalSeconds = durations.reduce((a, b) => a + b, 0);
    const avg = durations.length ? totalSeconds / durations.length : 0;
    const devices = new Set(rows.map((r) => r.device_code)).size;
    const flagged = rows.filter((r) => r.flagged).length;

    // Usage by hour of day (0–23)
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: `${h}`, count: 0 }));
    // Usage by weekday (0=Sun)
    const byWeekday = Array.from({ length: 7 }, (_, d) => ({ day: weekdayLabel(d), count: 0 }));
    // Conversations per calendar day (last 30)
    const byDay = new Map<string, { dayKey: string; count: number; secs: number; n: number }>();

    for (const r of rows) {
      const d = new Date(r.created_at);
      byHour[d.getHours()].count++;
      byWeekday[d.getDay()].count++;
      const key = d.toISOString().slice(0, 10);
      const e = byDay.get(key) ?? { dayKey: key, count: 0, secs: 0, n: 0 };
      e.count++;
      if (r.duration_seconds) { e.secs += r.duration_seconds; e.n++; }
      byDay.set(key, e);
    }
    const daily = [...byDay.values()]
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
      .slice(-30)
      .map((e) => ({
        label: fmtDate(e.dayKey),
        Gespräche: e.count,
        'Ø Dauer (min)': e.n ? Math.round((e.secs / e.n / 60) * 10) / 10 : 0,
      }));

    const topics = topCounts(rows.flatMap((r) => r.topics ?? []), 10);
    const useCases = topCounts(rows.map((r) => r.use_case ?? '').filter(Boolean), 8);

    // ── Cost ──────────────────────────────────────────────────────────────────
    // Aggregate estimated usage across all conversations, then project the
    // monthly bill for each architecture choice. We scale by the observed time
    // window so the projection reflects a typical 30 days, not the whole history.
    const totalUsage = rows.reduce((acc, r) => addUsage(acc, usageFromRow(r)), emptyUsage);
    const totalCost = rows.reduce((sum, r) => sum + conversationCost(usageFromRow(r)), 0);
    let windowDays = 30;
    if (rows.length > 1) {
      const ts = rows.map((r) => new Date(r.created_at).getTime());
      windowDays = Math.max(1, (Math.max(...ts) - Math.min(...ts)) / 86_400_000);
    }
    const scenarios = monthlyScenarios(totalUsage, windowDays);
    const cheapest = scenarios.reduce((a, b) => (b.monthlyEur < a.monthlyEur ? b : a));
    const costPerConv = total ? totalCost / total : 0;

    return {
      total, avg, totalMinutes: Math.round(totalSeconds / 60), devices, flagged,
      byHour, byWeekday, daily, topics, useCases,
      totalCost, scenarios, cheapest, costPerConv, windowDays,
    };
  }, [rows]);

  if (loading) return <p className="muted">Lädt Auswertung …</p>;
  if (error) return <div className="card error"><p>Fehler: {error}</p></div>;
  if (!rows.length) return <p className="muted">Noch keine Gespräche aufgezeichnet.</p>;

  return (
    <div className="page">
      <h1>Übersicht</h1>

      <div className="kpis">
        <Kpi label="Gespräche" value={String(stats.total)} />
        <Kpi label="Ø Dauer / Gespräch" value={fmtDuration(stats.avg)} />
        <Kpi label="Gesamt-Sprechzeit" value={`${stats.totalMinutes} min`} />
        <Kpi label="Aktive Buddlys" value={String(stats.devices)} />
        <Kpi label="Geflaggt" value={String(stats.flagged)} tone={stats.flagged ? 'warn' : undefined} />
        <Kpi label="Geschätzte Kosten (gesamt)" value={`~${eur(stats.totalCost)}`} />
        <Kpi label="Ø Kosten / Gespräch" value={`~${eur(stats.costPerConv)}`} />
      </div>

      <Panel title="Kostenprojektion / Monat — Architektur-Vergleich">
        <p className="muted projection-hint">
          Hochgerechnet auf 30 Tage aus der beobachteten Nutzung (~{Math.round(stats.windowDays)} Tage,
          {' '}{stats.total} Gespräche). „Variabel“ = Pay-as-you-go (STT/LLM/TTS), „Fix“ = gemietete GPU
          rund um die Uhr. Alle Sätze sind editierbare Schätzwerte in <code>src/lib/cost.ts</code>.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Szenario</th>
                <th>Variabel / Mon.</th>
                <th>Fix / Mon.</th>
                <th>Gesamt / Mon.</th>
                <th>Ø / Gespräch</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {stats.scenarios.map((s) => {
                const perConv = stats.total
                  ? s.monthlyEur / (stats.total * (30 / Math.max(1, stats.windowDays)))
                  : 0;
                return (
                  <tr key={s.key} className={s.key === stats.cheapest.key ? 'flagged-row' : ''}>
                    <td>
                      {s.key === stats.cheapest.key && <span className="tag">günstigste</span>} {s.name}
                    </td>
                    <td className="nowrap mono">{eur(s.variableEur)}</td>
                    <td className="nowrap mono">{s.fixedEur ? eur(s.fixedEur) : '–'}</td>
                    <td className="nowrap mono"><strong>{eur(s.monthlyEur)}</strong></td>
                    <td className="nowrap mono">~{eur(perConv)}</td>
                    <td className="summary">{s.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted projection-hint">
          Fixe GPU-Kosten lohnen sich erst ab genügend Volumen: bei wenig Nutzung ist „Managed“ günstiger,
          bei viel Nutzung amortisiert eine gemietete GPU den Stückpreis. Self-host-LLM rechnet mit einer
          A100 80&nbsp;GB (Mistral Small ~24B braucht ~48&nbsp;GB VRAM inkl. KV-Cache).
        </p>
      </Panel>

      <div className="grid2">
        <Panel title="Nutzung nach Tageszeit">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.byHour}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="hour" tick={tick} interval={1} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} width={28} />
              <Tooltip cursor={{ fill: ACCENT_SOFT }} contentStyle={tooltipStyle} />
              <Bar dataKey="count" name="Gespräche" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Nutzung nach Wochentag">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.byWeekday}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="day" tick={tick} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} width={28} />
              <Tooltip cursor={{ fill: ACCENT_SOFT }} contentStyle={tooltipStyle} />
              <Bar dataKey="count" name="Gespräche" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Verlauf (letzte 30 Tage)">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={stats.daily}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
            <YAxis yAxisId="l" allowDecimals={false} tick={tick} tickLine={false} axisLine={false} width={28} />
            <YAxis yAxisId="r" orientation="right" tick={tick} tickLine={false} axisLine={false} width={28} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line yAxisId="l" type="monotone" dataKey="Gespräche" stroke={ACCENT} strokeWidth={2} dot={false} />
            <Line yAxisId="r" type="monotone" dataKey="Ø Dauer (min)" stroke={MUTED} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <div className="grid2">
        <Panel title="Häufigste Themen">
          {stats.topics.length
            ? <HBars data={stats.topics} />
            : <p className="muted">Noch keine Themen klassifiziert.</p>}
        </Panel>

        <Panel title="Häufigste Use-Cases">
          {stats.useCases.length
            ? <HBars data={stats.useCases} />
            : <p className="muted">Noch keine Use-Cases klassifiziert.</p>}
        </Panel>
      </div>
    </div>
  );
}

/** Minimal horizontal bar list — single accent, no axes clutter. */
function HBars({ data }: { data: { name: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 32)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 12 }}>
        <XAxis type="number" allowDecimals={false} hide />
        <YAxis type="category" dataKey="name" width={108} tick={tick} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: ACCENT_SOFT }} contentStyle={tooltipStyle} />
        <Bar dataKey="count" name="Gespräche" fill={ACCENT} radius={[0, 3, 3, 0]} maxBarSize={16} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`kpi${tone === 'warn' ? ' warn' : ''}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
