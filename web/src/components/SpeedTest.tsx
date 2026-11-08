import { useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

export interface SpeedResult {
  mbps: number;
  recommendedKbps: number;
  cappedByTwitch: boolean;
  obs: {
    videoBitrateKbps: number;
    audioBitrateKbps: number;
    keyframeIntervalSec: number;
    encoderPreset: string;
    rateControl: string;
  };
}

interface Props {
  last: { mbps: number; recommendedKbps: number; at: string } | null;
  maxTwitch: number;
  onDone(result: SpeedResult): void;
}

export function SpeedTest({ last, maxTwitch, onDone }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SpeedResult | null>(null);
  const [error, setError] = useState(false);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(false);
    setProgress(0);
    try {
      const mbps = await api.speedtest(setProgress);
      const res = await api.post<SpeedResult>('/api/speedtest/result', { mbps });
      setResult(res);
      onDone(res);
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  };

  const shown = result ?? (last ? { ...last, cappedByTwitch: false, obs: null } : null);

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>{t('speed.title')}</h2>
      </div>
      <p>{t('speed.explain')}</p>

      {running ? (
        <>
          <div className="bar mb">
            <i style={{ width: `${progress}%` }} />
          </div>
          <div className="small muted">{t('speed.running')}</div>
        </>
      ) : (
        <button className="primary" onClick={() => void run()}>
          {shown ? t('speed.again') : t('speed.run')}
        </button>
      )}

      {error ? <div className="notice err mt">{t('speed.failed')}</div> : null}

      {shown ? (
        <div className="notice ok mt">
          <div>
            <strong>{t('speed.result', { mbps: shown.mbps })}</strong>
          </div>
          <div>{t('speed.recommend', { kbps: shown.recommendedKbps })}</div>
          {result?.cappedByTwitch ? <div className="hint">{t('speed.cappedByTwitch', { max: maxTwitch })}</div> : null}
          {last && !result ? <div className="hint">{t('speed.lastRun', { date: fmtDateTime(last.at, lang) })}</div> : null}
        </div>
      ) : null}

      {result ? (
        <dl className="kv mt">
          <dt>{t('obs.bitrate')}</dt>
          <dd>{result.obs.videoBitrateKbps} kbps</dd>
          <dt>{t('obs.audioBitrate')}</dt>
          <dd>{result.obs.audioBitrateKbps} kbps</dd>
          <dt>{t('obs.keyframe')}</dt>
          <dd>{result.obs.keyframeIntervalSec} s</dd>
          <dt>{t('obs.rateControl')}</dt>
          <dd>{result.obs.rateControl}</dd>
          <dt>{t('obs.encoder')}</dt>
          <dd>{result.obs.encoderPreset}</dd>
        </dl>
      ) : null}
    </div>
  );
}
