import { getJson } from '../lib/http';
import { logger } from '../lib/log';
import type { ChatFragment } from '../types';

const log = logger('emotes');

export interface Emote {
  name: string;
  url: string;
  provider: '7tv' | 'bttv' | 'ffz';
}

type EmoteMap = Map<string, Emote>;

const GLOBAL_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  map: EmoteMap;
  at: number;
}

let globalCache: CacheEntry | null = null;
const channelCache = new Map<string, CacheEntry>();

// ── Anbieter ─────────────────────────────────────────────────

async function bttvGlobal(): Promise<Emote[]> {
  const res = await getJson<{ id: string; code: string }[]>('https://api.betterttv.net/3/cached/emotes/global', {
    timeoutMs: 8000,
  });
  return res.map((e) => ({ name: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/2x`, provider: 'bttv' as const }));
}

async function bttvChannel(twitchId: string): Promise<Emote[]> {
  const res = await getJson<{
    channelEmotes?: { id: string; code: string }[];
    sharedEmotes?: { id: string; code: string }[];
  }>(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(twitchId)}`, { timeoutMs: 8000 });
  return [...(res.channelEmotes ?? []), ...(res.sharedEmotes ?? [])].map((e) => ({
    name: e.code,
    url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
    provider: 'bttv' as const,
  }));
}

interface FfzSet {
  emoticons?: { name: string; urls?: Record<string, string>; animated?: Record<string, string> }[];
}

function ffzEmotes(sets: Record<string, FfzSet> | undefined): Emote[] {
  const out: Emote[] = [];
  for (const set of Object.values(sets ?? {})) {
    for (const e of set.emoticons ?? []) {
      const urls = e.animated ?? e.urls ?? {};
      const url = urls['2'] ?? urls['4'] ?? urls['1'];
      if (!url) continue;
      out.push({ name: e.name, url: url.startsWith('//') ? `https:${url}` : url, provider: 'ffz' });
    }
  }
  return out;
}

async function ffzGlobal(): Promise<Emote[]> {
  const res = await getJson<{ sets?: Record<string, FfzSet> }>('https://api.frankerfacez.com/v1/set/global', {
    timeoutMs: 8000,
  });
  return ffzEmotes(res.sets);
}

async function ffzChannel(twitchId: string): Promise<Emote[]> {
  const res = await getJson<{ sets?: Record<string, FfzSet> }>(
    `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(twitchId)}`,
    { timeoutMs: 8000 },
  );
  return ffzEmotes(res.sets);
}

interface SevenTvEmote {
  name: string;
  data?: { host?: { url?: string; files?: { name: string; format: string }[] } };
}

function sevenTvEmotes(items: SevenTvEmote[] | undefined): Emote[] {
  const out: Emote[] = [];
  for (const e of items ?? []) {
    const host = e.data?.host;
    if (!host?.url) continue;
    const files = host.files ?? [];
    const pick =
      files.find((f) => f.name === '2x.webp') ??
      files.find((f) => f.name === '2x.avif') ??
      files.find((f) => f.name.startsWith('2x')) ??
      files[0];
    if (!pick) continue;
    const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
    out.push({ name: e.name, url: `${base}/${pick.name}`, provider: '7tv' });
  }
  return out;
}

async function sevenTvGlobal(): Promise<Emote[]> {
  const res = await getJson<{ emotes?: SevenTvEmote[] }>('https://7tv.io/v3/emote-sets/global', { timeoutMs: 8000 });
  return sevenTvEmotes(res.emotes);
}

async function sevenTvChannel(twitchId: string): Promise<Emote[]> {
  const res = await getJson<{ emote_set?: { emotes?: SevenTvEmote[] } }>(
    `https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchId)}`,
    { timeoutMs: 8000 },
  );
  return sevenTvEmotes(res.emote_set?.emotes);
}

// ── Cache ────────────────────────────────────────────────────

function toMap(lists: Emote[][]): EmoteMap {
  const map: EmoteMap = new Map();
  for (const list of lists) {
    for (const e of list) {
      if (e.name !== '' && !map.has(e.name)) map.set(e.name, e);
    }
  }
  return map;
}

async function settle(promises: Promise<Emote[]>[]): Promise<Emote[][]> {
  const results = await Promise.allSettled(promises);
  const out: Emote[][] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(r.value);
    else log.debug('Emote-Anbieter nicht erreichbar', r.reason);
  }
  return out;
}

export async function globalEmotes(): Promise<EmoteMap> {
  if (globalCache && Date.now() - globalCache.at < GLOBAL_TTL_MS) return globalCache.map;
  const lists = await settle([sevenTvGlobal(), bttvGlobal(), ffzGlobal()]);
  const map = toMap(lists);
  globalCache = { map, at: Date.now() };
  log.info(`Globale Emotes geladen: ${map.size}`);
  return map;
}

export async function channelEmotes(twitchId: string): Promise<EmoteMap> {
  const cached = channelCache.get(twitchId);
  if (cached && Date.now() - cached.at < CHANNEL_TTL_MS) return cached.map;
  const lists = await settle([sevenTvChannel(twitchId), bttvChannel(twitchId), ffzChannel(twitchId)]);
  const map = toMap(lists);
  channelCache.set(twitchId, { map, at: Date.now() });
  log.info(`Kanal-Emotes geladen (${twitchId}): ${map.size}`);
  return map;
}

export function clearChannelEmotes(twitchId: string): void {
  channelCache.delete(twitchId);
}

// ── Zerlegen ─────────────────────────────────────────────────

const URL_RE = /^https?:\/\/[^\s]+$/i;

export interface PlatformEmoteRange {
  start: number;
  end: number;
  url: string;
}

/**
 * Zerlegt einen Nachrichtentext in Text- und Emote-Stücke.
 * Plattform-Emotes kommen über Positionsangaben (Twitch) oder sind schon als
 * Marke im Text enthalten (Kick) - beides wird vorher in `ranges` übersetzt.
 */
export function tokenize(
  text: string,
  ranges: PlatformEmoteRange[],
  third: EmoteMap[],
): ChatFragment[] {
  const out: ChatFragment[] = [];
  const chars = Array.from(text);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor || r.start >= chars.length) continue;
    if (r.start > cursor) pushText(out, chars.slice(cursor, r.start).join(''), third);
    const name = chars.slice(r.start, Math.min(r.end + 1, chars.length)).join('');
    out.push({ type: 'emote', text: name, url: r.url, provider: 'platform' });
    cursor = Math.min(r.end + 1, chars.length);
  }
  if (cursor < chars.length) pushText(out, chars.slice(cursor).join(''), third);

  return out.length > 0 ? out : [{ type: 'text', text }];
}

