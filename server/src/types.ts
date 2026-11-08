import type { PlatformId } from './config';

export type { PlatformId };

export type PlatformState =
  | 'idle'
  | 'starting'
  | 'live'
  | 'reconnecting'
  | 'standby'
  | 'stopping'
  | 'error';

export interface SignalInfo {
  active: boolean;
  /** 'obs' = echtes Signal, 'standby' = Ersatzbild überbrückt gerade. */
  source: 'obs' | 'standby' | 'none';
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string;
  audioCodec: string;
  bitrateKbps: number | null;
  since: string | null;
  sessionId: string | null;
  /** Warnungen als Codes, damit das Frontend sie zweisprachig anzeigen kann. */
  warnings: SignalWarning[];
}

export interface SignalWarning {
  code: 'bitrate_high' | 'codec_unsupported' | 'fps_high' | 'resolution_high' | 'audio_missing';
  platform?: PlatformId;
  value?: number | string;
  limit?: number | string;
}

export interface PlatformStatus {
  platform: PlatformId;
  connected: boolean;
  connectedVia: 'oauth' | 'manual' | null;
  channelName: string;
  state: PlatformState;
  viewers: number | null;
  /** Vom Simulator aufgeschlagene Zuschauer (0 = keine Simulation aktiv). */
  simulatedViewers: number;
  since: string | null;
  attempt: number;
  lastError: string | null;
  title: string;
  category: string;
  capabilities: PlatformCapabilities;
}

export interface PlatformCapabilities {
  oauth: boolean;
  streamKeyViaApi: boolean;
  setTitle: boolean;
  setCategory: boolean;
  /** 'full' = Spiel wählbar, 'gaming_only' = nur Rubrik, 'none' */
  categoryMode: 'full' | 'gaming_only' | 'none';
  chat: boolean;
  viewers: boolean;
  events: boolean;
}

export interface ChatFragment {
  type: 'text' | 'emote' | 'link';
  text: string;
  url?: string;
  provider?: 'platform' | '7tv' | 'bttv' | 'ffz';
}

export interface ChatMessage {
  id: string;
  platform: PlatformId;
  platformMsgId: string;
  authorId: string;
  author: string;
  color: string;
  badges: string[];
  text: string;
  fragments: ChatFragment[];
  at: string;
  isBot: boolean;
}

export interface OverlaySettings {
  fontFamily: string;
  fontSize: number;
  messageLifetimeSec: number;
  maxMessages: number;
  transparent: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  showPlatformIcons: boolean;
  useAuthorColors: boolean;
  textColor: string;
  shadow: boolean;
  direction: 'up' | 'down';
  animation: 'none' | 'fade' | 'slide';
  hideBots: boolean;
}

export const defaultOverlaySettings: OverlaySettings = {
  fontFamily: 'Inter',
  fontSize: 22,
  messageLifetimeSec: 0,
  maxMessages: 20,
  transparent: true,
  backgroundColor: '#0b0f17',
  backgroundOpacity: 0.55,
  showPlatformIcons: true,
  useAuthorColors: true,
  textColor: '#ffffff',
  shadow: true,
  direction: 'up',
  animation: 'fade',
  hideBots: false,
};

export interface UserSettings {
  overlay: OverlaySettings;
  hideBots: boolean;
  customBotNames: string[];
  targetBitrateKbps: number | null;
  standbyEnabled: boolean;
  standbyGraceSec: number;
  youtubePrivacy: 'public' | 'unlisted' | 'private';
  perPlatformTitles: Partial<Record<PlatformId, string>>;
  sharedTitle: string;
  category: string;
  categoryIds: Partial<Record<PlatformId, string>>;
}

export const defaultUserSettings: UserSettings = {
  overlay: defaultOverlaySettings,
  hideBots: false,
  customBotNames: [],
  targetBitrateKbps: null,
  standbyEnabled: true,
  standbyGraceSec: 8,
  youtubePrivacy: 'public',
  perPlatformTitles: {},
  sharedTitle: '',
  category: '',
  categoryIds: {},
};

export interface ToastPayload {
  level: 'info' | 'warn' | 'error' | 'success';
  code: string;
  platform?: PlatformId;
  detail?: string;
  retryable?: boolean;
}

export interface AnomalyHint {
  id: number;
  platform: PlatformId | 'all';
  type: 'spike' | 'low_chat_ratio' | 'flat_curve' | 'drop' | 'synthetic_marker';
  at: string;
  score: number;
  detail: Record<string, unknown>;
}

export type AppEvent =
  | { type: 'signal'; signal: SignalInfo }
  | { type: 'platform'; status: PlatformStatus }
  | { type: 'viewers'; perPlatform: Partial<Record<PlatformId, number>>; total: number; simulated: number }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat:delete'; ids: string[] }
  | { type: 'chat:purge'; platform: PlatformId; authorId: string }
  | { type: 'toast'; toast: ToastPayload }
  | { type: 'preview'; url: string; at: string }
  | { type: 'overlay:settings'; settings: OverlaySettings }
  | { type: 'anomaly'; hint: AnomalyHint }
  | { type: 'sim'; runId: string; state: 'running' | 'done' | 'stopped'; detected: string[]; expected: string[]; verdict: string }
  | { type: 'stream:event'; platform: PlatformId; event: string; actor: string; amount: number };
