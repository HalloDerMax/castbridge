import { config, redirectUri } from '../config';
import { getJson, postForm, request } from '../lib/http';
import { logger } from '../lib/log';
import type { ChannelInfo, TokenSet } from './shared';

const log = logger('youtube');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

/** YouTube-Rubrik "Gaming". Ein konkretes Spiel ist über die API nicht setzbar. */
export const GAMING_CATEGORY_ID = '20';

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.oauth.youtube.clientId,
    redirect_uri: redirectUri('youtube'),
    response_type: 'code',
    scope: YOUTUBE_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

interface GoogleToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCode(code: string): Promise<TokenSet> {
  const res = await postForm<GoogleToken>(TOKEN, {
    client_id: config.oauth.youtube.clientId,
    client_secret: config.oauth.youtube.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri('youtube'),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresInSec: res.expires_in,
    scopes: res.scope ?? YOUTUBE_SCOPES,
  };
}

export async function refresh(token: string): Promise<TokenSet> {
  const res = await postForm<GoogleToken>(TOKEN, {
    client_id: config.oauth.youtube.clientId,
    client_secret: config.oauth.youtube.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token,
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresInSec: res.expires_in,
    scopes: res.scope ?? YOUTUBE_SCOPES,
  };
}

function headers(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export async function me(accessToken: string): Promise<ChannelInfo> {
  const res = await getJson<{ items?: { id: string; snippet: { title: string; customUrl?: string } }[] }>(
    `${API}/channels?part=snippet&mine=true`,
    { headers: headers(accessToken) },
  );
  const c = res.items?.[0];
  if (!c) throw new Error('Kein YouTube-Kanal für dieses Konto gefunden.');
  return { id: c.id, login: c.snippet.customUrl ?? c.id, displayName: c.snippet.title };
}

export interface YoutubeIngest {
  streamId: string;
  ingestionAddress: string;
  streamName: string;
}

/**
 * Holt (oder erzeugt) den wiederverwendbaren Stream-Schlüssel des Kanals.
 * YouTube trennt "liveStream" (der Schlüssel) von "liveBroadcast" (die
 * Sendung) - wir brauchen beides und binden sie aneinander.
 */
export async function getOrCreateStream(accessToken: string, title: string): Promise<YoutubeIngest> {
  const list = await getJson<{
    items?: { id: string; cdn: { ingestionInfo: { ingestionAddress: string; streamName: string } } }[];
  }>(`${API}/liveStreams?part=id,cdn,status&mine=true&maxResults=20`, { headers: headers(accessToken) });

  const reusable = list.items?.find((s) => s.cdn?.ingestionInfo?.streamName);
  if (reusable) {
    return {
      streamId: reusable.id,
      ingestionAddress: reusable.cdn.ingestionInfo.ingestionAddress,
      streamName: reusable.cdn.ingestionInfo.streamName,
    };
  }

  const created = await getJson<{
    id: string;
    cdn: { ingestionInfo: { ingestionAddress: string; streamName: string } };
  }>(`${API}/liveStreams?part=snippet,cdn,status`, {
    method: 'POST',
    headers: { ...headers(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      snippet: { title: title === '' ? 'Castbridge' : title.slice(0, 120) },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
    }),
  });
  return {
    streamId: created.id,
    ingestionAddress: created.cdn.ingestionInfo.ingestionAddress,
    streamName: created.cdn.ingestionInfo.streamName,
  };
}

export interface YoutubeBroadcast {
  id: string;
  title: string;
  status: string;
  liveChatId: string | null;
}

export async function findActiveBroadcast(accessToken: string): Promise<YoutubeBroadcast | null> {
  for (const status of ['active', 'upcoming'] as const) {
    const res = await getJson<{
      items?: { id: string; snippet: { title: string; liveChatId?: string }; status: { lifeCycleStatus: string } }[];
    }>(`${API}/liveBroadcasts?part=id,snippet,status&broadcastStatus=${status}&broadcastType=all&maxResults=5`, {
      headers: headers(accessToken),
    });
    const b = res.items?.[0];
    if (b) {
      return {
        id: b.id,
        title: b.snippet.title,
        status: b.status.lifeCycleStatus,
        liveChatId: b.snippet.liveChatId ?? null,
      };
    }
  }
  return null;
}

export async function createBroadcast(
  accessToken: string,
  params: { title: string; privacy: 'public' | 'unlisted' | 'private' },
): Promise<YoutubeBroadcast> {
  const res = await getJson<{
    id: string;
    snippet: { title: string; liveChatId?: string };
    status: { lifeCycleStatus: string };
  }>(`${API}/liveBroadcasts?part=snippet,status,contentDetails`, {
    method: 'POST',
    headers: { ...headers(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        title: params.title === '' ? 'Live' : params.title.slice(0, 100),
        scheduledStartTime: new Date(Date.now() + 30_000).toISOString(),
      },
      status: { privacyStatus: params.privacy, selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true, latencyPreference: 'low' },
    }),
  });
  return {
    id: res.id,
    title: res.snippet.title,
    status: res.status.lifeCycleStatus,
    liveChatId: res.snippet.liveChatId ?? null,
  };
}

export async function bindBroadcast(accessToken: string, broadcastId: string, streamId: string): Promise<void> {
  await getJson(
    `${API}/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,status`,
    { method: 'POST', headers: headers(accessToken) },
  );
}

export interface YoutubeVideoDetails {
  concurrentViewers: number | null;
  activeLiveChatId: string | null;
  title: string;
}

export async function videoDetails(accessToken: string, videoId: string): Promise<YoutubeVideoDetails | null> {
  const res = await getJson<{
    items?: {
      snippet: { title: string };
      liveStreamingDetails?: { concurrentViewers?: string; activeLiveChatId?: string };
    }[];
  }>(`${API}/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}`, {
    headers: headers(accessToken),
  });
  const v = res.items?.[0];
  if (!v) return null;
  const viewers = v.liveStreamingDetails?.concurrentViewers;
  return {
    concurrentViewers: viewers === undefined ? null : Number(viewers),
    activeLiveChatId: v.liveStreamingDetails?.activeLiveChatId ?? null,
    title: v.snippet.title,
  };
}

/**
 * Titel ändern. Achtung: videos.update ersetzt den gesamten snippet-Teil,
 * deshalb lesen wir ihn vorher und schicken ihn vollständig zurück.
 */
export async function updateVideo(
  accessToken: string,
  videoId: string,
  patch: { title?: string; setGamingCategory?: boolean },
): Promise<void> {
  const current = await getJson<{
    items?: { snippet: Record<string, unknown> }[];
  }>(`${API}/videos?part=snippet&id=${encodeURIComponent(videoId)}`, { headers: headers(accessToken) });
  const snippet = current.items?.[0]?.snippet;
  if (!snippet) throw new Error('YouTube-Video nicht gefunden.');

  const next: Record<string, unknown> = { ...snippet };
  if (patch.title !== undefined) next.title = patch.title.slice(0, 100);
  if (patch.setGamingCategory) next.categoryId = GAMING_CATEGORY_ID;

  const res = await request(`${API}/videos?part=snippet`, {
    method: 'PUT',
    headers: { ...headers(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet: next }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`YouTube lehnt die Änderung ab (${res.status}): ${res.text.slice(0, 200)}`);
  }
}

export interface LiveChatPage {
  messages: {
    id: string;
    authorId: string;
    author: string;
    text: string;
    publishedAt: string;
    type: string;
    amount: number;
    isSuper: boolean;
    isMember: boolean;
    deletedId: string | null;
  }[];
  nextPageToken: string | null;
  pollingIntervalMillis: number;
}

export async function liveChatMessages(
  accessToken: string,
  liveChatId: string,
  pageToken: string | null,
): Promise<LiveChatPage> {
  const p = new URLSearchParams({
    liveChatId,
    part: 'snippet,authorDetails',
    maxResults: '200',
  });
  if (pageToken) p.set('pageToken', pageToken);

  const res = await getJson<{
    items?: {
      id: string;
      snippet: {
        type: string;
        displayMessage?: string;
        publishedAt: string;
        superChatDetails?: { amountMicros: string; userComment?: string };
        superStickerDetails?: { amountMicros: string };
        memberMilestoneChatDetails?: { userComment?: string };
        newSponsorDetails?: unknown;
        messageDeletedDetails?: { deletedMessageId: string };
      };
      authorDetails: { channelId: string; displayName: string };
    }[];
    nextPageToken?: string;
    pollingIntervalMillis?: number;
  }>(`${API}/liveChat/messages?${p.toString()}`, { headers: headers(accessToken) });

  const messages = (res.items ?? []).map((i) => {
    const micros = i.snippet.superChatDetails?.amountMicros ?? i.snippet.superStickerDetails?.amountMicros;
    return {
      id: i.id,
      authorId: i.authorDetails.channelId,
      author: i.authorDetails.displayName,
      text: i.snippet.displayMessage ?? i.snippet.superChatDetails?.userComment ?? '',
      publishedAt: i.snippet.publishedAt,
      type: i.snippet.type,
      amount: micros === undefined ? 0 : Math.round(Number(micros) / 10_000) / 100,
      isSuper: i.snippet.superChatDetails !== undefined || i.snippet.superStickerDetails !== undefined,
      isMember: i.snippet.newSponsorDetails !== undefined || i.snippet.memberMilestoneChatDetails !== undefined,
      deletedId: i.snippet.messageDeletedDetails?.deletedMessageId ?? null,
    };
  });

  return {
    messages,
    nextPageToken: res.nextPageToken ?? null,
    // Nie schneller als alle 5 Sekunden, damit das Tageskontingent reicht.
    pollingIntervalMillis: Math.max(5000, res.pollingIntervalMillis ?? 5000),
  };
}

export function quotaHint(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('quotaExceeded') || msg.includes('rateLimitExceeded')) {
    log.warn('YouTube-Tageskontingent erschöpft.');
    return true;
  }
  return false;
}
