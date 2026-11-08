import { config, redirectUri } from '../config';
import { getJson, postForm, request } from '../lib/http';
import { logger } from '../lib/log';
import type { TokenSet, ChannelInfo, CategoryHit } from './shared';

const log = logger('twitch');

const ID = 'https://id.twitch.tv/oauth2';
const API = 'https://api.twitch.tv/helix';

export const TWITCH_SCOPES = [
  'user:read:email',
  'channel:read:stream_key',
  'channel:manage:broadcast',
  'channel:read:subscriptions',
  'moderator:read:followers',
  'chat:read',
].join(' ');

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.oauth.twitch.clientId,
    redirect_uri: redirectUri('twitch'),
    response_type: 'code',
    scope: TWITCH_SCOPES,
    state,
    force_verify: 'true',
  });
  return `${ID}/authorize?${p.toString()}`;
}

interface TwitchToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[] | string;
}

export async function exchangeCode(code: string): Promise<TokenSet> {
  const res = await postForm<TwitchToken>(`${ID}/token`, {
    client_id: config.oauth.twitch.clientId,
    client_secret: config.oauth.twitch.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri('twitch'),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresInSec: res.expires_in,
    scopes: Array.isArray(res.scope) ? res.scope.join(' ') : res.scope,
  };
}

export async function refresh(token: string): Promise<TokenSet> {
  const res = await postForm<TwitchToken>(`${ID}/token`, {
    client_id: config.oauth.twitch.clientId,
    client_secret: config.oauth.twitch.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token,
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresInSec: res.expires_in,
    scopes: Array.isArray(res.scope) ? res.scope.join(' ') : res.scope,
  };
}

function headers(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'client-id': config.oauth.twitch.clientId,
  };
}

export async function me(accessToken: string): Promise<ChannelInfo> {
  const res = await getJson<{ data: { id: string; login: string; display_name: string }[] }>(`${API}/users`, {
    headers: headers(accessToken),
  });
  const u = res.data?.[0];
  if (!u) throw new Error('Twitch-Konto nicht lesbar.');
  return { id: u.id, login: u.login, displayName: u.display_name };
}

export async function getStreamKey(accessToken: string, broadcasterId: string): Promise<string | null> {
  try {
    const res = await getJson<{ data: { stream_key: string }[] }>(
      `${API}/streams/key?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
      { headers: headers(accessToken) },
    );
    return res.data?.[0]?.stream_key ?? null;
  } catch (err) {
    log.warn('Stream-Key nicht abrufbar', err);
    return null;
  }
}

/** Empfohlener Ingest-Server. Fällt auf den globalen Einstieg zurück. */
export async function ingestUrl(): Promise<string> {
  try {
    const res = await getJson<{ ingests: { url_template: string; availability: number; priority: number }[] }>(
      'https://ingest.twitch.tv/ingests',
      { timeoutMs: 6000 },
    );
    const best = (res.ingests ?? [])
      .filter((i) => i.availability > 0)
      .sort((a, b) => a.priority - b.priority)[0];
    if (best) return best.url_template.replace('/{stream_key}', '');
  } catch {
    /* Fallback unten */
  }
  return 'rtmp://live.twitch.tv/app';
}

export async function getViewers(accessToken: string, broadcasterId: string): Promise<number | null> {
  const res = await getJson<{ data: { viewer_count: number }[] }>(
    `${API}/streams?user_id=${encodeURIComponent(broadcasterId)}`,
    { headers: headers(accessToken) },
  );
  const s = res.data?.[0];
  return s ? s.viewer_count : null;
}

export async function getChannel(
  accessToken: string,
  broadcasterId: string,
): Promise<{ title: string; gameId: string; gameName: string } | null> {
  const res = await getJson<{ data: { title: string; game_id: string; game_name: string }[] }>(
    `${API}/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { headers: headers(accessToken) },
  );
  const c = res.data?.[0];
  return c ? { title: c.title, gameId: c.game_id, gameName: c.game_name } : null;
}

export async function updateChannel(
  accessToken: string,
  broadcasterId: string,
  patch: { title?: string; gameId?: string },
): Promise<void> {
  const body: Record<string, string> = {};
  if (patch.title !== undefined) body.title = patch.title.slice(0, 140);
  if (patch.gameId !== undefined) body.game_id = patch.gameId;
  if (Object.keys(body).length === 0) return;
  const res = await request(`${API}/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`, {
    method: 'PATCH',
    headers: { ...headers(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`Twitch lehnt die Änderung ab (${res.status}): ${res.text.slice(0, 200)}`);
  }
}

export async function searchCategories(accessToken: string, q: string): Promise<CategoryHit[]> {
  if (q.trim() === '') return [];
  const res = await getJson<{ data: { id: string; name: string; box_art_url: string }[] }>(
    `${API}/search/categories?first=10&query=${encodeURIComponent(q)}`,
    { headers: headers(accessToken) },
  );
  return (res.data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    image: g.box_art_url.replace('{width}', '72').replace('{height}', '96'),
  }));
}

export async function getFollowerCount(accessToken: string, broadcasterId: string): Promise<number | null> {
  try {
    const res = await getJson<{ total: number }>(
      `${API}/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`,
      { headers: headers(accessToken) },
    );
    return res.total ?? null;
  } catch {
    return null;
  }
}

export async function getSubCount(accessToken: string, broadcasterId: string): Promise<number | null> {
  try {
    const res = await getJson<{ total: number }>(
      `${API}/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`,
      { headers: headers(accessToken) },
    );
    return res.total ?? null;
  } catch {
    return null;
  }
}
