import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n, type Language } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { fmtDate } from '../lib/format';
import type { PublicUser } from '../lib/types';
import { BrandMark } from '../components/icons';

export function AcceptInvitePage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const { t, lang, setLang } = useI18n();
  const { setUser } = useSession();
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [note, setNote] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await api.get<{ valid: boolean; note: string; expiresAt: string }>(
          `/api/invites/${encodeURIComponent(token ?? '')}`,
        );
        if (!active) return;
        setValid(res.valid);
        setNote(res.note ?? '');
        setExpiresAt(res.expiresAt ?? null);
      } catch {
        if (active) setValid(false);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: PublicUser }>(`/api/invites/${encodeURIComponent(token ?? '')}/accept`, {
        email,
        password,
        displayName,
        language: lang,
      });
      setUser(res.user);
      navigate('/einrichtung', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'email_taken') setError(t('invite.emailTaken'));
        else if (err.code === 'invite_already_used') setError(t('invite.used'));
        else if (err.code === 'password_too_short') setError(t('err.password_too_short'));
        else if (err.code === 'invite_invalid') setError(t('invite.invalid'));
        else setError(t('common.error'));
      } else {
        setError(t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  if (checking) return <div className="center-page" />;

  return (
    <div className="center-page">
      <div className="card">
        <div className="row mb" style={{ gap: 10 }}>
          <span style={{ width: 32, height: 32, display: 'block' }}>
            <BrandMark />
          </span>
          <h1 style={{ margin: 0 }}>{t('invite.title')}</h1>
        </div>

        {!valid ? (
          <>
            <div className="notice err">{t('invite.invalid')}</div>
            <button className="mt" onClick={() => navigate('/login')}>
              {t('login.submit')}
            </button>
          </>
        ) : (
          <>
            <p>{t('invite.intro')}</p>
            {note ? <div className="notice info small mb">{note}</div> : null}
            {expiresAt ? (
              <div className="hint mb">{t('invite.expiresAt', { date: fmtDate(expiresAt, lang) })}</div>
            ) : null}

            <form onSubmit={(e) => void submit(e)}>
              <label className="field">
                <span className="label">{t('login.email')}</span>
                <input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">
                  {t('invite.displayName')} <span className="muted small">({t('common.optional')})</span>
                </span>
                <input type="text" value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('login.password')}</span>
                <input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="hint">{t('invite.passwordHint')}</div>
              </label>
              <label className="field">
                <span className="label">{t('login.language')}</span>
                <select value={lang} onChange={(e) => setLang(e.target.value as Language)}>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </label>

              {error ? <div className="notice err mb">{error}</div> : null}

              <button className="primary big" type="submit" disabled={busy}>
                {busy ? <span className="spin" /> : null}
                {t('invite.submit')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
