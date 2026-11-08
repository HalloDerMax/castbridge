import { oauthConfigured, type PlatformId } from '../config';
import { logger } from '../lib/log';
import { mergeSettings, type UserRow } from '../lib/users';
import {
  accessToken,
  getAccount,
  patchExtra,
  refreshToken,
  saveTokens,
  setAccountError,
  streamKey,
  tokenExpired,
  upsertAccount,
  type PlatformAccountRow,
} from './accounts';
import type { Capability, CategoryHit } from './shared';
import * as twitch from './twitch';
import * as youtube from './youtube';
import * as kick from './kick';

const log = logger('platforms');

export function capabilities(platform: PlatformId): Capability {
  const oauth = oauthConfigured(platform);
  switch (platform) {
    case 'twitch':
      return {
        oauth,
        streamKeyViaApi: oauth,
        setTitle: oauth,
        setCategory: oauth,
        categoryMode: 'full',
        chat: true,
        viewers: oauth,
        events: oauth,
      };
    case 'youtube':
      return {
        oauth,
        streamKeyViaApi: oauth,
        setTitle: oauth,
        setCategory: oauth,
        // Über die API ist nur die Rubrik "Gaming" setzbar, nicht das Spiel.
        categoryMode: 'gaming_only',
        chat: oauth,
        viewers: oauth,
        events: oauth,
      };
    case 'kick':
      return {
        oauth,
        // Wird zur Laufzeit geprüft; siehe kick.getStreamKey.
        streamKeyViaApi: oauth,
        setTitle: oauth,
        setCategory: oauth,
        categoryMode: 'full',
        chat: oauth,
        viewers: oauth,
        events: oauth,
      };
  }
}

/** Führt eine API-Aktion aus und erneuert vorher bei Bedarf das Token. */
export async function withToken<T>(
  acc: PlatformAccountRow,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  let token = accessToken(acc);
  if (!token) throw new Error('not_connected');

  if (tokenExpired(acc)) {
    const rt = refreshToken(acc);
    if (rt) {
      const set =
        acc.platform === 'twitch'
          ? await twitch.refresh(rt)
          : acc.platform === 'youtube'
            ? await youtube.refresh(rt)
            : await kick.refresh(rt);
      await saveTokens(acc.id, set);
      token = set.accessToken;
    }
  }

  try {
    const out = await fn(token);
    await setAccountError(acc.id, null);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Einmal nachfassen, falls das Token zwischendurch ungültig wurde.
    if (/401|invalid|unauthor/i.test(msg)) {
      const rt = refreshToken(acc);
      if (rt) {
        try {
          const set =
            acc.platform === 'twitch'
              ? await twitch.refresh(rt)
              : acc.platform === 'youtube'
                ? await youtube.refresh(rt)
                : await kick.refresh(rt);
          await saveTokens(acc.id, set);
          const out = await fn(set.accessToken);
          await setAccountError(acc.id, null);
          return out;
        } catch (second) {
          await setAccountError(acc.id, second instanceof Error ? second.message : String(second));
          throw second;
        }
      }
    }
    await setAccountError(acc.id, msg);
    throw err;
  }
}

export interface ResolvedTarget {
  url: string;
  note?: string;
}

/**
 * Baut die vollständige Ziel-URL für das Relay. Bei YouTube wird dabei auch
 * die Sendung (Broadcast) angelegt bzw. gefunden und mit dem Schlüssel
 * verbunden, sonst käme das Signal nirgends an.
 */
export async function resolveTarget(user: UserRow, platform: PlatformId): Promise<ResolvedTarget> {
  const acc = await getAccount(user.id, platform);
  if (!acc) throw new Error('not_connected');

  const settings = mergeSettings(user.settings);
  const title = settings.perPlatformTitles[platform] ?? settings.sharedTitle;

  if (platform === 'youtube' && acc.connected_via === 'oauth') {
    return withToken(acc, async (token) => {
      const stream = await youtube.getOrCreateStream(token, title);
      let broadcast = await youtube.findActiveBroadcast(token);
      if (!broadcast) {
        broadcast = await youtube.createBroadcast(token, {
          title: title === '' ? 'Live' : title,
          privacy: settings.youtubePrivacy,
        });
      }
      await youtube.bindBroadcast(token, broadcast.id, stream.streamId).catch((err) => {
        log.warn('Broadcast-Bindung', err);
      });
      await patchExtra(acc.id, {
        broadcastId: broadcast.id,
        liveChatId: broadcast.liveChatId,
        streamId: stream.streamId,
      });
      const base = stream.ingestionAddress.replace(/\/+$/, '');
      return { url: `${base}/${stream.streamName}` };
    });
  }

  const key = streamKey(acc);
  if (key && acc.ingest_url !== '') {
    return { url: `${acc.ingest_url.replace(/\/+$/, '')}/${key}` };
  }

  if (platform === 'twitch' && acc.connected_via === 'oauth') {
    return withToken(acc, async (token) => {
      const fresh = await twitch.getStreamKey(token, acc.channel_id);
      if (!fresh) throw new Error('stream_key_unavailable');
      const base = await twitch.ingestUrl();
      await upsertAccount({
        userId: user.id,
        platform,
        connectedVia: 'oauth',
        streamKey: fresh,
        ingestUrl: base,
      });
      return { url: `${base.replace(/\/+$/, '')}/${fresh}` };
    });
  }

  if (platform === 'kick' && acc.connected_via === 'oauth') {
    return withToken(acc, async (token) => {
      const fresh = await kick.getStreamKey(token);
      if (!fresh) throw new Error('stream_key_unavailable');
      await upsertAccount({
        userId: user.id,
        platform,
        connectedVia: 'oauth',
        streamKey: fresh.key,
        ingestUrl: fresh.url,
      });
      return { url: `${fresh.url.replace(/\/+$/, '')}/${fresh.key}` };
    });
  }

  throw new Error('stream_key_unavailable');
}

