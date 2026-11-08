import { useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import type { ObsInfo } from '../lib/types';
import { CopyField } from './CopyField';

interface Props {
  obs: ObsInfo;
  onRotated(next: { ingestKey: string; rtmpUrl: string }): void;
  showSrt?: boolean;
}

export function ObsSetup({ obs, onRotated, showSrt = true }: Props): JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const rotate = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.post<{ ingestKey: string; rtmpUrl: string }>('/api/settings/ingest-key/rotate');
      onRotated(res);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>{t('obs.title')}</h2>
      </div>
      <p>{t('obs.explain')}</p>

      <CopyField label={t('obs.server')} value={obs.rtmpUrl} />
      <CopyField label={t('obs.key')} value={obs.streamKey} hint={t('obs.keySecret')} secret />

      {showSrt ? (
        <details style={{ marginBottom: 12 }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            {t('obs.srt')}
          </summary>
          <div style={{ marginTop: 8 }}>
            <CopyField label="SRT URL" value={obs.srtUrl} />
          </div>
        </details>
      ) : null}

      <div className="sep" />

      <h3>{t('obs.recommended')}</h3>
      <dl className="kv">
        <dt>{t('obs.bitrate')}</dt>
        <dd>{obs.recommendedBitrateKbps !== null ? `${obs.recommendedBitrateKbps} kbps` : '–'}</dd>
        <dt>{t('obs.audioBitrate')}</dt>
        <dd>160 kbps</dd>
        <dt>{t('obs.keyframe')}</dt>
        <dd>{obs.keyframeIntervalSec} s</dd>
        <dt>{t('obs.rateControl')}</dt>
        <dd>CBR</dd>
        <dt>{t('obs.codec')}</dt>
        <dd>H.264</dd>
      </dl>

      <div className="sep" />

      {confirming ? (
        <div className="notice warn">
          <div>{t('obs.rotateWarn')}</div>
          <div className="row mt">
            <button className="danger" onClick={() => void rotate()} disabled={busy}>
              {busy ? <span className="spin" /> : null}
              {t('obs.rotateKey')}
            </button>
            <button onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <button className="ghost sm" onClick={() => setConfirming(true)}>
          {t('obs.rotateKey')}
        </button>
      )}
    </div>
  );
}
