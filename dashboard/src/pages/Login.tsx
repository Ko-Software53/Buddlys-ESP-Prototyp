import { useState } from 'react';
import { supabase } from '../supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  };

  return (
    <div className="centered">
      <form className="card login" onSubmit={submit}>
        <div className="logo">
          <img src="/logo-buddlys-blue.png" alt="Buddlys" />
        </div>
        <p className="subtitle">Pädagoginnen-Dashboard</p>
        <label>
          E-Mail
          <input type="email" value={email} required autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Passwort
          <input type="password" value={password} required autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Anmelden …' : 'Anmelden'}
        </button>
      </form>
    </div>
  );
}
