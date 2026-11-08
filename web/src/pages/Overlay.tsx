import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { AppEvent, ChatMessage, OverlaySettings } from '../lib/types';
import { OverlayRender } from '../components/OverlayRender';

const MAX_KEEP = 120;

/**
 * Die Seite für die OBS-Browserquelle. Kein Gerüst, kein Login, nur Token.
 * Hält die Verbindung selbst und baut sie nach einem Abbruch wieder auf,
 * damit OBS nicht neu geladen werden muss.
 */
export function OverlayPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const retry = useRef(0);

  useEffect(() => {
    document.body.classList.add('overlay-mode');
    return () => document.body.classList.remove('overlay-mode');
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/overlay/${encodeURIComponent(token ?? '')}/config`);
        if (!res.ok) {
          if (active) setError('unknown_token');
          return;
        }
        const data = (await res.json()) as { settings: OverlaySettings; messages: ChatMessage[] };
        if (!active) return;
        setSettings(data.settings);
        setMessages(data.messages);
      } catch {
        if (active) setError('offline');
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let closed = false;
    let timer: number | null = null;

    const connect = (): void => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${proto}://${window.location.host}/overlay-ws?token=${encodeURIComponent(token)}`,
      );

      socket.onopen = () => {
        retry.current = 0;
        setError(null);
      };

      socket.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data as string) as AppEvent;
          if (event.type === 'chat') {
            setMessages((prev) => {
              if (prev.some((m) => m.id === event.message.id)) return prev;
              const next = [...prev, event.message];
              return next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next;
            });
          } else if (event.type === 'chat:delete') {
            const ids = new Set(event.ids);
            setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
          } else if (event.type === 'chat:purge') {
            setMessages((prev) =>
              prev.filter((m) => !(m.platform === event.platform && m.authorId === event.authorId)),
            );
          } else if (event.type === 'overlay:settings') {
            setSettings(event.settings);
          } else if (event.type === 'error') {
            setError(event.code);
          }
        } catch {
          /* ignorieren */
        }
      };

      socket.onclose = () => {
        if (closed) return;
        retry.current += 1;
        const delay = Math.min(20_000, 800 * 2 ** Math.min(retry.current, 4));
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [token]);

  if (error === 'unknown_token') {
    return (
      <div style={{ padding: 16, fontFamily: 'Inter, sans-serif', color: '#fff' }}>
        Overlay-Token ist unbekannt. Im Tool eine neue URL erzeugen.
      </div>
    );
  }

  if (!settings) return <div />;

  return <OverlayRender settings={settings} messages={messages} />;
}
