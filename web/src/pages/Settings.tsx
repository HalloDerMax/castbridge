import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n, type Language } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { PLATFORM_NAME, type ObsInfo, type PlatformInfo, type PublicUser, type UserSettings } from '../lib/types';
import { PlatformConnect } from '../components/PlatformConnect';
import { ObsSetup } from '../components/ObsSetup';
import { SpeedTest } from '../components/SpeedTest';

interface SettingsResponse {
  user: PublicUser;
  settings: UserSettings;
  standby: { kind: string; name: string; uploadedAt: string | null; isDefault: boolean };
  speedtest: { mbps: number; recommendedKbps: number; at: string } | null;
  limits: { maxBitrateTwitch: number };
}

export function SettingsPage(): JSX.Element {
  const { t, lang, setLang } = useI18n();
  const { reload } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [data, setData] = useState<SettingsResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [obs, setObs] = useState<ObsInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, p, o] = await Promise.all([
      api.get<SettingsResponse>('/api/settings'),
      api.get<{ platforms: PlatformInfo[] }>('/api/platforms'),
      api.get<ObsInfo>('/api/stream/obs'),
    ]);
    setData(s);
    setPlatforms(p.platforms);
    setObs(o);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectInfo = (() => {
    const platform = params.get('connect');
    if (!platform) return null;
    const ok = params.get('ok') === '1';
    const error = params.get('error');
    const name = PLATFORM_NAME[platform as keyof typeof PLATFORM_NAME] ?? platform;
    return ok
      ? { level: 'ok' as const, text: t('platforms.connectOk', { name }) }
      : { level: 'err' as const, text: t('platforms.connectError', { code: error ?? '?' }) };
  })();

  const patchSettings = async (patch: Partial<UserSettings>): Promise<void> => {
    if (!data) return;
    const next = { ...data.settings, ...patch };
    setData({ ...data, settings: next });
    await api.post('/api/settings', {
      hideBots: next.hideBots,
      standbyEnabled: next.standbyEnabled,
      standbyGraceSec: next.standbyGraceSec,
      youtubePrivacy: next.youtubePrivacy,
      targetBitrateKbps: next.targetBitrateKbps,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
    await reload();
  };

  const upload = async (file: File): Promise<void> => {
    setUploadMsg(null);
    try {
      await api.upload('/api/settings/standby', file);
      setUploadMsg(t('settings.uploadOk'));
      await load();
    } catch (err) {
      setUploadMsg(
        t('settings.uploadFailed', { code: err instanceof ApiError ? t(`err.${err.code}`) : t('common.error') }),
      );
    }
  };

  const changePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPwMsg(null);
    try {
      await api.post('/api/auth/password', { current: pwCurrent, next: pwNext });
      setPwMsg(t('settings.passwordChanged'));
      window.setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wrong_password') setPwMsg(t('settings.passwordWrong'));
      else if (err instanceof ApiError && err.code === 'password_too_short') setPwMsg(t('err.password_too_short'));
      else setPwMsg(t('common.error'));
    }
  };

  const changeLanguage = async (next: Language): Promise<void> => {
    setLang(next);
    await api.post('/api/auth/language', { language: next });
  };

  if (!data || !obs) return <div className="card">{t('common.loading')}</div>;

  return (
    <>
      <div className="page-head">
        <h1>{t('settings.title')}</h1>
        {saved ? <span className="pill ok">{t('common.saved')}</span> : null}
      </div>

      {connectInfo ? <div className={`notice ${connectInfo.level} mb`}>{connectInfo.text}</div> : null}

      <h2 className="mb">{t('platforms.title')}</h2>
      <div className="grid cols-3">
        {platforms.map((p) => (
          <PlatformConnect key={p.platform} info={p} onChanged={() => void load()} />
        ))}
      </div>

      <div className="dash mt">
        <div>
          <ObsSetup
            obs={obs}
            onRotated={(next) => setObs({ ...obs, streamKey: next.ingestKey, rtmpUrl: next.rtmpUrl })}
          />

          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('settings.standby')}</h2>
            </div>
            <p>{t('settings.standbyHint')}</p>

            <label className="check">
              <input
                type="checkbox"
                checked={data.settings.standbyEnabled}
                onChange={(e) => void patchSettings({ standbyEnabled: e.target.checked })}
              />
              <div>
                <span className="label">{t('settings.standbyEnabled')}</span>
              </div>
            </label>

            <div className="notice small mb">
              {data.standby.isDefault
                ? t('settings.standbyDefault')
                : t('settings.standbyCurrent', { name: data.standby.name })}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.bmp,.mp4,.mov,.mkv,.webm"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <div className="row">
              <button className="primary" onClick={() => fileRef.current?.click()}>
                {t('settings.standbyUpload')}
              </button>
              {!data.standby.isDefault ? (
                <button
                  className="danger"
                  onClick={() => {
                    void api.del('/api/settings/standby').then(() => load());
                  }}
                >
                  {t('settings.standbyRemove')}
                </button>
              ) : null}
            </div>
            <div className="hint">{t('settings.standbyFormats')}</div>
            <div className="hint">{t('settings.standbyPrepared')}</div>
            <div className="notice warn small mt">{t('settings.standbyNoYoutube')}</div>

            {uploadMsg ? <div className="notice mt small">{uploadMsg}</div> : null}
          </div>
        </div>

        <div>
          <SpeedTest
            last={data.speedtest}
            maxTwitch={data.limits.maxBitrateTwitch}
            onDone={(res) => {
              setData({
                ...data,
                settings: { ...data.settings, targetBitrateKbps: res.recommendedKbps },
                speedtest: { mbps: res.mbps, recommendedKbps: res.recommendedKbps, at: new Date().toISOString() },
              });
              setObs({ ...obs, recommendedBitrateKbps: res.recommendedKbps });
            }}
          />

          <div className="card">
            <h2>{t('settings.general')}</h2>

            <label className="field">
              <span className="label">{t('settings.language')}</span>
              <select value={lang} onChange={(e) => void changeLanguage(e.target.value as Language)}>
                <option value="de">Deutsch</option>
                <option value="en">English</option>
              </select>
            </label>

            <label className="field">
              <span className="label">{t('settings.bitrate')}</span>
              <input
                type="number"
                min={500}
                max={30000}
                step={250}
                value={data.settings.targetBitrateKbps ?? ''}
                onChange={(e) =>
                  setData({
                    ...data,
                    settings: {
                      ...data.settings,
                      targetBitrateKbps: e.target.value === '' ? null : Number(e.target.value),
                    },
                  })
                }
                onBlur={() => void patchSettings({ targetBitrateKbps: data.settings.targetBitrateKbps })}
              />
              <div className="hint">{t('settings.bitrateHint')}</div>
            </label>

            <label className="field">
              <span className="label">{t('settings.youtubePrivacy')}</span>
              <select
                value={data.settings.youtubePrivacy}
                onChange={(e) =>
                  void patchSettings({ youtubePrivacy: e.target.value as UserSettings['youtubePrivacy'] })
                }
              >
                <option value="public">{t('settings.privacyPublic')}</option>
                <option value="unlisted">{t('settings.privacyUnlisted')}</option>
                <option value="private">{t('settings.privacyPrivate')}</option>
              </select>
            </label>

            <label className="check" style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={data.settings.hideBots}
                onChange={(e) => void patchSettings({ hideBots: e.target.checked })}
              />
              <div>
                <span className="label">{t('chat.hideBots')}</span>
                <div className="hint">{t('chat.hideBotsHint')}</div>
              </div>
            </label>
          </div>

          <div className="card">
            <h2>{t('settings.password')}</h2>
            <form onSubmit={(e) => void changePassword(e)}>
              <label className="field">
                <span className="label">{t('settings.passwordCurrent')}</span>
                <input
                  type="password"
                  value={pwCurrent}
                  autoComplete="current-password"
                  onChange={(e) => setPwCurrent(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span className="label">{t('settings.passwordNew')}</span>
                <input
                  type="password"
                  value={pwNext}
                  autoComplete="new-password"
                  minLength={10}
                  onChange={(e) => setPwNext(e.target.value)}
                  required
                />
                <div className="hint">{t('invite.passwordHint')}</div>
              </label>
              {pwMsg ? <div className="notice small mb">{pwMsg}</div> : null}
              <button className="primary" type="submit">
                {t('common.save')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
