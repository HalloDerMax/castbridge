import * as crypto from 'crypto';
import { config, redirectUri } from '../config';
import { getJson, postForm, request } from '../lib/http';
import { logger } from '../lib/log';
import type { CategoryHit, ChannelInfo, TokenSet } from './shared';

const log = logger('kick');

const ID = 'https://id.kick.com/oauth';
const API = 'https://api.kick.com/public/v1';

export const KICK_SCOPES = [
  'user:read',
  'channel:read',
  'channel:write',
  'streamkey:read',
  'events:subscribe',
].join(' ');

/** Kick verlangt PKCE. Der Verifier bleibt serverseitig, bis der Code zurückkommt. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authUrl(state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: config.oauth.kick.clientId,
    redirect_uri: redirectUri('kick'),
    response_type: 'code',
    scope: KICK_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${ID}/authorize?${p.toString()}`;
}

interface KickToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  const res = await postForm<KickToken>(`${ID}/token`, {
    client_id: config.oauth.kick.clientId,
    client_secret: config.oauth.kick.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri('kick'),
    code_verifier: verifier,
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresInSec: res.expires_in,
    scopes: res.scope ?? KICK_SCOPES,
  };
}

export async function refresh(token: string): Promise<TokenSet> {
  const res = await postForm<KickToken>(`${ID}/token`, {
    client_id: config.oauth.kick.clientId,
    client_secret: config.oauth.kick.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token,
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresInSec: res.expires_in,
    scopes: res.scope ?? KICK_SCOPES,
  };
}

function headers(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
}

export async function me(accessToken: string): Promise<ChannelInfo> {
  const res = await getJson<{ data?: { user_id: number; name: string; email?: string }[] }>(`${API}/users`, {
    headers: headers(accessToken),
  });
  const u = res.data?.[0];
  if (!u) throw new Error('Kick-Konto nicht lesbar.');
  return { id: String(u.user_id), login: u.name, displayName: u.name };
}

export interface KickChannel {
  broadcasterUserId: string;
  slug: string;
  title: string;
  categoryId: string;
  categoryName: string;
  isLive: boolean;
  viewers: number | null;
  chatroomId: string | null;
}

export async function getChannel(accessToken: string): Promise<KickChannel | null> {
  const res = await getJson<{
    data?: {
      broadcaster_user_id: number;
      slug: string;
      stream_title?: string;
      chatroom?: { id: number };
      category?: { id: number; name: string };
      stream?: { is_live: boolean; viewer_count: number };
    }[];
  }>(`${API}/channels`, { headers: headers(accessToken) });
  const c = res.data?.[0];
  if (!c) return null;
  return {
    broadcasterUserId: String(c.broadcaster_user_id),
    slug: c.slug,
    title: c.stream_title ?? '',
    categoryId: c.category ? String(c.category.id) : '',
    categoryName: c.category?.name ?? '',
    isLive: c.stream?.is_live ?? false,
    viewers: c.stream?.viewer_count ?? null,
    chatroomId: c.chatroom ? String(c.chatroom.id) : null,
  };
}

export async function getViewers(accessToken: string, broadcasterUserId: string): Promise<number | null> {
  try {
    const res = await getJson<{ data?: { viewer_count: number }[] }>(
      `${API}/livestreams?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}`,
      { headers: headers(accessToken) },
    );
    const s = res.data?.[0];
    return s ? s.viewer_count : null;
  } catch {
    const ch = await getChannel(accessToken).catch(() => null);
    return ch?.viewers ?? null;
  }
}

export async function updateChannel(
  accessToken: string,
  patch: { title?: string; categoryId?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.stream_title = patch.title.slice(0, 140);
  if (patch.categoryId !== undefined && patch.categoryId !== '') body.category_id = Number(patch.categoryId);
  if (Object.keys(body).length === 0) return;

  const res = await request(`${API}/channels`, {
    method: 'PATCH',
    headers: { ...headers(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Kick lehnt die Änderung ab (${res.status}): ${res.text.slice(0, 200)}`);
  }
}

export async function searchCategories(accessToken: string, q: string): Promise<CategoryHit[]> {
  if (q.trim() === '') return [];
  const res = await getJson<{ data?: { id: number; name: string; thumbnail?: string }[] }>(
    `${API}/categories?q=${encodeURIComponent(q)}`,
    { headers: headers(accessToken) },
  );
  return (res.data ?? []).slice(0, 10).map((c) => ({ id: String(c.id), name: c.name, image: c.thumbnail }));
}

/**
 * Stream-Key per API. Im Konzept als "beim Bau prüfen" markiert: die
 * Verfügbarkeit hängt daran, ob die App den Scope streamkey:read bekommt.
 * Klappt es nicht, liefern wir null und die Oberfläche zeigt den
 * Copy-Paste-Weg mit Anleitung.
 */
