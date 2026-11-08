import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { PLATFORMS, PLATFORM_NAME, type PlatformId } from '../lib/types';
import { ChatView } from '../components/ChatView';
import { PlatformIcon } from '../components/icons';

interface BotsResponse {
  known: string[];
  hideBots: boolean;
  custom: string[];
}

export function ChatPage(): JSX.Element {
  const { t } = useI18n();
  const { user, reload } = useSession();
  const { messages } = useLive();

  const [hideBots, setHideBots] = useState(user?.settings.hideBots ?? false);
  const [custom, setCustom] = useState((user?.settings.customBotNames ?? []).join('\n'));
  const [known, setKnown] = useState<string[]>([]);
  const [showKnown, setShowKnown] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connections, setConnections] = useState<Partial<Record<PlatformId, boolean>>>({});

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<BotsResponse>('/api/chat/bots');
        setKnown(res.known);
        setHideBots(res.hideBots);
        setCustom(res.custom.join('\n'));
      } catch {
        /* Vorgaben bleiben */
      }
      try {
        const res = await api.post<{ connections: Partial<Record<PlatformId, boolean>> }>('/api/chat/connect');
        setConnections(res.connections);
      } catch {
        /* nicht kritisch */
      }
    })();
  }, []);

  const save = async (nextHide: boolean, nextCustom: string): Promise<void> => {
    await api.post('/api/chat/bots', {
      hideBots: nextHide,
      custom: nextCustom
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
    await reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('chat.title')}</h1>
          <div className="small muted">{t('chat.readOnly')}</div>
        </div>
        <div className="row">
          {PLATFORMS.map((p) => (
            <span key={p} className={`pill ${connections[p] ? 'ok' : ''}`}>
              <PlatformIcon platform={p} size={13} />
              {PLATFORM_NAME[p]}
            </span>
          ))}
        </div>
      </div>

      <div className="dash">
        <div className="card">
          <ChatView messages={messages} hideBots={hideBots} showTime maxHeight="calc(100vh - 230px)" />
        </div>

        <div>
          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('chat.hideBots')}</h2>
              {saved ? <span className="pill ok">{t('common.saved')}</span> : null}
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={hideBots}
                onChange={(e) => {
                  setHideBots(e.target.checked);
                  void save(e.target.checked, custom);
                }}
              />
              <div>
                <span className="label">{t('chat.hideBots')}</span>
                <div className="hint">{t('chat.hideBotsHint')}</div>
              </div>
            </label>

            <button className="ghost sm" onClick={() => setShowKnown((v) => !v)}>
              {t('chat.knownBots')} {showKnown ? '−' : '+'}
            </button>
            {showKnown ? (
              <div className="hint" style={{ marginTop: 6 }}>
                {known.join(', ')}
              </div>
            ) : null}

            <div className="sep" />

            <label className="field">
              <span className="label">{t('chat.customBots')}</span>
              <textarea rows={5} value={custom} onChange={(e) => setCustom(e.target.value)} spellCheck={false} />
              <div className="hint">{t('chat.customBotsHint')}</div>
            </label>
            <button className="primary" onClick={() => void save(hideBots, custom)}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
