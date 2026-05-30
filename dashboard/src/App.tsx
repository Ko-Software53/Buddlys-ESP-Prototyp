import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from './supabase';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Conversations from './pages/Conversations';
import ConversationDetail from './pages/ConversationDetail';

type Role = 'parent' | 'educator' | 'admin' | null;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRole(null); return; }
    supabase
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setRole((data?.role as Role) ?? 'parent'));
  }, [session]);

  if (!supabaseConfigured) {
    return (
      <div className="centered">
        <div className="card error">
          <h2>Konfiguration fehlt</h2>
          <p>Bitte <code>.env.example</code> nach <code>.env.local</code> kopieren und die
            Supabase-URL + Anon-Key eintragen.</p>
        </div>
      </div>
    );
  }

  if (loading) return <div className="centered"><p className="muted">Lädt …</p></div>;
  if (!session) return <Login />;

  const isEducator = role === 'educator' || role === 'admin';
  if (role && !isEducator) {
    return (
      <div className="centered">
        <div className="card error">
          <h2>Kein Zugriff</h2>
          <p>Dein Account ({session.user.email}) hat keine Pädagoginnen-Rolle.
            Bitte beim Buddly-Team eine Freischaltung anfragen.</p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Abmelden</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/logo-buddlys-signet-blue.png" alt="Buddlys" />
          <span className="sep">·</span>
          <span className="sub">Dashboard</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Übersicht</NavLink>
          <NavLink to="/conversations">Dialoge</NavLink>
        </nav>
        <div className="account">
          <span className="muted">{session.user.email}</span>
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Abmelden</button>
        </div>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/conversations/:id" element={<ConversationDetail userId={session.user.id} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
