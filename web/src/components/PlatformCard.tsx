import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { elapsedSince, fmtNumber } from '../lib/format';
import { PLATFORM_NAME, type PlatformStatus } from '../lib/types';
import { PlatformIcon } from './icons';

interface Props {
  status: PlatformStatus;
  signalActive: boolean;
  busy: boolean;
  onGoLive(): void;
  onStop(): void;
  onRetry(): void;
}

export function PlatformCard({ status, signalActive, busy, onGoLive, onStop, onRetry }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const live = status.state === 'live' || status.state === 'standby';
  const working = status.state === 'starting' || status.state === 'reconnecting' || status.state === 'stopping';

  const dotClass =
    status.state === 'live'
      ? 'live'
      : status.state === 'standby' || status.state === 'reconnecting' || status.state === 'starting'
        ? 'warn'
        : status.state === 'error'
          ? 'err'
          : '';

  return (
    <div className={`card platform-card ${status.platform}`}>
      <div className="card-head">
        <div className="row">
          <PlatformIcon platform={status.platform} size={20} />
          <h2 style={{ margin: 0 }}>{PLATFORM_NAME[status.platform]}</h2>
        </div>
        <span className="row" style={{ gap: 6 }}>
          <span className={`dot ${dotClass}`} />
          <span className="small">{t(`state.${status.state}`)}</span>
        </span>
      </div>

      {!status.connected ? (
        <>
          <p className="small">{t('platforms.notConnected')}</p>
          <Link className="btn" to="/einstellungen">
            {t('platforms.connect', { name: PLATFORM_NAME[status.platform] })}
          </Link>
        </>
      ) : (
        <>
          <div className="row between mb">
            <div>
              <div className="metric">
                {status.capabilities.viewers || status.simulatedViewers > 0
                  ? fmtNumber(status.viewers, lang)
                  : '–'}
                <small>
                  {t('dash.viewersTotal')}
                  {status.simulatedViewers > 0 ? ` · ${t('dash.viewersOf', { n: status.simulatedViewers })}` : ''}
                </small>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="small muted">{status.channelName}</div>
              <div className="small muted">
                {status.connectedVia === 'oauth' ? t('platforms.viaOauth') : t('platforms.viaManual')}
              </div>
              {live && status.since ? <div className="small muted">{elapsedSince(status.since)}</div> : null}
            </div>
          </div>

          {status.simulatedViewers > 0 ? <div className="pill sim mb">{t('dash.simActive')}</div> : null}

          {status.state === 'reconnecting' ? (
            <div className="notice warn mb small">
              {t('toast.relay_reconnecting', {
                name: PLATFORM_NAME[status.platform],
                detail: `${status.attempt}/3`,
              })}
            </div>
          ) : null}

          {status.state === 'error' && status.lastError ? (
            <div className="notice err mb small" style={{ wordBreak: 'break-word' }}>
              {status.lastError}
            </div>
          ) : null}

          <div className="row">
            {live ? (
              <button className="danger" onClick={onStop} disabled={busy || working}>
                {t('dash.stopThis')}
              </button>
            ) : (
              <button className="primary" onClick={onGoLive} disabled={busy || working || !signalActive}>
                {working ? <span className="spin" /> : null}
                {t('dash.goLive')}
              </button>
            )}
            {status.state === 'error' || live ? (
              <button onClick={onRetry} disabled={busy || !signalActive}>
                {t('dash.reconnect')}
              </button>
            ) : null}
          </div>

          {!signalActive && !live ? <div className="hint">{t('err.no_signal')}</div> : null}
        </>
      )}
    </div>
  );
}
