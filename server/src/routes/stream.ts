import * as fs from 'fs';
import type { FastifyInstance } from 'fastify';
import { config, PLATFORMS, isPlatformId, type PlatformId } from '../config';
import { requireUser, type AuthedRequest } from '../lib/auth';
import { exec, query } from '../lib/db';
import { mergeSettings, publicUser, updateSettings, type UserRow } from '../lib/users';
import { BadRequest, body, bool, oneOf, str } from '../lib/validate';
import { capabilities, applyTitleAndCategory, channelSummary, resolveTarget, searchCategories } from '../platforms';
import { getAccount, listAccounts } from '../platforms/accounts';
import { relayManager } from '../relay/manager';
import { thumbnails } from '../relay/thumbnail';
import { chatHub } from '../chat/hub';
import { liveOffsets } from '../stats/sim';
import type { PlatformStatus } from '../types';

async function latestViewers(sessionId: string | null): Promise<Partial<Record<PlatformId, number>>> {
  if (!sessionId) return {};
  const rows = await query<{ platform: string; viewers: number }>(
    `SELECT platform, viewers FROM viewer_samples v
      WHERE session_id = $1
        AND at = (SELECT max(at) FROM viewer_samples WHERE session_id = $1 AND platform = v.platform)`,
    [sessionId],
  );
  const out: Partial<Record<PlatformId, number>> = {};
  for (const r of rows) {
    if (isPlatformId(r.platform)) out[r.platform] = r.viewers;
  }
  return out;
}

export async function buildPlatformStatuses(user: UserRow): Promise<PlatformStatus[]> {
  const accounts = await listAccounts(user.id);
  const session = relayManager.session(user.id);
  const viewers = await latestViewers(session?.sessionId ?? null);
  const offsets = liveOffsets(user.id);
  const settings = mergeSettings(user.settings);

  const out: PlatformStatus[] = [];
  for (const platform of PLATFORMS) {
    const acc = accounts.find((a) => a.platform === platform) ?? null;
    const relay = session?.platformState(platform) ?? { state: 'idle' as const, attempt: 0, since: null, lastError: null };
    out.push({
      platform,
      connected: acc !== null,
      connectedVia: acc ? acc.connected_via : null,
      channelName: acc ? (acc.display_name === '' ? acc.channel_login : acc.display_name) : '',
      state: relay.state,
      viewers: viewers[platform] ?? null,
      simulatedViewers: offsets[platform] ?? 0,
      since: relay.since,
      attempt: relay.attempt,
      lastError: acc?.last_error ?? relay.lastError,
      title: settings.perPlatformTitles[platform] ?? settings.sharedTitle,
      category: settings.category,
      capabilities: capabilities(platform),
    });
  }
  return out;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream/state', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const session = relayManager.session(user.id);
    const rates = chatHub.rates(user.id);
    const platforms = await buildPlatformStatuses(user);

    let total = 0;
    let simulated = 0;
    for (const p of platforms) {
      if (p.viewers !== null) total += p.viewers;
      simulated += p.simulatedViewers;
    }

    return {
      signal: relayManager.signal(user.id),
      platforms,
      viewers: { total, simulated },
      chat: rates,
      chatConnections: chatHub.connectionState(user.id),
      preview: {
        available: thumbnails.exists(user.id),
        ageSeconds: thumbnails.ageSeconds(user.id),
        url: '/api/stream/preview.jpg',
        intervalSeconds: 10,
      },
      diagnostics: session?.diagnostics() ?? null,
      obs: obsInfo(user),
      user: publicUser(user),
    };
  });

  app.get('/api/stream/obs', async (req: AuthedRequest) => {
    const user = requireUser(req);
    return obsInfo(user);
  });

  app.get('/api/stream/preview.jpg', async (req: AuthedRequest, reply) => {
    const user = requireUser(req);
    const file = thumbnails.filePath(user.id);
    if (!fs.existsSync(file)) {
      reply.code(404);
      return { error: 'no_preview' };
    }
    reply.header('content-type', 'image/jpeg');
    reply.header('cache-control', 'no-store');
    return fs.createReadStream(file);
  });

  app.post('/api/stream/live', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = oneOf(body(req.body), 'platform', PLATFORMS);
    return goLiveOn(user, platform);
  });

  app.post('/api/stream/live-all', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const accounts = await listAccounts(user.id);
    const results: { platform: PlatformId; ok: boolean; code?: string }[] = [];
    for (const acc of accounts) {
      results.push(await goLiveOn(user, acc.platform));
    }
    if (results.length === 0) throw new BadRequest('no_platforms_connected');
    return { results };
  });

  app.post('/api/stream/stop', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = oneOf(body(req.body), 'platform', PLATFORMS);
    await relayManager.stopPlatform(user.id, platform);
    return { ok: true };
  });

  app.post('/api/stream/stop-all', async (req: AuthedRequest) => {
    const user = requireUser(req);
    await relayManager.stopEverything(user.id);
    return { ok: true };
  });

  app.post('/api/stream/retry', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = oneOf(body(req.body), 'platform', PLATFORMS);
    await relayManager.stopPlatform(user.id, platform);
    return goLiveOn(user, platform);
  });

  // ── Titel & Kategorie ───────────────────────────────────────

  app.post('/api/stream/titles', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const b = body(req.body);
    const shared = str(b, 'shared', { optional: true, max: 200 });
    const applyToAll = bool(b, 'applyToAll', true);

    const perPlatform: Partial<Record<PlatformId, string>> = {};
    const rawPer = (b.perPlatform ?? {}) as Record<string, unknown>;
    for (const platform of PLATFORMS) {
      const v = rawPer[platform];
      if (typeof v === 'string' && v.trim() !== '') perPlatform[platform] = v.trim().slice(0, 200);
      else if (applyToAll && shared !== '') perPlatform[platform] = shared;
    }

    const categoryIds: Partial<Record<PlatformId, string>> = {};
    const rawCat = (b.categoryIds ?? {}) as Record<string, unknown>;
    for (const platform of PLATFORMS) {
      const v = rawCat[platform];
      if (typeof v === 'string' && v !== '') categoryIds[platform] = v;
    }

    const settings = mergeSettings(user.settings);
    await updateSettings(user.id, {
      sharedTitle: shared,
      perPlatformTitles: perPlatform,
      categoryIds,
      category: str(b, 'category', { optional: true, max: 120 }) || settings.category,
    });

    if (shared !== '') await rememberTitle(user.id, shared);
    for (const t of Object.values(perPlatform)) {
      if (t && t !== shared) await rememberTitle(user.id, t);
    }

    const results = await applyTitleAndCategory(user, perPlatform, categoryIds);
    return { results };
  });

  app.get('/api/stream/titles/suggestions', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const q = String((req.query as { q?: string }).q ?? '').trim();
    const rows = await query<{ title: string; pinned: boolean; last_used_at: Date }>(
      `SELECT title, pinned, last_used_at FROM title_presets
        WHERE user_id = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%')
        ORDER BY pinned DESC, last_used_at DESC
        LIMIT 12`,
      [user.id, q],
    );
    return {
      suggestions: rows.map((r) => ({
        title: r.title,
        pinned: r.pinned,
        lastUsedAt: new Date(r.last_used_at).toISOString(),
      })),
    };
  });

  app.post('/api/stream/titles/pin', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const b = body(req.body);
    const title = str(b, 'title', { min: 1, max: 200 });
    const pinned = bool(b, 'pinned', true);
    await exec(
      `INSERT INTO title_presets (user_id, title, pinned) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, title) DO UPDATE SET pinned = $3`,
      [user.id, title, pinned],
    );
    return { ok: true };
  });

  app.delete('/api/stream/titles', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const title = str(body(req.body), 'title', { min: 1, max: 200 });
    await exec('DELETE FROM title_presets WHERE user_id = $1 AND title = $2', [user.id, title]);
    return { ok: true };
  });

  app.get('/api/stream/categories', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const q = String((req.query as { q?: string }).q ?? '');
    const platform = String((req.query as { platform?: string }).platform ?? 'twitch');
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');
    return { results: await searchCategories(user, platform, q) };
  });

  app.get('/api/stream/channel/:platform', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = (req.params as { platform: string }).platform;
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');
    return { channel: await channelSummary(user, platform) };
  });
}

