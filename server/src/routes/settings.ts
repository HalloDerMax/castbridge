import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { audit, requireUser, type AuthedRequest } from '../lib/auth';
import { exec, one, query } from '../lib/db';
import { logger } from '../lib/log';
import { probe } from '../lib/proc';
import { mergeSettings, publicUser, rotateIngestKey, updateSettings } from '../lib/users';
import { BadRequest, body, bool, int, oneOf } from '../lib/validate';
import { relayManager } from '../relay/manager';
import { clearPreparedStandby, ensureDefaultImage } from '../relay/standby';

const log = logger('routes:settings');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm'];

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const settings = mergeSettings(user.settings);
    const standby = await one<{ id: string; kind: string; original_name: string; created_at: Date }>(
      'SELECT id, kind, original_name, created_at FROM standby_assets WHERE user_id = $1 AND active ORDER BY created_at DESC LIMIT 1',
      [user.id],
    );
    const speedtest = await one<{ mbps: string; recommended_kbps: number; at: Date }>(
      'SELECT mbps, recommended_kbps, at FROM speedtests WHERE user_id = $1 ORDER BY at DESC LIMIT 1',
      [user.id],
    );
    return {
      user: publicUser(user),
      settings,
      standby: standby
        ? {
            kind: standby.kind,
            name: standby.original_name,
            uploadedAt: new Date(standby.created_at).toISOString(),
            isDefault: false,
          }
        : { kind: 'image', name: 'Standardbild', uploadedAt: null, isDefault: true },
      speedtest: speedtest
        ? {
            mbps: Number(speedtest.mbps),
            recommendedKbps: speedtest.recommended_kbps,
            at: new Date(speedtest.at).toISOString(),
          }
        : null,
      limits: { maxBitrateTwitch: config.twitchMaxBitrateKbps },
    };
  });

  app.post('/api/settings', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const b = body(req.body);
    const bitrateRaw = b.targetBitrateKbps;
    const settings = await updateSettings(user.id, {
      hideBots: bool(b, 'hideBots', mergeSettings(user.settings).hideBots),
      standbyEnabled: bool(b, 'standbyEnabled', true),
      standbyGraceSec: int(b, 'standbyGraceSec', { min: 0, max: 60, fallback: 8 }),
      youtubePrivacy: oneOf(b, 'youtubePrivacy', ['public', 'unlisted', 'private'] as const, 'public'),
      targetBitrateKbps:
        bitrateRaw === null || bitrateRaw === undefined || bitrateRaw === ''
          ? null
          : int(b, 'targetBitrateKbps', { min: 500, max: 30_000 }),
    });
    return { settings };
  });

  app.post('/api/settings/ingest-key/rotate', async (req: AuthedRequest) => {
    const user = requireUser(req);
    await relayManager.dropUser(user.id);
    const key = await rotateIngestKey(user.id);
    await audit(user.id, 'ingest_key_rotated');
    return {
      ingestKey: key,
      rtmpUrl: `rtmp://${config.ingestHost}:${config.ingestRtmpPort}/${config.ingestPathPrefix}`,
    };
  });

  // ── Ersatzbild / Ersatzvideo ────────────────────────────────

  app.post('/api/settings/standby', async (req: AuthedRequest, reply) => {
    const user = requireUser(req);
    const file = await (req as unknown as {
      file(): Promise<{ filename: string; file: NodeJS.ReadableStream } | undefined>;
    }).file();
    if (!file) throw new BadRequest('no_file');

    const ext = path.extname(file.filename).toLowerCase();
    const isImage = IMAGE_EXT.includes(ext);
    const isVideo = VIDEO_EXT.includes(ext);
    if (!isImage && !isVideo) throw new BadRequest('unsupported_format');

    fs.mkdirSync(config.uploadDir, { recursive: true });
    const target = path.join(config.uploadDir, `${user.id}-${Date.now()}-${safeName(file.filename)}`);

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(target);
      file.file.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      file.file.on('error', reject);
    });

    const info = await probe(target);
    if (!info || !info.hasVideo) {
      fs.unlinkSync(target);
      throw new BadRequest('not_decodable');
    }
    if (isVideo && info.durationSec !== null && info.durationSec > 600) {
      fs.unlinkSync(target);
      throw new BadRequest('video_too_long');
    }

    await exec('UPDATE standby_assets SET active = false WHERE user_id = $1', [user.id]);
    await exec(
      'INSERT INTO standby_assets (user_id, kind, original_name, original_path, active) VALUES ($1,$2,$3,$4,true)',
      [user.id, isVideo ? 'video' : 'image', file.filename.slice(0, 200), target],
    );
    clearPreparedStandby(user.id);
    await audit(user.id, 'standby_uploaded', { kind: isVideo ? 'video' : 'image' });
    log.info(`Ersatzmedium gespeichert für ${user.email}`);

    reply.code(201);
    return {
      ok: true,
      kind: isVideo ? 'video' : 'image',
      width: info.width,
      height: info.height,
      note: 'wird beim ersten Ausfall passend zu den OBS-Einstellungen aufbereitet',
    };
  });

  app.delete('/api/settings/standby', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const rows = await query<{ original_path: string }>(
      'SELECT original_path FROM standby_assets WHERE user_id = $1',
      [user.id],
    );
    for (const r of rows) {
      try {
        fs.unlinkSync(r.original_path);
      } catch {
        /* Datei war schon weg */
      }
    }
    await exec('DELETE FROM standby_assets WHERE user_id = $1', [user.id]);
    clearPreparedStandby(user.id);
    await ensureDefaultImage();
    return { ok: true, usingDefault: true };
  });

  // ── Speedtest ───────────────────────────────────────────────

  /**
   * Der Client schickt Zufallsdaten hierher. Gemessen wird die Strecke
   * Nutzer -> unser Server, also genau die, die beim Streamen zählt.
   */
  app.post('/api/speedtest/upload', async (req: AuthedRequest) => {
    requireUser(req);
    const measured = (req as unknown as { speedtest?: { bytes: number; ms: number } }).speedtest;
    const bytes = measured?.bytes ?? 0;
    const ms = Math.max(1, measured?.ms ?? 1);
    const mbps = (bytes * 8) / (ms / 1000) / 1_000_000;
    return { bytes, ms, mbps: Math.round(mbps * 100) / 100 };
  });

  app.post('/api/speedtest/result', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const b = body(req.body);
    const mbpsRaw = Number(b.mbps);
    if (!Number.isFinite(mbpsRaw) || mbpsRaw <= 0) throw new BadRequest('invalid_mbps');
    const mbps = Math.round(mbpsRaw * 100) / 100;

    // 70 % der gemessenen Leitung, gedeckelt auf das Twitch-Limit,
    // auf 250er-Schritte gerundet.
    const usable = mbps * 1000 * 0.7;
    const capped = Math.min(usable, config.twitchMaxBitrateKbps);
    const recommended = Math.max(1000, Math.floor(capped / 250) * 250);

    await exec('INSERT INTO speedtests (user_id, mbps, recommended_kbps) VALUES ($1,$2,$3)', [
      user.id,
      mbps,
      recommended,
    ]);
    await updateSettings(user.id, { targetBitrateKbps: recommended });

    return {
      mbps,
      recommendedKbps: recommended,
      cappedByTwitch: usable > config.twitchMaxBitrateKbps,
      obs: {
        videoBitrateKbps: recommended,
        audioBitrateKbps: 160,
        keyframeIntervalSec: 2,
        encoderPreset: 'veryfast / quality',
        rateControl: 'CBR',
      },
    };
  });

  app.post('/api/settings/wizard-done', async (req: AuthedRequest) => {
    const user = requireUser(req);
    await exec('UPDATE users SET wizard_done = true WHERE id = $1', [user.id]);
    return { ok: true };
  });
}