function pushText(out: ChatFragment[], text: string, third: EmoteMap[]): void {
  if (text === '') return;
  const words = text.split(/(\s+)/);
  let buffer = '';

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  for (const w of words) {
    if (w.trim() === '') {
      buffer += w;
      continue;
    }
    const hit = findEmote(w, third);
    if (hit) {
      flush();
      out.push({ type: 'emote', text: w, url: hit.url, provider: hit.provider });
      continue;
    }
    if (URL_RE.test(w)) {
      flush();
      out.push({ type: 'link', text: w, url: w });
      continue;
    }
    buffer += w;
  }
  flush();
}

function findEmote(word: string, maps: EmoteMap[]): Emote | null {
  for (const m of maps) {
    const hit = m.get(word);
    if (hit) return hit;
  }
  return null;
}

/** Twitch-IRC-Tag "emotes=25:0-4,12-16/1902:6-10" in Bereiche übersetzen. */
export function twitchEmoteRanges(tag: string | undefined): PlatformEmoteRange[] {
  if (!tag || tag === '') return [];
  const out: PlatformEmoteRange[] = [];
  for (const part of tag.split('/')) {
    const [id, positions] = part.split(':');
    if (!id || !positions) continue;
    const url = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
    for (const range of positions.split(',')) {
      const [a, b] = range.split('-');
      const start = Number(a);
      const end = Number(b);
      if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end, url });
    }
  }
  return out;
}

/** Kick schreibt Emotes als "[emote:12345:name]" in den Text. */
export function kickEmotes(content: string): { text: string; ranges: PlatformEmoteRange[] } {
  const re = /\[emote:(\d+):([^\]]*)\]/g;
  const ranges: PlatformEmoteRange[] = [];
  let text = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    text += content.slice(last, m.index);
    const name = m[2] === '' ? 'emote' : m[2];
    const start = Array.from(text).length;
    text += name;
    ranges.push({
      start,
      end: start + Array.from(name).length - 1,
      url: `https://files.kick.com/emotes/${m[1]}/fullsize`,
    });
    last = m.index + m[0].length;
  }
  text += content.slice(last);
  return { text, ranges };
}
