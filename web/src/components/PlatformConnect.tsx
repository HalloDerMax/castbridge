import { useState } from 'react';
import { useI18n } from '../i18n';
import { ApiError, api } from '../lib/api';
import { PLATFORM_NAME, type PlatformInfo } from '../lib/types';
import { Check, Cross, PlatformIcon } from './icons';

interface Props {
  info: PlatformInfo;
  onChanged(): void;
}

function Cap({ ok, label, note }: { ok: boolean; label: string; note?: string }): JSX.Element {
  return (
    <div className="row small" style={{ gap: 6, marginBottom: 3 }}>
      <span style={{ color: ok ? 'var(--ok)' : 'var(--text-faint)', display: 'flex' }}>
        {ok ? <Check size={13} /> : <Cross size={12} />}
      </span>
      <span style={{ color: ok ? 'var(--text-dim)' : 'var(--text-faint)' }}>
        {label}
        {note ? <span className="muted"> — {note}</span> : null}
      </span>
    </div>
  );
}

export function PlatformConnect({ info, onChanged }: Props): JSX.Element {
  const { t } = useI18n();
  const name = PLATFORM_NAME[info.platform];

  const [manualOpen, setManualOpen] = useState(false);
  const [streamKey, setStreamKey] = useState('');
  const [ingestUrl, setIngestUrl] = useState(info.manual.ingestUrl);
  const [channelName, setChannelName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  const connectOauth = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<{ url: string }>(`/api/platforms/${info.platform}/connect`);
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof ApiError ? t(`err.${err.code}`) : t('common.error'));
      setBusy(false);
    }
  };

  const saveManual = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/platforms/${info.platform}/manual`, { streamKey, ingestUrl, channelName });
      setStreamKey('');
      setManualOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? t(`err.${err.code}`) : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.del(`/api/platforms/${info.platform}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const cap = info.capabilities;

  return (
    <div className={`card platform-card ${info.platform}`}>
      <div className="card-head">
        <div className="row">
          <PlatformIcon platform={info.platform} size={20} />
          <h2 style={{ margin: 0 }}>{name}</h2>
        </div>
        <span className={`pill ${info.connected ? 'ok' : ''}`}>
          {info.connected ? t('platforms.connected') : t('platforms.notConnected')}
        </span>
      </div>

      {info.connected ? (
        <>
          <dl className="kv mb">
            <dt>{t('platforms.channelName')}</dt>
            <dd>{info.channelName || '–'}</dd>
            <dt>{t('common.platform')}</dt>
            <dd>{info.connectedVia === 'oauth' ? t('platforms.viaOauth') : t('platforms.viaManual')}</dd>
          </dl>
          {info.lastError ? (
            <div className="notice err small mb" style={{ wordBreak: 'break-word' }}>
              {info.lastError}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="small muted" style={{ marginBottom: 6 }}>
        {t('platforms.capabilities')}
      </div>
      <Cap ok={cap.setTitle && info.connectedVia === 'oauth'} label={t('platforms.capTitle')} />
      <Cap
        ok={cap.setCategory && cap.categoryMode !== 'none' && info.connectedVia === 'oauth'}
        label={t('platforms.capCategory')}
        note={cap.categoryMode === 'gaming_only' ? t('platforms.capCategoryGamingOnly') : undefined}
      />
      <Cap ok={cap.chat && (info.platform === 'twitch' || info.connectedVia === 'oauth')} label={t('platforms.capChat')} />
      <Cap ok={cap.viewers && info.connectedVia === 'oauth'} label={t('platforms.capViewers')} />
      <Cap ok={info.hasStreamKey} label={t('platforms.capKey')} />

      {info.platform === 'youtube' ? <div className="notice info small mt">{t('platforms.youtubeWarning')}</div> : null}
      {info.platform === 'kick' ? <div className="notice info small mt">{t('platforms.kickKeyUnknown')}</div> : null}
      {!info.oauthAvailable ? <div className="notice warn small mt">{t('platforms.oauthMissing')}</div> : null}

      {error ? <div className="notice err small mt">{error}</div> : null}

      <div className="row mt">
        {info.oauthAvailable ? (
          <button className="primary" onClick={() => void connectOauth()} disabled={busy}>
            {busy ? <span className="spin" /> : null}
            {t('platforms.connect', { name })}
          </button>
        ) : null}
        {info.connected ? (
          <button className="danger" onClick={() => void disconnect()} disabled={busy}>
            {t('platforms.disconnect')}
          </button>
        ) : null}
      </div>

      <button className="ghost sm mt" onClick={() => setManualOpen((v) => !v)}>
        {t('platforms.manualToggle')} {manualOpen ? '−' : '+'}
      </button>

      {manualOpen ? (
        <div style={{ marginTop: 8 }}>
          <button className="ghost sm" onClick={() => setShowSteps((v) => !v)}>
            {t('platforms.whereToFind')} {showSteps ? '−' : '+'}
          </button>
          {showSteps ? (
            <div className="notice small mt">
              <ol style={{ margin: '0 0 6px 18px', padding: 0 }}>
                {info.manual.steps.map((s) => (
                  <li key={s} style={{ marginBottom: 3 }}>
                    {s}
                  </li>
                ))}
              </ol>
              <a href={info.manual.url} target="_blank" rel="noreferrer noopener">
                {info.manual.url}
              </a>
            </div>
          ) : null}

          <label className="field mt">
            <span className="label">{t('platforms.ingestUrl')}</span>
            <input type="text" value={ingestUrl} onChange={(e) => setIngestUrl(e.target.value)} spellCheck={false} />
            {info.platform === 'kick' ? <div className="hint">{t('platforms.kickRtmps')}</div> : null}
          </label>
          <label className="field">
            <span className="label">{t('platforms.streamKey')}</span>
            <input
              type="password"
              value={streamKey}
              onChange={(e) => setStreamKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="label">
              {t('platforms.channelName')} <span className="muted small">({t('common.optional')})</span>
            </span>
            <input type="text" value={channelName} onChange={(e) => setChannelName(e.target.value)} />
          </label>
          <button className="primary" onClick={() => void saveManual()} disabled={busy || streamKey.length < 4}>
            {t('common.save')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