export async function getStreamKey(
  accessToken: string,
): Promise<{ url: string; key: string } | null> {
  const endpoints = [`${API}/channels/stream-key`, `${API}/streamkey`, `${API}/channels/streamkey`];
  for (const url of endpoints) {
    try {
      const res = await request(url, { headers: headers(accessToken), timeoutMs: 8000 });
      if (res.status < 200 || res.status >= 300) continue;
      const parsed = JSON.parse(res.text) as {
        data?: { stream_key?: string; stream_url?: string; rtmp_url?: string } | { stream_key?: string }[];
      };
      const d = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
      const key = (d as { stream_key?: string } | undefined)?.stream_key;
      if (typeof key === 'string' && key !== '') {
        const ingest =
          (d as { stream_url?: string; rtmp_url?: string }).stream_url ??
          (d as { rtmp_url?: string }).rtmp_url ??
          DEFAULT_INGEST;
        log.info('Stream-Key über die Kick-API erhalten.');
        return { url: ingest.replace(/\/+$/, ''), key };
      }
    } catch {
      /* nächsten Endpunkt probieren */
    }
  }
  log.info('Kick liefert den Stream-Key nicht über die API - manueller Weg nötig.');
  return null;
}

/** Kick verlangt RTMPS. */
export const DEFAULT_INGEST = 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app';

// ── Ereignisse (Chat, Follows, Subs) über Webhooks ───────────

export interface KickSubscription {
  name: string;
  version: number;
}

export const KICK_EVENTS: KickSubscription[] = [
  { name: 'chat.message.sent', version: 1 },
  { name: 'channel.followed', version: 1 },
  { name: 'channel.subscription.new', version: 1 },
  { name: 'channel.subscription.gifts', version: 1 },
  { name: 'channel.subscription.renewal', version: 1 },
  { name: 'livestream.status.updated', version: 1 },
];

export async function subscribeEvents(accessToken: string): Promise<{ ok: number; failed: number }> {
  try {
    await getJson(`${API}/events/subscriptions`, {
      method: 'POST',
      headers: { ...headers(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ events: KICK_EVENTS, method: 'webhook' }),
    });
    return { ok: KICK_EVENTS.length, failed: 0 };
  } catch (err) {
    log.warn('Kick-Ereignisse konnten nicht abonniert werden', err);
    return { ok: 0, failed: KICK_EVENTS.length };
  }
}

export async function unsubscribeEvents(accessToken: string): Promise<void> {
  try {
    const list = await getJson<{ data?: { id: string }[] }>(`${API}/events/subscriptions`, {
      headers: headers(accessToken),
    });
    const ids = (list.data ?? []).map((s) => s.id);
    if (ids.length === 0) return;
    const p = new URLSearchParams();
    for (const id of ids) p.append('id', id);
    await request(`${API}/events/subscriptions?${p.toString()}`, {
      method: 'DELETE',
      headers: headers(accessToken),
    });
  } catch (err) {
    log.warn('Kick-Abos konnten nicht entfernt werden', err);
  }
}

let cachedPublicKey: string | null = null;

export async function publicKey(): Promise<string | null> {
  if (cachedPublicKey) return cachedPublicKey;
  try {
    const res = await getJson<{ data?: { public_key: string } }>(`${API}/public-key`, { timeoutMs: 8000 });
    cachedPublicKey = res.data?.public_key ?? null;
    return cachedPublicKey;
  } catch (err) {
    log.warn('Kick-Signaturschlüssel nicht abrufbar', err);
    return null;
  }
}

/** Prüft die Webhook-Signatur. Ohne gültige Signatur wird nichts verarbeitet. */
export async function verifyWebhook(params: {
  messageId: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}): Promise<boolean> {
  const key = await publicKey();
  if (!key) return false;
  try {
    const payload = `${params.messageId}.${params.timestamp}.${params.rawBody}`;
    return crypto.verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      key,
      Buffer.from(params.signature, 'base64'),
    );
  } catch (err) {
    log.warn('Signaturprüfung fehlgeschlagen', err);
    return false;
  }
}