export async function currentViewers(user: UserRow, platform: PlatformId): Promise<number | null> {
  const acc = await getAccount(user.id, platform);
  if (!acc || acc.connected_via !== 'oauth') return null;

  try {
    if (platform === 'twitch') {
      return await withToken(acc, (t) => twitch.getViewers(t, acc.channel_id));
    }
    if (platform === 'kick') {
      return await withToken(acc, (t) => kick.getViewers(t, acc.channel_id));
    }
    const broadcastId = (acc.extra as { broadcastId?: string }).broadcastId;
    if (!broadcastId) return null;
    return await withToken(acc, async (t) => {
      const d = await youtube.videoDetails(t, broadcastId);
      if (d?.activeLiveChatId) await patchExtra(acc.id, { liveChatId: d.activeLiveChatId });
      return d?.concurrentViewers ?? null;
    });
  } catch (err) {
    if (platform === 'youtube') youtube.quotaHint(err);
    return null;
  }
}

export interface TitleResult {
  platform: PlatformId;
  ok: boolean;
  code?: string;
  detail?: string;
}

/** Setzt Titel (und, wo möglich, Kategorie). Fehler werden einzeln gemeldet. */
export async function applyTitleAndCategory(
  user: UserRow,
  titles: Partial<Record<PlatformId, string>>,
  categoryIds: Partial<Record<PlatformId, string>>,
): Promise<TitleResult[]> {
  const out: TitleResult[] = [];

  for (const platform of Object.keys(titles) as PlatformId[]) {
    const title = titles[platform];
    if (title === undefined) continue;
    const acc = await getAccount(user.id, platform);
    if (!acc || acc.connected_via !== 'oauth') {
      out.push({ platform, ok: false, code: 'not_connected_oauth' });
      continue;
    }
    try {
      if (platform === 'twitch') {
        await withToken(acc, (t) =>
          twitch.updateChannel(t, acc.channel_id, { title, gameId: categoryIds.twitch }),
        );
        out.push({ platform, ok: true });
      } else if (platform === 'kick') {
        await withToken(acc, (t) => kick.updateChannel(t, { title, categoryId: categoryIds.kick }));
        out.push({ platform, ok: true });
      } else {
        const broadcastId = (acc.extra as { broadcastId?: string }).broadcastId;
        if (!broadcastId) {
          out.push({ platform, ok: false, code: 'youtube_no_broadcast' });
          continue;
        }
        await withToken(acc, (t) =>
          youtube.updateVideo(t, broadcastId, { title, setGamingCategory: categoryIds.youtube !== undefined }),
        );
        // Ehrliche Rückmeldung: das konkrete Spiel geht über die API nicht.
        out.push({ platform, ok: true, code: categoryIds.youtube ? 'youtube_category_gaming_only' : undefined });
      }
    } catch (err) {
      out.push({ platform, ok: false, code: 'api_error', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export async function searchCategories(user: UserRow, platform: PlatformId, q: string): Promise<CategoryHit[]> {
  const acc = await getAccount(user.id, platform);
  if (!acc || acc.connected_via !== 'oauth') return [];
  try {
    if (platform === 'twitch') return await withToken(acc, (t) => twitch.searchCategories(t, q));
    if (platform === 'kick') return await withToken(acc, (t) => kick.searchCategories(t, q));
    return [{ id: youtube.GAMING_CATEGORY_ID, name: 'Gaming' }];
  } catch {
    return [];
  }
}

export async function channelSummary(
  user: UserRow,
  platform: PlatformId,
): Promise<{ title: string; category: string } | null> {
  const acc = await getAccount(user.id, platform);
  if (!acc || acc.connected_via !== 'oauth') return null;
  try {
    if (platform === 'twitch') {
      const c = await withToken(acc, (t) => twitch.getChannel(t, acc.channel_id));
      return c ? { title: c.title, category: c.gameName } : null;
    }
    if (platform === 'kick') {
      const c = await withToken(acc, (t) => kick.getChannel(t));
      return c ? { title: c.title, category: c.categoryName } : null;
    }
    const broadcastId = (acc.extra as { broadcastId?: string }).broadcastId;
    if (!broadcastId) return null;
    const d = await withToken(acc, (t) => youtube.videoDetails(t, broadcastId));
    return d ? { title: d.title, category: 'Gaming' } : null;
  } catch {
    return null;
  }
}

export { twitch, youtube, kick };
