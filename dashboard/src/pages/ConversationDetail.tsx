import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import type { CommentRow, ConversationRow, MessageRow } from '../lib/types';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { eur, usageFromMessages, variableCost } from '../lib/cost';

export default function ConversationDetail({ userId }: { userId: string }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conv, setConv] = useState<ConversationRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const cost = useMemo(() => variableCost(usageFromMessages(messages)), [messages]);

  const load = async () => {
    if (!id) return;
    const [c, m, cm] = await Promise.all([
      supabase.from('educator_conversations').select('*').eq('id', id).maybeSingle(),
      supabase.from('educator_messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }),
      supabase.from('conversation_comments').select('*').eq('conversation_id', id).order('created_at', { ascending: true }),
    ]);
    if (c.error) setError(c.error.message);
    setConv((c.data as ConversationRow) ?? null);
    setMessages((m.data as MessageRow[]) ?? []);
    setComments((cm.data as CommentRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [id]);

  const toggleFlag = async () => {
    if (!conv) return;
    const next = !conv.flagged;
    setConv({ ...conv, flagged: next });
    const patch = next
      ? { flagged: true, flag_reason: conv.flag_reason ?? 'Manuell von Pädagog:in geflaggt' }
      : { flagged: false };
    const { error } = await supabase.from('conversations').update(patch).eq('id', conv.id);
    if (error) { setError(error.message); void load(); }
  };

  const addComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !draft.trim()) return;
    setSaving(true);
    const { error } = await supabase
      .from('conversation_comments')
      .insert({ conversation_id: id, author_id: userId, comment: draft.trim() });
    if (error) setError(error.message);
    else { setDraft(''); await load(); }
    setSaving(false);
  };

  const deleteComment = async (commentId: string) => {
    await supabase.from('conversation_comments').delete().eq('id', commentId);
    setComments((cs) => cs.filter((c) => c.id !== commentId));
  };

  const deleteConversation = async () => {
    if (!conv) return;
    if (!window.confirm('Diesen Dialog endgültig löschen? Transkript und Kommentare werden mitgelöscht.')) return;
    setDeleting(true);
    // Delete the base-table row (cascades to messages + comments). The dashboard
    // reads anonymized views but writes by id to `conversations`, same as flagging.
    const { error } = await supabase.from('conversations').delete().eq('id', conv.id);
    if (error) { setError(error.message); setDeleting(false); return; }
    navigate('/conversations', { replace: true });
  };

  if (loading) return <p className="muted">Lädt Dialog …</p>;
  if (error) return <div className="card error"><p>Fehler: {error}</p></div>;
  if (!conv) return <p className="muted">Dialog nicht gefunden.</p>;

  return (
    <div className="page detail">
      <Link className="back" to="/conversations">← Zurück zur Liste</Link>

      <div className="detail-head">
        <div>
          <h1>{conv.device_code} <span className="muted">· {fmtDateTime(conv.created_at)}</span></h1>
          <div className="meta">
            <span>Dauer: {fmtDuration(conv.duration_seconds)}</span>
            <span>{conv.message_count} Nachrichten</span>
            <span title={`STT ${eur(cost.stt)} · LLM ${eur(cost.llm)} · TTS ${eur(cost.tts)} — geschätzt aus dem Transkript`}>
              Kosten: ~{eur(cost.total)}
            </span>
            {conv.use_case && <span>Use-Case: {conv.use_case}</span>}
            {(conv.topics ?? []).map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
          {conv.summary && <p className="summary-block">{conv.summary}</p>}
        </div>
        <div className="detail-actions">
          <button className={`btn ${conv.flagged ? 'danger' : 'ghost'}`} onClick={toggleFlag}>
            {conv.flagged ? '⚑ Flag entfernen' : '⚑ Als problematisch flaggen'}
          </button>
          <button className="btn danger" onClick={deleteConversation} disabled={deleting}>
            {deleting ? 'Löscht …' : '🗑 Dialog löschen'}
          </button>
        </div>
      </div>

      {conv.flagged && conv.flag_reason && (
        <div className="banner warn">
          <strong>{conv.auto_flagged ? 'Automatisch geflaggt' : 'Geflaggt'}:</strong> {conv.flag_reason}
        </div>
      )}

      <div className="grid-detail">
        <section className="panel transcript">
          <h2>Transkript <span className="muted">(anonymisiert)</span></h2>
          {messages.length ? (
            <div className="chat">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.role}`}>
                  <div className="who">{m.role === 'user' ? 'Kind' : 'Buddly'}</div>
                  <div className="text">{m.content}</div>
                </div>
              ))}
            </div>
          ) : <p className="muted">Kein Transkript gespeichert.</p>}
        </section>

        <section className="panel">
          <h2>Kommentare</h2>
          <div className="comments">
            {comments.map((c) => (
              <div key={c.id} className="comment">
                <div className="comment-head">
                  <span className="muted">{fmtDateTime(c.created_at)}</span>
                  {c.author_id === userId && (
                    <button className="link-btn" onClick={() => deleteComment(c.id)}>löschen</button>
                  )}
                </div>
                <p>{c.comment}</p>
              </div>
            ))}
            {!comments.length && <p className="muted">Noch keine Kommentare.</p>}
          </div>
          <form className="comment-form" onSubmit={addComment}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="Beobachtung / pädagogische Notiz …" rows={3} />
            <button className="btn" type="submit" disabled={saving || !draft.trim()}>
              {saving ? 'Speichern …' : 'Kommentar hinzufügen'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
