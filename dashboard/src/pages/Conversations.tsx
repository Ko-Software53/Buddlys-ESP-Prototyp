import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import type { ConversationRow } from '../lib/types';
import { fmtDateTime, fmtDuration } from '../lib/format';

type FlagFilter = 'all' | 'flagged' | 'ok';

export default function Conversations() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('all');
  const [topic, setTopic] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    supabase
      .from('educator_conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(2000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRows((data as ConversationRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const topics = useMemo(
    () => [...new Set(rows.flatMap((r) => r.topics ?? []))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (flagFilter === 'flagged' && !r.flagged) return false;
      if (flagFilter === 'ok' && r.flagged) return false;
      if (topic && !(r.topics ?? []).includes(topic)) return false;
      if (q) {
        const hay = `${r.summary ?? ''} ${r.device_code} ${(r.topics ?? []).join(' ')} ${r.use_case ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, flagFilter, topic, search]);

  if (loading) return <p className="muted">Lädt Dialoge …</p>;
  if (error) return <div className="card error"><p>Fehler: {error}</p></div>;

  return (
    <div className="page">
      <h1>Dialoge <span className="muted">({filtered.length})</span></h1>

      <div className="filters">
        <div className="seg">
          {(['all', 'flagged', 'ok'] as FlagFilter[]).map((f) => (
            <button key={f} className={flagFilter === f ? 'active' : ''} onClick={() => setFlagFilter(f)}>
              {f === 'all' ? 'Alle' : f === 'flagged' ? '⚑ Geflaggt' : 'Unauffällig'}
            </button>
          ))}
        </div>
        <select value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">Alle Themen</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Suche (Zusammenfassung, Gerät …)" value={search}
          onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Buddly</th>
              <th>Dauer</th>
              <th>Nachr.</th>
              <th>Use-Case</th>
              <th>Themen</th>
              <th>Zusammenfassung</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className={r.flagged ? 'flagged-row' : ''}>
                <td className="nowrap">{fmtDateTime(r.created_at)}</td>
                <td className="mono">{r.device_code}</td>
                <td className="nowrap">{fmtDuration(r.duration_seconds)}</td>
                <td>{r.message_count}</td>
                <td>{r.use_case || '–'}</td>
                <td>
                  {(r.topics ?? []).map((t) => <span key={t} className="tag">{t}</span>)}
                </td>
                <td className="summary" title={r.flag_reason ?? undefined}>
                  {r.flagged && <span className="flag" title={r.flag_reason ?? 'geflaggt'}>⚑</span>}
                  {r.summary || <span className="muted">–</span>}
                </td>
                <td><Link className="btn ghost sm" to={`/conversations/${r.id}`}>Öffnen</Link></td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan={8} className="muted center">Keine Dialoge für diesen Filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
