import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { PLATFORM_NAME, type PlatformId, type SignalInfo } from '../lib/types';
import { elapsedSince } from '../lib/format';

interface Props {
  signal: SignalInfo;
  preview: { url: string; at: string } | null;
  previewAvailable: boolean;
}

export function SignalPanel({ signal, preview, previewAvailable }: Props): JSX.Element {
  const { t } = useI18n();
  const [, tick] = useState(0);

  // Die Altersangabe soll mitlaufen, auch wenn kein neues Bild kommt.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const standby = signal.source === 'standby';
  const state = !signal.active ? 'waiting' : standby ? 'standby' : 'ok';

  const imgUrl = preview?.url ?? '/api/stream/preview.jpg';
  const ageText = preview ? elapsedSince(preview.at) : null;

  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <span className={`dot ${state === 'ok' ? 'live' : state === 'standby' ? 'warn' : ''}`} />
          <h2 style={{ margin: 0 }}>
            {state === 'ok' ? t('dash.signalOk') : state === 'standby' ? t('dash.signalStandby') : t('dash.signalWaiting')}
          </h2>
        </div>
        {signal.since ? <span className="pill">{elapsedSince(signal.since)}</span> : null}
      </div>

      {state === 'waiting' ? (
        <p>{t('dash.signalWaitingHint')}</p>
      ) : (
        <dl className="kv mb">
          <dt>{t('dash.resolution')}</dt>
          <dd>{signal.width && signal.height ? `${signal.width} × ${signal.height}` : '–'}</dd>
          <dt>{t('dash.fps')}</dt>
          <dd>{signal.fps ?? '–'}</dd>
          <dt>{t('dash.bitrate')}</dt>
          <dd>{signal.bitrateKbps !== null ? `${signal.bitrateKbps} kbps` : '–'}</dd>
          <dt>{t('dash.codec')}</dt>
          <dd>
            {signal.videoCodec === '' ? '–' : signal.videoCodec.toUpperCase()}
            {signal.audioCodec === '' ? '' : ` / ${signal.audioCodec.toUpperCase()}`}
          </dd>
        </dl>
      )}

      {signal.warnings.length > 0 ? (
        <div className="notice warn mb">
          {dedupeWarnings(signal.warnings).map((w, i) => (
            <div key={i} style={{ marginBottom: i === signal.warnings.length - 1 ? 0 : 6 }}>
              {w.platforms.length > 0 ? <strong>{w.platforms.join(', ')}: </strong> : null}
              {t(`warn.${w.code}`, { value: String(w.value ?? ''), limit: String(w.limit ?? '') })}
            </div>
          ))}
        </div>
      ) : null}

      <div className="preview">
        {previewAvailable || preview ? (
          <img src={`${imgUrl}${imgUrl.includes('?') ? '&' : '?'}cb=${preview?.at ?? ''}`} alt={t('dash.preview')} />
        ) : (
          <div className="muted small" style={{ padding: 16, textAlign: 'center' }}>
            {t('dash.previewNone')}
          </div>
        )}
        <div className="badge">
          <span>{t('dash.previewNote')}</span>
          {ageText ? <span className="muted">{t('dash.previewLast', { ago: ageText })}</span> : null}
        </div>
      </div>

      {state === 'ok' && !standby ? <p className="small mt">{t('dash.notLiveYet')}</p> : null}
    </div>
  );
}

function dedupeWarnings(
  warnings: SignalInfo['warnings'],
): { code: string; value?: number | string; limit?: number | string; platforms: string[] }[] {
  const map = new Map<string, { code: string; value?: number | string; limit?: number | string; platforms: string[] }>();
  for (const w of warnings) {
    const key = `${w.code}|${w.value ?? ''}`;
    const entry = map.get(key) ?? { code: w.code, value: w.value, limit: w.limit, platforms: [] };
    if (w.platform) entry.platforms.push(PLATFORM_NAME[w.platform as PlatformId]);
    map.set(key, entry);
  }
  // Bei allen drei Plattformen die Aufzählung weglassen - das liest sich besser.
  return Array.from(map.values()).map((e) => (e.platforms.length === 3 ? { ...e, platforms: [] } : e));
}
