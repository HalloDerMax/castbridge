import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { fmtNumber, fmtSeconds } from '../lib/format';
import { PLATFORMS, PLATFORM_NAME, type PlatformId, type StreamState } from '../lib/types';
import { SignalPanel } from '../components/SignalPanel';
import { PlatformCard } from '../components/PlatformCard';
import { TitleEditor } from '../components/TitleEditor';
import { ChatView } from '../components/ChatView';

export function DashboardPage(): JSX.Element {
  const { t, lang } = useI18n();
  const { user } = useSession();
  const { signal, platforms, viewers, messages, preview, replacePlatforms, pushToast, anomalies } = useLive();

  const [state, setState] = useState<StreamState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDiag, setShowDiag] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<StreamState>('/api/stream/state');
      setState(res);
      replacePlatforms(res.platforms);
    } catch {
      /* die WebSocket-Verbindung liefert nach */
    }
  }, [replacePlatforms]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      void load();
    }
  };

  const goLive = (platform: PlatformId): Promise<void> =>
    act(async () => {
      const res = await api.post<{ platform: PlatformId; ok: boolean; code?: string }>('/api/stream/live', {
        platform,
      });
      if (!res.ok) {
        pushToast({
          level: 'error',
          code: 'generic_error',
          platform,
          detail: t(`err.${res.code ?? 'start_failed'}`),
        });
      }
    });

  const goLiveAll = (): Promise<void> =>
    act(async () => {
      const res = await api.post<{ results: { platform: PlatformId; ok: boolean; code?: string }[] }>(
        '/api/stream/live-all',
      );
      for (const r of res.results) {
        if (!r.ok) {
          pushToast({
            level: 'error',
            code: 'generic_error',
            platform: r.platform,
            detail: `${PLATFORM_NAME[r.platform]}: ${t(`err.${r.code ?? 'start_failed'}`)}`,
          });
        }
      }
    });

  const list = PLATFORMS.map((p) => platforms[p]).filter((p): p is NonNullable<typeof p> => p !== undefined);
  const anyLive = list.some((p) => p.state === 'live' || p.state === 'standby');
  const connectedCount = list.filter((p) => p.connected).length;
  const totalViewers = viewers.total > 0 ? viewers.total : list.reduce((sum, p) => sum + (p.viewers ?? 0), 0);
  const simulated = viewers.simulated > 0 ? viewers.simulated : list.reduce((s, p) => s + p.simulatedViewers, 0);
  const chat = state?.chat ?? { messagesPerMinute: 0, chatters: 0, perPlatform: {} };
  const diag = state?.diagnostics ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <div className="small muted">{user?.displayName}</div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => void goLiveAll()} disabled={busy || !signal.active || connectedCount === 0}>
            {busy ? <span className="spin" /> : null}
            {t('dash.goLiveAll')}
          </button>
          {anyLive ? (
            <button className="danger" onClick={() => void act(() => api.post('/api/stream/stop-all'))} disabled={busy}>
              {t('dash.stopAll')}
            </button>
          ) : null}
        </div>
      </div>

      {simulated > 0 ? (
        <div className="notice warn mb">
          <strong>{t('dash.simActive')}</strong>
          <div className="small">{t('dash.simActiveHint')}</div>
        </div>
      ) : null}

      <div className="dash">
        <div>
          <SignalPanel signal={signal} preview={preview} previewAvailable={state?.preview.available ?? false} />

          <div className="grid cols-3 mt">
            {list.map((status) => (
              <PlatformCard
                key={status.platform}
                status={status}
                signalActive={signal.active}
                busy={busy}
                onGoLive={() => void goLive(status.platform)}
                onStop={() => void act(() => api.post('/api/stream/stop', { platform: status.platform }))}
                onRetry={() => void act(() => api.post('/api/stream/retry', { platform: status.platform }))}
              />
            ))}
          </div>

          {state ? (
            <TitleEditor
              platforms={list}
              initialShared={state.user.settings.sharedTitle}
              initialPer={state.user.settings.perPlatformTitles}
              initialCategory={state.user.settings.category}
            />
          ) : null}
        </div>

        <div>
          <div className="card">
            <div className="grid cols-2" style={{ gap: 10 }}>
              <div className="metric">
                {fmtNumber(totalViewers, lang)}
                <small>{t('dash.viewersTotal')}</small>
              </div>
              <div className="metric">
                {fmtNumber(chat.messagesPerMinute, lang)}
                <small>{t('dash.messagesPerMin')}</small>
              </div>
            </div>
            {simulated > 0 ? <div className="pill sim mt">{t('dash.viewersOf', { n: simulated })}</div> : null}
            <div className="sep" />
            <dl className="kv">
              {list
                .filter((p) => p.connected)
                .map((p) => (
                  <div key={p.platform} style={{ display: 'contents' }}>
                    <dt>{PLATFORM_NAME[p.platform]}</dt>
                    <dd>
                      {p.capabilities.viewers ? fmtNumber(p.viewers, lang) : '–'}
                      {p.simulatedViewers > 0 ? <span className="muted small"> (+{p.simulatedViewers})</span> : null}
                    </dd>
                  </div>
                ))}
              <dt>{t('dash.chatters')}</dt>
              <dd>{fmtNumber(chat.chatters, lang)}</dd>
            </dl>
          </div>

          {anomalies.length > 0 ? (
            <div className="card">
              <div className="card-head">
                <h2 style={{ margin: 0 }}>{t('anom.title')}</h2>
              </div>
              <p className="small">{t('anom.explain')}</p>
              {anomalies.slice(-5).reverse().map((a) => (
                <div key={a.id} className="notice warn small" style={{ marginBottom: 6 }}>
                  <strong>{t(`anom.${a.type}`)}</strong>
                  <div className="muted">
                    {new Date(a.at).toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB')} ·{' '}
                    {a.platform === 'all' ? t('common.all') : PLATFORM_NAME[a.platform as PlatformId]} ·{' '}
                    {t('anom.score')} {a.score.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('chat.title')}</h2>
              <span className="pill">{t('chat.readOnly')}</span>
            </div>
            <ChatView
              messages={messages}
              hideBots={user?.settings.hideBots ?? false}
              maxHeight="min(52vh, 480px)"
            />
          </div>

          <div className="card">
            <button className="ghost" onClick={() => setShowDiag((v) => !v)} style={{ width: '100%' }}>
              {t('dash.diagnostics')}
              <span className="spacer" />
              <span className="small muted">{showDiag ? '−' : '+'}</span>
            </button>
            {showDiag ? (
              <dl className="kv mt">
                <dt>{t('dash.diagOutputs')}</dt>
                <dd>{diag?.outputs ?? 0}</dd>
                <dt>{t('dash.diagSource')}</dt>
                <dd>{diag?.source ?? '–'}</dd>
                <dt>{t('dash.diagSwitches')}</dt>
                <dd>{diag?.switches ?? 0}</dd>
                <dt>{t('dash.diagRuntime')}</dt>
                <dd>{diag ? fmtSeconds(diag.timestampMs / 1000) : '–'}</dd>
              </dl>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
