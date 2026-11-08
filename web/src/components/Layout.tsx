import { NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useI18n, type Language } from '../i18n';
import { useSession } from '../lib/session';
import { useLive } from '../lib/live';
import { api } from '../lib/api';
import { BrandMark, Gear } from './icons';
import { Toasts } from './Toasts';
import type { PlatformId } from '../lib/types';

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const { t, lang, setLang } = useI18n();
  const { user, logout } = useSession();
  const { connected } = useLive();
  const navigate = useNavigate();

  const changeLanguage = async (next: Language): Promise<void> => {
    setLang(next);
    try {
      await api.post('/api/auth/language', { language: next });
    } catch {
      /* Anzeige stimmt trotzdem */
    }
  };

  const retry = (platform: PlatformId): void => {
    void api.post('/api/stream/retry', { platform });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/dashboard" className="brand">
          <BrandMark />
          <span>{t('app.name')}</span>
        </NavLink>

        <nav className="nav">
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.dashboard')}
          </NavLink>
          <NavLink to="/chat" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.chat')}
          </NavLink>
          <NavLink to="/overlay-editor" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.overlay')}
          </NavLink>
          <NavLink to="/statistik" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.stats')}
          </NavLink>
          {user?.isAdmin ? (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
              {t('nav.admin')}
            </NavLink>
          ) : null}
        </nav>

        <div className="topbar-right">
          <span
            className={`dot ${connected ? 'live' : 'err'}`}
            title={connected ? 'verbunden' : 'getrennt'}
            aria-hidden="true"
          />
          <select
            value={lang}
            onChange={(e) => void changeLanguage(e.target.value as Language)}
            aria-label={t('settings.language')}
            style={{ width: 'auto', minHeight: 34, padding: '4px 8px' }}
          >
            <option value="de">DE</option>
            <option value="en">EN</option>
          </select>
          <NavLink
            to="/einstellungen"
            className="btn"
            title={t('nav.settings')}
            style={{ padding: '7px 9px', minHeight: 34 }}
          >
            <Gear />
          </NavLink>
          <button
            className="ghost nowrap"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            {t('nav.logout')}
          </button>
        </div>
      </header>

      <main>{children}</main>
      <Toasts onRetry={retry} />
    </div>
  );
}
