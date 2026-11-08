import { useEffect, useMemo, useState } from 'react';
import { hexToRgba } from '../lib/format';
import type { ChatMessage, OverlaySettings } from '../lib/types';
import { PlatformIcon } from './icons';
import { Fragments } from './ChatView';

interface Props {
  settings: OverlaySettings;
  messages: ChatMessage[];
  /** Im Editor wird der Bereich beschnitten, in OBS füllt er die Quelle. */
  inPreview?: boolean;
}

export function OverlayRender({ settings, messages, inPreview = false }: Props): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  // Nur mitlaufen lassen, wenn Nachrichten wirklich verfallen.
  useEffect(() => {
    if (settings.messageLifetimeSec <= 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [settings.messageLifetimeSec]);

  const visible = useMemo(() => {
    let list = settings.hideBots ? messages.filter((m) => !m.isBot) : messages;
    if (settings.messageLifetimeSec > 0) {
      const cutoff = now - settings.messageLifetimeSec * 1000;
      list = list.filter((m) => new Date(m.at).getTime() >= cutoff);
    }
    list = list.slice(-settings.maxMessages);
    return settings.direction === 'down' ? [...list].reverse() : list;
  }, [messages, settings, now]);

  const bubbleBg = settings.transparent
    ? 'transparent'
    : hexToRgba(settings.backgroundColor, settings.backgroundOpacity);

  return (
    <div
      className="overlay-root"
      style={{
        fontFamily: `${settings.fontFamily}, Inter, system-ui, sans-serif`,
        fontSize: settings.fontSize,
        color: settings.textColor,
        justifyContent: settings.direction === 'up' ? 'flex-end' : 'flex-start',
        minHeight: inPreview ? 'auto' : '100vh',
        height: inPreview ? '100%' : undefined,
        padding: inPreview ? 0 : 10,
        textShadow: settings.shadow ? '0 1px 3px rgba(0,0,0,0.85), 0 0 10px rgba(0,0,0,0.6)' : 'none',
      }}
    >
      {visible.map((m) => (
        <div
          key={m.id}
          className={`overlay-msg anim-${settings.animation}`}
          style={{ background: bubbleBg, lineHeight: 1.35 }}
        >
          {settings.showPlatformIcons ? (
            <span style={{ flex: 'none', marginTop: '0.18em' }}>
              <PlatformIcon platform={m.platform} size={Math.round(settings.fontSize * 0.82)} />
            </span>
          ) : null}
          <span>
            <strong
              style={{
                color: settings.useAuthorColors && m.color !== '' ? m.color : settings.textColor,
                marginRight: 6,
              }}
            >
              {m.author}
            </strong>
            <Fragments message={m} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Beispielnachrichten für die Vorschau im Editor. */
export function sampleMessages(): ChatMessage[] {
  const base = Date.now();
  const make = (
    i: number,
    platform: ChatMessage['platform'],
    author: string,
    color: string,
    text: string,
    isBot = false,
  ): ChatMessage => ({
    id: `sample-${i}`,
    platform,
    platformMsgId: `s${i}`,
    authorId: `u${i}`,
    author,
    color,
    badges: [],
    text,
    fragments: [{ type: 'text', text }],
    at: new Date(base - (8 - i) * 4000).toISOString(),
    isBot,
  });

  return [
    make(1, 'twitch', 'LenaStreamt', '#ff7ac6', 'Moin! Endlich wieder live'),
    make(2, 'youtube', 'Kalle_1987', '#7ad1ff', 'Ton ist super heute'),
    make(3, 'kick', 'nachtaktiv', '#53fc18', 'erster Kick-Chat hier, nice'),
    make(4, 'twitch', 'Nightbot', '#9146ff', 'Folge dem Kanal für Updates!', true),
    make(5, 'twitch', 'Mo', '#ffd166', 'wie hast du das Overlay gemacht?'),
    make(6, 'youtube', 'Sanne', '', 'Grüße aus Hamburg'),
    make(7, 'kick', 'Tobi', '#8ef1ff', 'läuft bei dir'),
    make(8, 'twitch', 'pixelhase', '#c792ea', 'Der Umschalter ist echt clever'),
  ];
}
