import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useI18n, type Language } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import type { PublicUser } from '../lib/types';
import { BrandMark } from '../components/icons';

export function LoginPage(): JSX.Element {
  const { t, lang, setLang } = useI18n();
  const { user, setUser, loading } = useSession();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="center-page" />;
  if (user) return <Navigate to={user.wizardDone ? '/dashboard' : '/einrichtung'} replace />;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: PublicUser }>('/api/auth/login', { email, password });
      setUser(res.user);
      navigate(res.user.wizardDone ? '/dashboard' : '/einrichtung', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'account_locked') {
          setError(t('login.locked', { n: Number(err.extra.retryAfterSec ?? 900) }));
        } else if (err.code === 'account_blocked') {
          setError(t('login.blocked'));
        } else {
          setError(t('login.failed'));
        }
      } else {
        setError(t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <div className="card">
        <div className="row mb" style={{ gap: 10 }}>
          <span style={{ width: 32, height: 32, display: 'block' }}>
            <BrandMark />
          </span>
          <div>
            <h1 style={{ margin: 0 }}>{t('app.name')}</h1>
            <div className="small muted">{t('app.tagline')}</div>
          </div>
        </div>

        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span className="label">{t('login.email')}</span>
            <input
              type="email"
              value={email}
              autoComplete="username"
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">{t('login.password')}</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? <div className="notice err mb">{error}</div> : null}

          <button className="primary big" type="submit" disabled={busy}>
            {busy ? <span className="spin" /> : null}
            {t('login.submit')}
          </button>
        </form>

        <div className="sep" />

        <label className="field" style={{ marginBottom: 0 }}>
          <span className="label">{t('login.language')}</span>
          <select value={lang} onChange={(e) => setLang(e.target.value as Language)}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </label>

        <p className="hint" style={{ marginTop: 14 }}>
          {t('login.noRegistration')}
        </p>
      </div>
    </div>
  );
}