function obsInfo(user: UserRow): {
  rtmpUrl: string;
  srtUrl: string;
  streamKey: string;
  recommendedBitrateKbps: number | null;
  keyframeIntervalSec: number;
  maxBitrateTwitch: number;
} {
  const settings = mergeSettings(user.settings);
  return {
    rtmpUrl: `rtmp://${config.ingestHost}:${config.ingestRtmpPort}/${config.ingestPathPrefix}`,
    srtUrl: `srt://${config.ingestHost}:${config.ingestSrtPort}?streamid=publish:${config.ingestPathPrefix}/${user.ingest_key}`,
    streamKey: user.ingest_key,
    recommendedBitrateKbps: settings.targetBitrateKbps,
    keyframeIntervalSec: 2,
    maxBitrateTwitch: config.twitchMaxBitrateKbps,
  };
}

async function rememberTitle(userId: string, title: string): Promise<void> {
  await exec(
    `INSERT INTO title_presets (user_id, title) VALUES ($1, $2)
     ON CONFLICT (user_id, title) DO UPDATE
       SET use_count = title_presets.use_count + 1, last_used_at = now()`,
    [userId, title],
  );
  await exec(
    `DELETE FROM title_presets
      WHERE user_id = $1 AND NOT pinned
        AND id NOT IN (
          SELECT id FROM title_presets WHERE user_id = $1 AND NOT pinned ORDER BY last_used_at DESC LIMIT 20
        )`,
    [userId],
  );
}

async function goLiveOn(user: UserRow, platform: PlatformId): Promise<{ platform: PlatformId; ok: boolean; code?: string }> {
  const acc = await getAccount(user.id, platform);
  if (!acc) return { platform, ok: false, code: 'not_connected' };
  try {
    const target = await resolveTarget(user, platform);
    await relayManager.goLive(user.id, { platform, url: target.url });
    void chatHub.ensureForUser(user.id);
    return { platform, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      msg === 'no_signal'
        ? 'no_signal'
        : msg === 'stream_key_unavailable'
          ? 'stream_key_unavailable'
          : msg === 'not_connected'
            ? 'not_connected'
            : 'start_failed';
    return { platform, ok: false, code };
  }
}
