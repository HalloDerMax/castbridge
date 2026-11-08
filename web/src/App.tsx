import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useI18n } from './i18n';
import { useSession } from './lib/session';
import { LiveProvider } from './lib/live';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { WizardPage } from './pages/Wizard';
import { DashboardPage } from './pages/Dashboard';
import { ChatPage } from './pages/Chat';
import { OverlayEditorPage } from './pages/OverlayEditor';
import { OverlayPage } from './pages/Overlay';
import { StatsPage } from './pages/Stats';
import { SettingsPage } from './pages/Settings';
import { AdminPage } from './pages/Admin';

function Loading(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="center-page">
      <div className="row">
        <span className="spin" />
        <span className="muted">{t('common.loading')}</span>
      </div>
    </div>
  );
}

function Protected({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }): JSX.Element {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (adminOnly && !user.isAdmin) return <Navigate to="/dashboard" replace />;
  if (!user.wizardDone && location.pathname !== '/einrichtung') return <Navigate to="/einrichtung" replace />;

  return (
    <LiveProvider enabled>
      <Layout>{children}</Layout>
    </LiveProvider>
  );
}

export function App(): JSX.Element {
  return (
    <Routes>
      {/* Overlay läuft ohne Anmeldung, nur mit Token, und ohne Gerüst. */}
      <Route path="/overlay/:token" element={<OverlayPage />} />

      <Route path="/login" element={<LoginPage />} />
      <Route path="/einladung/:token" element={<AcceptInvitePage />} />

      <Route
        path="/einrichtung"
        element={
          <Protected>
            <WizardPage />
          </Protected>
        }
      />
      <Route
        path="/dashboard"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      <Route
        path="/chat"
        element={
          <Protected>
            <ChatPage />
          </Protected>
        }
      />
      <Route
        path="/overlay-editor"
        element={
          <Protected>
            <OverlayEditorPage />
          </Protected>
        }
      />
      <Route
        path="/statistik"
        element={
          <Protected>
            <StatsPage />
          </Protected>
        }
      />
      <Route
        path="/einstellungen"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />
      <Route
        path="/admin"
        element={
          <Protected adminOnly>
            <AdminPage />
          </Protected>
        }
      />

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
