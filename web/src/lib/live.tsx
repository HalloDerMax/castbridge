import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AnomalyHint,
  AppEvent,
  ChatMessage,
  PlatformId,
  PlatformStatus,
  SignalInfo,
  ToastPayload,
} from './types';
import { PLATFORMS } from './types';

const EMPTY_SIGNAL: SignalInfo = {
  active: false,
  source: 'none',
  width: null,
  height: null,
  fps: null,
  videoCodec: '',
  audioCodec: '',
  bitrateKbps: null,
  since: null,
  sessionId: null,
  warnings: [],
};

export interface Toast extends ToastPayload {
  id: number;
  at: number;
}

interface LiveValue {
  connected: boolean;
  signal: SignalInfo;
  platforms: Partial<Record<PlatformId, PlatformStatus>>;
  viewers: { total: number; simulated: number; perPlatform: Partial<Record<PlatformId, number>> };
  messages: ChatMessage[];
  toasts: Toast[];
  anomalies: AnomalyHint[];
  preview: { url: string; at: string } | null;
  simState: { runId: string; state: string; verdict: string; detected: string[]; expected: string[] } | null;
  dismissToast(id: number): void;
  pushToast(t: ToastPayload): void;
  setPlatform(status: PlatformStatus): void;
  replacePlatforms(list: PlatformStatus[]): void;
}

const LiveContext = createContext<LiveValue | null>(null);

const MAX_MESSAGES = 300;
let toastSeq = 1;

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [signal, setSignal] = useState<SignalInfo>(EMPTY_SIGNAL);
  const [platforms, setPlatforms] = useState<Partial<Record<PlatformId, PlatformStatus>>>({});
  const [viewers, setViewers] = useState<{
    total: number;
    simulated: number;
    perPlatform: Partial<Record<PlatformId, number>>;
  }>({ total: 0, simulated: 0, perPlatform: {} });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyHint[]>([]);
  const [preview, setPreview] = useState<{ url: string; at: string } | null>(null);
  const [simState, setSimState] = useState<LiveValue['simState']>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const pushToast = useCallback((t: ToastPayload) => {
    const toast: Toast = { ...t, id: toastSeq++, at: Date.now() };
    setToasts((prev) => [...prev.slice(-4), toast]);
    const ttl = t.level === 'error' ? 14_000 : 7000;
    window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== toast.id)), ttl);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setPlatform = useCallback((status: PlatformStatus) => {
    setPlatforms((prev) => {
      const old = prev[status.platform];
      // Teilmeldungen des Relays dürfen die Kontodaten nicht überschreiben.
      const merged: PlatformStatus = old
        ? {
            ...old,
            state: status.state,
            attempt: status.attempt,
            since: status.since ?? old.since,
            lastError: status.lastError ?? old.lastError,
            viewers: status.viewers ?? old.viewers,
            simulatedViewers: status.simulatedViewers || old.simulatedViewers,
            connected: status.connected || old.connected,
            connectedVia: status.connectedVia ?? old.connectedVia,
            channelName: status.channelName === '' ? old.channelName : status.channelName,
            title: status.title === '' ? old.title : status.title,
            category: status.category === '' ? old.category : status.category,
            capabilities: status.capabilities.oauth || old.capabilities === undefined ? status.capabilities : old.capabilities,
          }
        : status;
      return { ...prev, [status.platform]: merged };
    });
  }, []);

  const replacePlatforms = useCallback((list: PlatformStatus[]) => {
    setPlatforms(() => {
      const next: Partial<Record<PlatformId, PlatformStatus>> = {};
      for (const s of list) next[s.platform] = s;
      return next;
    });
  }, []);

  const handle = useCallback(
    (event: AppEvent) => {
      switch (event.type) {
        case 'signal':
          setSignal(event.signal);
          break;
        case 'platform':
          setPlatform(event.status);
          break;
        case 'viewers':
          setViewers({ total: event.total, simulated: event.simulated, perPlatform: event.perPlatform });
          setPlatforms((prev) => {
            const next = { ...prev };
            for (const p of PLATFORMS) {
              const v = event.perPlatform[p];
              const cur = next[p];
              if (v !== undefined && cur) next[p] = { ...cur, viewers: v };
            }
            return next;
          });
          break;
        case 'chat':
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.message.id)) return prev;
            const next = [...prev, event.message];
            return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
          });
          break;
        case 'chat:delete': {
          const ids = new Set(event.ids);
          setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
          break;
        }
        case 'chat:purge':
          setMessages((prev) =>
            prev.filter((m) => !(m.platform === event.platform && m.authorId === event.authorId)),
          );
          break;
        case 'toast':
          pushToast(event.toast);
          break;
        case 'preview':
          setPreview({ url: event.url, at: event.at });
          break;
        case 'anomaly':
          setAnomalies((prev) => [...prev.slice(-20), event.hint]);
          break;
        case 'sim':
          setSimState({
            runId: event.runId,
            state: event.state,
            verdict: event.verdict,
            detected: event.detected,
            expected: event.expected,
          });
          break;
        default:
          break;
      }
    },
    [pushToast, setPlatform],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };
      socket.onmessage = (ev) => {
        try {
          handle(JSON.parse(ev.data as string) as AppEvent);
        } catch {
          /* kaputte Nachricht ignorieren */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        retryRef.current += 1;
        const delay = Math.min(15_000, 700 * 2 ** Math.min(retryRef.current, 4));
        timerRef.current = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      closed = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, handle]);

  const value = useMemo<LiveValue>(
    () => ({
      connected,
      signal,
      platforms,
      viewers,
      messages,
      toasts,
      anomalies,
      preview,
      simState,
      dismissToast,
      pushToast,
      setPlatform,
      replacePlatforms,
    }),
    [
      connected,
      signal,
      platforms,
      viewers,
      messages,
      toasts,
      anomalies,
      preview,
      simState,
      dismissToast,
      pushToast,
      setPlatform,
      replacePlatforms,
    ],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('LiveProvider fehlt');
  return ctx;
}
