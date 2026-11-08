import type { PlatformId } from '../config';
import { one, query } from '../lib/db';

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

export async function listSessions(userId: string, limit = 60): Promise<SessionListItem[]> {
  const rows = await query<{
    id: string;
    title: string;
    started_at: Date;
    ended_at: Date | null;
    peak_viewers: number;
    messages: number;
    has_simulation: boolean;
    platforms: string[] | null;
  }>(
    `SELECT s.id, s.title, s.started_at, s.ended_at, s.peak_viewers, s.messages, s.has_simulation,
            (SELECT array_agg(DISTINCT pr.platform) FROM platform_runs pr WHERE pr.session_id = s.id) AS platforms
       FROM stream_sessions s
      WHERE s.user_id = $1
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    durationMin: Math.round(
      ((r.ended_at ? new Date(r.ended_at).getTime() : Date.now()) - new Date(r.started_at).getTime()) / 60_000,
    ),
    peakViewers: r.peak_viewers,
    messages: r.messages,
    hasSimulation: r.has_simulation,
    platforms: (r.platforms ?? []) as PlatformId[],
  }));
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

export interface EventTotals {
  subs: number;
  resubs: number;
  giftSubs: number;
  follows: number;
  raids: number;
  members: number;
  superChats: number;
  superChatAmount: number;
}

export interface AnomalyRow {
  id: number;
  platform: PlatformId;
  type: string;
  at: string;
  score: number;
  detail: Record<string, unknown>;
  fromSimulation: boolean;
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
  events: EventTotals;
  anomalies: AnomalyRow[];
}

const EMPTY_EVENTS: EventTotals = {
  subs: 0,
  resubs: 0,
  giftSubs: 0,
  follows: 0,
  raids: 0,
  members: 0,
  superChats: 0,
  superChatAmount: 0,
};

async function eventTotals(where: string, params: unknown[]): Promise<EventTotals> {
  const rows = await query<{ type: string; n: string; amount: string }>(
    `SELECT type, count(*) AS n, COALESCE(sum(amount), 0) AS amount FROM stream_events WHERE ${where} GROUP BY type`,
    params,
  );
  const out: EventTotals = { ...EMPTY_EVENTS };
  for (const r of rows) {
    const n = Number(r.n);
    const amount = Number(r.amount);
    switch (r.type) {
      case 'sub':
        out.subs += n;
        break;
      case 'resub':
        out.resubs += n;
        break;
      case 'subgift':
        out.giftSubs += amount > 0 ? amount : n;
        break;
      case 'follow':
      case 'channel.followed':
        out.follows += n;
        break;
      case 'raid':
        out.raids += n;
        break;
      case 'member':
        out.members += n;
        break;
      case 'superchat':
        out.superChats += n;
        out.superChatAmount += amount;
        break;
      default:
        break;
    }
  }
  return out;
}

async function anomalyRows(where: string, params: unknown[]): Promise<AnomalyRow[]> {
  const rows = await query<{
    id: number;
    platform: string;
    type: string;
    at: Date;
    score: string;
    detail: Record<string, unknown>;
    run_id: string | null;
  }>(`SELECT id, platform, type, at, score, detail, run_id FROM anomalies WHERE ${where} ORDER BY at`, params);
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform as PlatformId,
    type: r.type,
    at: new Date(r.at).toISOString(),
    score: Number(r.score),
    detail: r.detail,
    fromSimulation: r.run_id !== null,
  }));
}

function buildPlatformStats(
  rows: { platform: string; at: Date; viewers: number; chatters: number; synthetic: boolean }[],
): PlatformStats[] {
  const grouped = new Map<string, SeriesPoint[]>();
  for (const r of rows) {
    const list = grouped.get(r.platform) ?? [];
    list.push({
      at: new Date(r.at).toISOString(),
      viewers: r.viewers,
      chatters: r.chatters,
      synthetic: r.synthetic,
    });
    grouped.set(r.platform, list);
  }

  const out: PlatformStats[] = [];
  for (const [platform, series] of grouped) {
    let peak = 0;
    let sum = 0;
    let synthetic = 0;
    for (const p of series) {
      if (p.viewers > peak) peak = p.viewers;
      sum += p.viewers;
      if (p.synthetic) synthetic += 1;
    }
    out.push({
      platform: platform as PlatformId,
      peak,
      average: series.length === 0 ? 0 : Math.round(sum / series.length),
      samples: series.length,
      series,
      syntheticSamples: synthetic,
    });
  }
  return out.sort((a, b) => b.peak - a.peak);
}

export async function sessionReport(userId: string, sessionId: string): Promise<StatsReport | null> {
  const session = await one<{
    id: string;
    title: string;
    started_at: Date;
    ended_at: Date | null;
    messages: number;
    has_simulation: boolean;
  }>('SELECT id, title, started_at, ended_at, messages, has_simulation FROM stream_sessions WHERE id = $1 AND user_id = $2', [
    sessionId,
    userId,
  ]);
  if (!session) return null;

  const rows = await query<{ platform: string; at: Date; viewers: number; chatters: number; synthetic: boolean }>(
    'SELECT platform, at, viewers, chatters, synthetic FROM viewer_samples WHERE session_id = $1 ORDER BY at',
    [sessionId],
  );
  const perPlatform = buildPlatformStats(rows);

  const chatRow = await one<{ n: string; chatters: string }>(
    'SELECT count(*) AS n, count(DISTINCT author_id) AS chatters FROM chat_messages WHERE session_id = $1 AND NOT deleted',
    [sessionId],
  );

  const start = new Date(session.started_at);
  const end = session.ended_at ? new Date(session.ended_at) : new Date();
  const durationMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
  const messages = Number(chatRow?.n ?? 0);

  let totalPeak = 0;
  let totalAverage = 0;
  for (const p of perPlatform) {
    totalPeak += p.peak;
    totalAverage += p.average;
  }

  return {
    scope: 'session',
    label: session.title === '' ? `Stream vom ${start.toLocaleDateString('de-DE')}` : session.title,
    from: start.toISOString(),
    to: end.toISOString(),
    durationMin,
    totalPeak,
    totalAverage,
    messages,
    chatters: Number(chatRow?.chatters ?? 0),
    messagesPerMinute: Math.round((messages / durationMin) * 10) / 10,
    hasSimulation: session.has_simulation,
    perPlatform,
    events: await eventTotals('session_id = $1', [sessionId]),
    anomalies: await anomalyRows('session_id = $1', [sessionId]),
  };
}

export async function rangeReport(userId: string, from: Date, to: Date): Promise<StatsReport> {
  const rows = await query<{ platform: string; at: Date; viewers: number; chatters: number; synthetic: boolean }>(
    `SELECT vs.platform, vs.at, vs.viewers, vs.chatters, vs.synthetic
       FROM viewer_samples vs
       JOIN stream_sessions s ON s.id = vs.session_id
      WHERE s.user_id = $1 AND vs.at >= $2 AND vs.at <= $3
      ORDER BY vs.at`,
    [userId, from, to],
  );
  const perPlatform = buildPlatformStats(rows);

  const chatRow = await one<{ n: string; chatters: string }>(
    `SELECT count(*) AS n, count(DISTINCT author_id) AS chatters
       FROM chat_messages WHERE user_id = $1 AND at >= $2 AND at <= $3 AND NOT deleted`,
    [userId, from, to],
  );
  const durRow = await one<{ minutes: string; sim: boolean }>(
    `SELECT COALESCE(sum(extract(epoch from (COALESCE(ended_at, now()) - started_at)) / 60), 0) AS minutes,
            COALESCE(bool_or(has_simulation), false) AS sim
       FROM stream_sessions WHERE user_id = $1 AND started_at >= $2 AND started_at <= $3`,
    [userId, from, to],
  );

  const durationMin = Math.max(1, Math.round(Number(durRow?.minutes ?? 0)));
  const messages = Number(chatRow?.n ?? 0);

  let totalPeak = 0;
  let totalAverage = 0;
  for (const p of perPlatform) {
    totalPeak += p.peak;
    totalAverage += p.average;
  }

  return {
    scope: 'range',
    label: `${from.toLocaleDateString('de-DE')} – ${to.toLocaleDateString('de-DE')}`,
    from: from.toISOString(),
    to: to.toISOString(),
    durationMin,
    totalPeak,
    totalAverage,
    messages,
    chatters: Number(chatRow?.chatters ?? 0),
    messagesPerMinute: Math.round((messages / durationMin) * 10) / 10,
    hasSimulation: durRow?.sim ?? false,
    perPlatform,
    events: await eventTotals(
      'user_id = $1 AND at >= $2 AND at <= $3',
      [userId, from, to],
    ),
    anomalies: await anomalyRows(
      `session_id IN (SELECT id FROM stream_sessions WHERE user_id = $1) AND at >= $2 AND at <= $3`,
      [userId, from, to],
    ),
  };
}
