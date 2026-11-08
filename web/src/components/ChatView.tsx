import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { fmtTime } from '../lib/format';
import type { ChatMessage } from '../lib/types';
import { PlatformIcon } from './icons';

export function Fragments({ message }: { message: ChatMessage }): JSX.Element {
  const parts = message.fragments.length > 0 ? message.fragments : [{ type: 'text' as const, text: message.text }];
  return (
    <>
      {parts.map((f, i) => {
        if (f.type === 'emote' && f.url) {
          return <img key={i} className="emote" src={f.url} alt={f.text} title={f.text} loading="lazy" />;
        }
        if (f.type === 'link' && f.url) {
          return (
            <a key={i} href={f.url} target="_blank" rel="noreferrer noopener">
              {f.text}
            </a>
          );
        }
        return <span key={i}>{f.text}</span>;
      })}
    </>
  );
}

interface Props {
  messages: ChatMessage[];
  hideBots: boolean;
  showIcons?: boolean;
  showTime?: boolean;
  maxHeight?: number | string;
}

export function ChatView({ messages, hideBots, showIcons = true, showTime = false, maxHeight = 420 }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);

  const visible = hideBots ? messages.filter((m) => !m.isBot) : messages;

  useEffect(() => {
    if (!follow) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  return (
    <>
      <div className="chat-list" ref={ref} onScroll={onScroll} style={{ maxHeight }}>
        {visible.length === 0 ? <div className="muted small" style={{ padding: 10 }}>{t('chat.empty')}</div> : null}
        {visible.map((m) => (
          <div key={m.id} className={`chat-msg${m.isBot ? ' bot' : ''}`}>
            {showIcons ? (
              <span className="pico">
                <PlatformIcon platform={m.platform} size={16} />
              </span>
            ) : null}
            <div>
              {showTime ? <span className="muted small mono" style={{ marginRight: 6 }}>{fmtTime(m.at, lang)}</span> : null}
              <span className="author" style={{ color: m.color === '' ? undefined : m.color }}>
                {m.author}
              </span>
              <span className="muted">: </span>
              <Fragments message={m} />
            </div>
          </div>
        ))}
      </div>
      {!follow ? (
        <button
          className="sm mt"
          onClick={() => {
            setFollow(true);
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {t('chat.autoscroll')}
        </button>
      ) : null}
    </>
  );
}
