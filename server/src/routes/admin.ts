import * as fs from 'fs';
import * as os from 'os';
import type { FastifyInstance } from 'fastify';
import { PLATFORMS, config, isPlatformId } from '../config';
import { audit, requireAdmin, type AuthedRequest } from '../lib/auth';
import { exec, one, query } from '../lib/db';
import { createInvite, deleteInvite, listInvites } from '../lib/invites';
import { maxConcurrentStreams, setNumber } from '../lib/appSettings';
import { getUserById, listUsers } from '../lib/users';
import { BadRequest, body, bool, int, oneOf, str } from '../lib/validate';
import { relayManager } from '../relay/manager';
import { chatHub } from '../chat/hub';
import { defaultDetectorConfig } from '../stats/detector';
import {
  SCENARIOS,
  defaultSimParams,
  deleteRun,
  expectedHints,
  listRuns,
  runDetail,
  scenarioDescription,
  simulator,
  type SimParams,
} from '../stats/sim';

function diskFree(dir: string): { total: number; free: number } | null {
  try {
    const stat = (fs as unknown as { statfsSync?: (p: string) => { blocks: number; bsize: number; bavail: number } })
      .statfsSync;
    if (!stat) return null;
    const s = stat(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function netBytes(): { rx: number; tx: number } | null {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest) continue;
      if (name.trim() === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] ?? 0;
      tx += cols[8] ?? 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/overview', async (req: AuthedRequest) => {
    requireAdmin(req);

    const active = relayManager.activeSessions();
    const live: {
      userId: string;
      email: string;
      signal: ReturnType<typeof relayManager.signal>;
      platforms: { platform: string; state: string }[];
      chat: { messagesPerMinute: number; chatters: number };
      diagnostics: ReturnType<NonNullable<ReturnType<typeof relayManager.session>>['diagnostics']> | null;
      simulationActive: boolean;
    }[] = [];

    for (const { userId, session } of active) {
      const user = await getUserById(userId);
      live.push({
        userId,
        email: user?.email ?? '(gelöscht)',
        signal: session.signal,
        platforms: PLATFORMS.map((p) => ({ platform: p, state: session.platformState(p).state })).filter(
          (p) => p.state !== 'idle',
        ),
        chat: chatHub.rates(userId),
        diagnostics: session.diagnostics(),
        simulationActive: simulator.anyLive(userId),
      });
    }

    const counts = await one<{ users: string; blocked: string; sessions: string }>(
      `SELECT (SELECT count(*) FROM users) AS users,
              (SELECT count(*) FROM users WHERE is_blocked) AS blocked,
              (SELECT count(*) FROM stream_sessions WHERE started_at > now() - interval '30 days') AS sessions`,
    );

    const traffic = await one<{ gb: string }>(
      `SELECT COALESCE(sum(
                 extract(epoch from (COALESCE(pr.ended_at, now()) - pr.started_at))
                 * COALESCE(s.bitrate_kbps, 6000) * 1000 / 8
               ) / 1024 / 1024 / 1024, 0) AS gb
         FROM platform_runs pr
         JOIN stream_sessions s ON s.id = pr.session_id
        WHERE pr.started_at >= date_trunc('month', now())`,
    );

    const mem = { total: os.totalmem(), free: os.freemem() };
    const net = netBytes();

    return {
      live,
      limits: {
        maxConcurrentStreams: await maxConcurrentStreams(),
        envDefault: config.maxConcurrentStreams,
        currentlyLive: active.length,
      },
      users: {
        total: Number(counts?.users ?? 0),
        blocked: Number(counts?.blocked ?? 0),
        sessionsLast30Days: Number(counts?.sessions ?? 0),
      },
      server: {
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        memory: mem,
        uptimeSec: Math.round(os.uptime()),
        processUptimeSec: Math.round(process.uptime()),
        disk: diskFree(config.dataDir),
        network: net,
        trafficThisMonthGb: Math.round(Number(traffic?.gb ?? 0) * 100) / 100,
        trafficNote: 'geschätzt aus Laufzeit und Bitrate der Weiterleitungen',
      },
    };
  });

  app.post('/api/admin/limits', async (req: AuthedRequest) => {
    requireAdmin(req);
    const value = int(body(req.body), 'maxConcurrentStreams', { min: 1, max: 50 });
    await setNumber('max_concurrent_streams', value);
    return { maxConcurrentStreams: value };
  });

  // ── Nutzer ──────────────────────────────────────────────────

  app.get('/api/admin/users', async (req: AuthedRequest) => {
    requireAdmin(req);
    const users = await listUsers();
    const live = new Set(relayManager.activeSessions().map((a) => a.userId));
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        isAdmin: u.is_admin,
        isBlocked: u.is_blocked,
        language: u.language,
        wizardDone: u.wizard_done,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        live: live.has(u.id),
      })),
    };
  });

  app.post('/api/admin/users/:id/block', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const blocked = bool(body(req.body), 'blocked', true);
    if (id === admin.id) throw new BadRequest('cannot_block_self');

    await exec('UPDATE users SET is_blocked = $2 WHERE id = $1', [id, blocked]);
    if (blocked) {
      await exec('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      await relayManager.dropUser(id);
      await chatHub.stopForUser(id);
    }
    await audit(admin.id, blocked ? 'user_blocked' : 'user_unblocked', { target: id });
    return { ok: true, blocked };
  });

  app.delete('/api/admin/users/:id', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    if (id === admin.id) throw new BadRequest('cannot_delete_self');

    await relayManager.dropUser(id);
    await chatHub.stopForUser(id);
    await exec('DELETE FROM users WHERE id = $1', [id]);
    await audit(admin.id, 'user_deleted', { target: id });
    return { ok: true };
  });

  // ── Einladungen ─────────────────────────────────────────────

  app.get('/api/admin/invites', async (req: AuthedRequest) => {
    requireAdmin(req);
    const rows = await listInvites();
    return {
      invites: rows.map((i) => ({
        id: i.id,
        note: i.note,
        expiresAt: i.expires_at,
        usedAt: i.used_at,
        usedBy: i.used_email,
        createdBy: i.creator_email,
        createdAt: i.created_at,
      })),
    };
  });

  app.post('/api/admin/invites', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const b = body(req.body);
    const { url, invite } = await createInvite({
      createdBy: admin.id,
      note: str(b, 'note', { optional: true, max: 200 }),
      validDays: int(b, 'validDays', { min: 1, max: 90, fallback: 7 }),
    });
    await audit(admin.id, 'invite_created', { inviteId: invite.id });
    // Der Link wird nur hier einmal gezeigt - gespeichert ist nur sein Hash.
    return { url, expiresAt: invite.expires_at };
  });

  app.delete('/api/admin/invites/:id', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    await deleteInvite((req.params as { id: string }).id);
    await audit(admin.id, 'invite_deleted');
    return { ok: true };
  });

  // ── Viewbot-Simulator / Erkennungstest ──────────────────────

  app.get('/api/admin/sim/scenarios', async (req: AuthedRequest) => {
    requireAdmin(req);
    return {
      scenarios: SCENARIOS.map((s) => ({
        id: s,
        description: scenarioDescription(s),
        expected: expectedHints(s),
      })),
      defaults: defaultSimParams,
      thresholds: defaultDetectorConfig,
      note:
        'Simulierte Zuschauer werden in der Datenbank als synthetisch geführt und in Diagrammen und Exporten ' +
        'gekennzeichnet. Der Simulator beschickt nur die eigene Statistik, er sendet keinen Verkehr an die Plattformen.',
    };
  });

  app.post('/api/admin/sim/run', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const b = body(req.body);

    const userId = str(b, 'userId', { min: 1, max: 60 });
    const target = await getUserById(userId);
    if (!target) throw new BadRequest('user_not_found');

    const platform = str(b, 'platform', { min: 1, max: 20 });
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');

    const params: SimParams = {
      scenario: oneOf(b, 'scenario', SCENARIOS),
      platform,
      mode: oneOf(b, 'mode', ['offline', 'live'] as const, 'offline'),
      baseViewers: int(b, 'baseViewers', { min: 0, max: 100_000, fallback: defaultSimParams.baseViewers }),
      magnitude: int(b, 'magnitude', { min: 1, max: 1_000_000, fallback: defaultSimParams.magnitude }),
      durationMin: int(b, 'durationMin', { min: 5, max: 600, fallback: defaultSimParams.durationMin }),
      chatterRatio: Math.min(1, Math.max(0, Number(b.chatterRatio ?? defaultSimParams.chatterRatio))),
      seed: b.seed === undefined ? undefined : int(b, 'seed', { min: 1, max: 2 ** 31 - 1 }),
    };

    await audit(admin.id, 'sim_started', { target: userId, scenario: params.scenario, mode: params.mode });

    if (params.mode === 'live') {
      const { runId } = await simulator.startLive(userId, admin.id, params);
      return { mode: 'live', runId };
    }
    const result = await simulator.runOffline(userId, admin.id, params);
    return { mode: 'offline', result };
  });

  app.post('/api/admin/sim/:runId/stop', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const runId = (req.params as { runId: string }).runId;
    const run = await one<{ user_id: string }>('SELECT user_id FROM sim_runs WHERE id = $1', [runId]);
    if (!run) throw new BadRequest('run_not_found');
    await simulator.stopLive(run.user_id, runId);
    await audit(admin.id, 'sim_stopped', { runId });
    return { ok: true };
  });

  app.get('/api/admin/sim/runs', async (req: AuthedRequest) => {
    requireAdmin(req);
    const runs = await listRuns(60);
    return {
      runs: runs.map((r) => ({
        id: r.id,
        email: r.email,
        scenario: r.scenario,
        platform: r.platform,
        mode: r.mode,
        state: r.state,
        expected: r.expected,
        detected: r.detected,
        verdict: r.verdict,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        sessionId: r.session_id,
      })),
    };
  });

  app.get('/api/admin/sim/:runId', async (req: AuthedRequest) => {
    requireAdmin(req);
    const detail = await runDetail((req.params as { runId: string }).runId);
    if (!detail.run) throw new BadRequest('run_not_found');
    return detail;
  });

  app.delete('/api/admin/sim/:runId', async (req: AuthedRequest) => {
    const admin = requireAdmin(req);
    const runId = (req.params as { runId: string }).runId;
    await deleteRun(runId);
    await audit(admin.id, 'sim_deleted', { runId });
    return { ok: true };
  });

  // ── Protokoll ───────────────────────────────────────────────

  app.get('/api/admin/audit', async (req: AuthedRequest) => {
    requireAdmin(req);
    const rows = await query<{ id: number; action: string; detail: unknown; at: Date; email: string | null }>(
      `SELECT a.id, a.action, a.detail, a.at, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.at DESC LIMIT 200`,
    );
    return { entries: rows };
  });
}
