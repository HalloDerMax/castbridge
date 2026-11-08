import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { ObsInfo, PlatformInfo } from '../lib/types';
import { PlatformConnect } from '../components/PlatformConnect';
import { ObsSetup } from '../components/ObsSetup';
import { SpeedTest } from '../components/SpeedTest';
import { CopyField } from '../components/CopyField';
import { Check } from '../components/icons';

const STEPS = ['wizard.step1', 'wizard.step2', 'wizard.step3', 'wizard.step4'] as const;

export function WizardPage(): JSX.Element {
  const { t } = useI18n();
  const { reload } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [step, setStep] = useState(() => {
    // Nach einem OAuth-Rücksprung wieder bei Schritt 2 landen.
    return params.get('connect') ? 1 : 0;
  });
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [obs, setObs] = useState<ObsInfo | null>(null);
  const [overlayUrl, setOverlayUrl] = useState('');
  const [speed, setSpeed] = useState<{ mbps: number; recommendedKbps: number; at: string } | null>(null);
  const [maxTwitch, setMaxTwitch] = useState(6000);
  const [finishing, setFinishing] = useState(false);

  const load = useCallback(async () => {
    const [p, o, ov, s] = await Promise.all([
      api.get<{ platforms: PlatformInfo[] }>('/api/platforms'),
      api.get<ObsInfo>('/api/stream/obs'),
      api.get<{ url: string }>('/api/overlay/settings'),
      api.get<{
        speedtest: { mbps: number; recommendedKbps: number; at: string } | null;
        limits: { maxBitrateTwitch: number };
      }>('/api/settings'),
    ]);
    setPlatforms(p.platforms);
    setObs(o);
    setOverlayUrl(ov.url);
    setSpeed(s.speedtest);
    setMaxTwitch(s.limits.maxBitrateTwitch);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = async (): Promise<void> => {
    setFinishing(true);
    try {
      await api.post('/api/settings/wizard-done');
      await reload();
      navigate('/dashboard', { replace: true });
    } finally {
      setFinishing(false);
    }
  };

  const connectedCount = platforms.filter((p) => p.connected).length;
  const stepDone = [speed !== null, connectedCount > 0, obs !== null, overlayUrl !== ''];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('wizard.title')}</h1>
          <p style={{ marginBottom: 0 }}>{t('wizard.intro')}</p>
        </div>
      </div>

      <div className="steps">
        {STEPS.map((key, i) => (
          <button
            key={key}
            className={`step${i === step ? ' active' : ''}${stepDone[i] && i !== step ? ' done' : ''}`}
            onClick={() => setStep(i)}
            style={{ textAlign: 'left', minHeight: 0 }}
          >
            <b>
              {stepDone[i] ? <Check size={12} /> : `${i + 1}.`} {t(key)}
            </b>
          </button>
        ))}
      </div>

      {step === 0 ? (
        <div className="dash">
          <SpeedTest
            last={speed}
            maxTwitch={maxTwitch}
            onDone={(res) => {
              setSpeed({ mbps: res.mbps, recommendedKbps: res.recommendedKbps, at: new Date().toISOString() });
              if (obs) setObs({ ...obs, recommendedBitrateKbps: res.recommendedKbps });
            }}
          />
          <div className="card">
            <h2>{t('speed.title')}</h2>
            <p>{t('speed.explain')}</p>
            <div className="hint">{t('settings.bitrateHint')}</div>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="grid cols-3">
          {platforms.map((p) => (
            <PlatformConnect key={p.platform} info={p} onChanged={() => void load()} />
          ))}
        </div>
      ) : null}

      {step === 2 && obs ? (
        <div className="dash">
          <ObsSetup
            obs={obs}
            onRotated={(next) => setObs({ ...obs, streamKey: next.ingestKey, rtmpUrl: next.rtmpUrl })}
          />
          <div className="card">
            <h2>{t('obs.recommended')}</h2>
            <p>{t('obs.explain')}</p>
            <div className="notice info small">{t('settings.bitrateHint')}</div>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="dash">
          <div className="card">
            <h2>{t('overlay.title')}</h2>
            <CopyField label={t('overlay.url')} value={overlayUrl} hint={t('overlay.urlHint')} secret />
          </div>
          <div className="card">
            <h2>{t('wizard.done')}</h2>
            <p>{t('wizard.doneHint')}</p>
            <button className="primary big" onClick={() => void finish()} disabled={finishing}>
              {finishing ? <span className="spin" /> : null}
              {t('wizard.done')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="row mt">
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          {t('common.back')}
        </button>
        {step < STEPS.length - 1 ? (
          <>
            <button className="primary" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              {t('common.next')}
            </button>
            <button className="ghost" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              {t('wizard.skip')}
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => void finish()} disabled={finishing}>
            {t('common.finish')}
          </button>
        )}
      </div>
    </>
  );
}
