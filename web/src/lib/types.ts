export type PlatformId = 'twitch' | 'youtube' | 'kick';
export const PLATFORMS: PlatformId[] = ['twitch', 'youtube', 'kick'];

export const PLATFORM_NAME: Record<PlatformId, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
};

export const PLATFORM_COLOR: Record<PlatformId, string> = {
  twitch: '#9146ff',
  youtube: '#ff0033',
  kick: '#53fc18',
};

export type PlatformState =
  | 'idle'
  | 'starting'
  | 'live'
  | 'reconnecting'
  | 'standby'
  | 'stopping'
  | 'error';

export interface SignalWarning {
  code: string;
  platform?: PlatformId;
  value?: number | string;
  limit?: number | string;
}

export interface SignalInfo {
  active: boolean;
  source: 'obs' | 'standby' | 'none';
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string;
  audioCodec: string;
  bitrateKbps: number | null;
  since: string | null;
  sessionId: string | null;
  warnings: SignalWarning[];
}

export interface PlatformCapabilities {
  oauth: boolean;
  streamKeyViaApi: boolean;
  setTitle: boolean;
  setCategory: boolean;
  categoryMode: 'full' | 'gaming_only' | 'none';
  chat: boolean;
  viewers: boolean;
  events: boolean;
}

export interface PlatformStatus {
  platform: PlatformId;
  connected: boolean;
  connectedVia: 'oauth' | 'manual' | null;
  channelName: string;
  state: PlatformState;
  viewers: number | null;
  simulatedViewers: number;
  since: string | null;
  attempt: number;
  lastError: string | null;
  title: string;
  category: string;
  capabilities: PlatformCapabilities;
}

export interface ChatFragment {
  type: 'text' | 'emote' | 'link';
  text: string;
  url?: string;
  provider?: string;
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

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  language: string;
  wizardDone: boolean;
  ingestKey: string;
  overlayToken: string;
  settings: UserSettings;
}

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
  type: string;
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
  | { type: 'sim'; runId: string; state: string; detected: string[]; expected: string[]; verdict: string }
  | { type: 'stream:event'; platform: PlatformId; event: string; actor: string; amount: number }
  | { type: 'error'; code: string }
  | { type: 'pong' };

export interface ObsInfo {
  rtmpUrl: string;
  srtUrl: string;
  streamKey: string;
  recommendedBitrateKbps: number | null;
  keyframeIntervalSec: number;
  maxBitrateTwitch: number;
}

export interface StreamState {
  signal: SignalInfo;
  platforms: PlatformStatus[];
  viewers: { total: number; simulated: number };
  chat: { messagesPerMinute: number; chatters: number; perPlatform: Partial<Record<PlatformId, number>> };
  chatConnections: Partial<Record<PlatformId, boolean>>;
  preview: { available: boolean; ageSeconds: number | null; url: string; intervalSeconds: number };
  diagnostics: {
    outputs: number;
    source: string | null;
    switches: number;
    timestampMs: number;
    standbySeconds: number | null;
  } | null;
  obs: ObsInfo;
  user: PublicUser;
}

export interface SeriesPoint {
  at: string;
  viewers: number;
  chatters: number;
  synthetic: boolean;
}

export interface PlatformStats {
  platform: PlatformId;
  peak: number;
  average: number;
  samples: number;
  series: SeriesPoint[];
  syntheticSamples: number;
}

export interface StatsReport {
  scope: 'session' | 'range';
  label: string;
  from: string;
  to: string;
  durationMin: number;
  totalPeak: number;
  totalAverage: number;
  messages: number;
  chatters: number;
  messagesPerMinute: number;
  hasSimulation: boolean;
  perPlatform: PlatformStats[];
  events: {
    subs: number;
    resubs: number;
    giftSubs: number;
    follows: number;
    raids: number;
    members: number;
    superChats: number;
    superChatAmount: number;
  };
  anomalies: {
    id: number;
    platform: PlatformId;
    type: string;
    at: string;
    score: number;
    detail: Record<string, unknown>;
    fromSimulation: boolean;
  }[];
}

export interface SessionListItem {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  peakViewers: number;
  messages: number;
  hasSimulation: boolean;
  platforms: PlatformId[];
}

export interface PlatformInfo {
  platform: PlatformId;
  capabilities: PlatformCapabilities;
  oauthAvailable: boolean;
  connected: boolean;
  connectedVia: 'oauth' | 'manual' | null;
  channelName: string;
  lastError: string | null;
  hasStreamKey: boolean;
  manual: { url: string; steps: string[]; ingestUrl: string };
}

export interface SimScenario {
  id: string;
  description: string;
  expected: string[];
}

export interface SimRun {
  id: string;
  email: string;
  scenario: string;
  platform: string;
  mode: string;
  state: string;
  expected: string[];
  detected: string[];
  verdict: string;
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
}

export interface SimResult {
  runId: string;
  sessionId: string | null;
  scenario: string;
  expected: string[];
  detected: string[];
  verdict: string;
  hints: { type: string; at: string; score: number; detail: Record<string, unknown> }[];
  samples: { at: string; viewers: number; chatters: number }[];
}

export interface AdminOverview {
  live: {
    userId: string;
    email: string;
    signal: SignalInfo;
    platforms: { platform: string; state: string }[];
    chat: { messagesPerMinute: number; chatters: number };
    diagnostics: { outputs: number; source: string | null; switches: number; standbySeconds: number | null } | null;
    simulationActive: boolean;
  }[];
  limits: { maxConcurrentStreams: number; envDefault: number; currentlyLive: number };
  users: { total: number; blocked: number; sessionsLast30Days: number };
  server: {
    cpus: number;
    loadAverage: number[];
    memory: { total: number; free: number };
    uptimeSec: number;
    processUptimeSec: number;
    disk: { total: number; free: number } | null;
    network: { rx: number; tx: number } | null;
    trafficThisMonthGb: number;
    trafficNote: string;
  };
}
