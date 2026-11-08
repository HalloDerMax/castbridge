import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import type { OverlaySettings } from '../lib/types';
import { CopyField } from '../components/CopyField';
import { OverlayRender, sampleMessages } from '../components/OverlayRender';

interface SettingsResponse {
  settings: OverlaySettings;
  url: string;
  token: string;
  fonts: string[];
}

export function OverlayEditorPage(): JSX.Element {
  const { t } = useI18n();
  const { messages } = useLive();

  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [url, setUrl] = useState('');
  const [fonts, setFonts] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [useReal, setUseReal] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get<SettingsResponse>('/api/overlay/settings');
      setSettings(res.settings);
      setUrl(res.url);
      setFonts(res.fonts);
    })();
  }, []);

  const samples = useMemo(() => sampleMessages(), []);
  const previewMessages = useReal && messages.length > 0 ? messages : samples;

  const patch = (next: Partial<OverlaySettings>): void => {
    setSettings((s) => (s ? { ...s, ...next } : s));
  };

  const save = async (): Promise<void> => {
    if (!settings) return;
    setSaving(true);
    try {
      await api.post('/api/overlay/settings', settings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const rotate = async (): Promise<void> => {
    const res = await api.post<{ url: string }>('/api/overlay/token/rotate');
    setUrl(res.url);
  };

  if (!settings) return <div className="card">{t('common.loading')}</div>;

  return (
    <>
      <div className="page-head">
        <h1>{t('overlay.title')}</h1>
        <div className="row">
          {saved ? <span className="pill ok">{t('common.saved')}</span> : null}
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spin" /> : null}
            {t('common.save')}
          </button>
        </div>
      </div>

      <div className="dash">
        <div>
          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('overlay.preview')}</h2>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={useReal} onChange={(e) => setUseReal(e.target.checked)} />
                <div>
                  <span className="label small">{t('chat.title')}</span>
                </div>
              </label>
            </div>
            <div className="overlay-preview" style={{ height: 420 }}>
              <OverlayRender settings={settings} messages={previewMessages} inPreview />
            </div>
            <div className="hint">{t('overlay.previewHint')}</div>
          </div>

          <div className="card">
            <CopyField label={t('overlay.url')} value={url} hint={t('overlay.urlHint')} secret />
            <button onClick={() => void rotate()}>{t('overlay.rotate')}</button>
            <div className="hint">{t('overlay.rotateWarn')}</div>
          </div>
        </div>

        <div className="card">
          <h2>{t('settings.general')}</h2>

          <label className="field">
            <span className="label">{t('overlay.font')}</span>
            <select value={settings.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>
              {fonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="label">
              {t('overlay.fontSize')}: {settings.fontSize} px
            </span>
            <input
              type="range"
              min={12}
              max={56}
              value={settings.fontSize}
              onChange={(e) => patch({ fontSize: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('overlay.lifetime')}:{' '}
              {settings.messageLifetimeSec === 0
                ? t('overlay.lifetimeForever')
                : t('overlay.lifetimeSec', { n: settings.messageLifetimeSec })}
            </span>
            <input
              type="range"
              min={0}
              max={300}
              step={5}
              value={settings.messageLifetimeSec}
              onChange={(e) => patch({ messageLifetimeSec: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('overlay.maxMessages')}: {settings.maxMessages}
            </span>
            <input
              type="range"
              min={1}
              max={60}
              value={settings.maxMessages}
              onChange={(e) => patch({ maxMessages: Number(e.target.value) })}
            />
          </label>

          <div className="sep" />

          <label className="check">
            <input
              type="checkbox"
              checked={settings.transparent}
              onChange={(e) => patch({ transparent: e.target.checked })}
            />
            <div>
              <span className="label">{t('overlay.transparent')}</span>
            </div>
          </label>

          {!settings.transparent ? (
            <>
              <label className="field">
                <span className="label">{t('overlay.bgColor')}</span>
                <input
                  type="color"
                  value={settings.backgroundColor}
                  onChange={(e) => patch({ backgroundColor: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="label">
                  {t('overlay.bgOpacity')}: {Math.round(settings.backgroundOpacity * 100)} %
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.backgroundOpacity}
                  onChange={(e) => patch({ backgroundOpacity: Number(e.target.value) })}
                />
              </label>
            </>
          ) : null}

          <label className="field">
            <span className="label">{t('overlay.textColor')}</span>
            <input type="color" value={settings.textColor} onChange={(e) => patch({ textColor: e.target.value })} />
          </label>

          <div className="sep" />

          <label className="check">
            <input
              type="checkbox"
              checked={settings.showPlatformIcons}
              onChange={(e) => patch({ showPlatformIcons: e.target.checked })}
            />
            <div>
              <span className="label">{t('overlay.icons')}</span>
            </div>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.useAuthorColors}
              onChange={(e) => patch({ useAuthorColors: e.target.checked })}
            />
            <div>
              <span className="label">{t('overlay.authorColors')}</span>
            </div>
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.shadow} onChange={(e) => patch({ shadow: e.target.checked })} />
            <div>
              <span className="label">{t('overlay.shadow')}</span>
            </div>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.hideBots}
              onChange={(e) => patch({ hideBots: e.target.checked })}
            />
            <div>
              <span className="label">{t('chat.hideBots')}</span>
            </div>
          </label>

          <label className="field">
            <span className="label">{t('overlay.direction')}</span>
            <select
              value={settings.direction}
              onChange={(e) => patch({ direction: e.target.value as OverlaySettings['direction'] })}
            >
              <option value="up">{t('overlay.directionUp')}</option>
              <option value="down">{t('overlay.directionDown')}</option>
            </select>
          </label>

          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">{t('overlay.animation')}</span>
            <select
              value={settings.animation}
              onChange={(e) => patch({ animation: e.target.value as OverlaySettings['animation'] })}
            >
              <option value="none">{t('overlay.animNone')}</option>
              <option value="fade">{t('overlay.animFade')}</option>
              <option value="slide">{t('overlay.animSlide')}</option>
            </select>
          </label>
        </div>
      </div>
    </>
  );
}
