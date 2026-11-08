import { PLATFORMS, type PlatformId } from '../config';
import { bus } from '../lib/bus';
import { exec, one, query } from '../lib/db';
import { logger } from '../lib/log';
import { getUserById } from '../lib/users';
import { currentViewers } from '../platforms';
import { relayManager } from '../relay/manager';
import { chatHub } from '../chat/hub';
import { detect, defaultDetectorConfig, type RaidMarker, type Sample } from './detector';
import { liveOffsets } from './sim';

const log = logger('stats');

const INTERVAL_MS = 60_000;
const DETECT_WINDOW = 40;

class StatsCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
    this.timer.unref();
    log.info('Statistik-Sammler gestartet (jede Minute).');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Einmal abtasten. Wird auch vom Simulator im Live-Modus angestoßen. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const { userId, session } of relayManager.activeSessions()) {
        const sessionId = session.sessionId;
        if (!sessionId) continue;
        await this.sampleUser(userId, sessionId);
      }
    } catch (err) {
      log.warn('Abtastung fehlgeschlagen', err);
    } finally {
      this.running = false;
    }
  }

  private async sampleUser(userId: string, sessionId: string): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;

    const counters = chatHub.takeCounters(userId);
    const rates = chatHub.rates(userId);
    const offsets = liveOffsets(userId);

    const perPlatform: Partial<Record<PlatformId, number>> = {};
    let total = 0;
    let simulatedTotal = 0;

    for (const platform of PLATFORMS) {
      const state = relayManager.session(userId)?.platformState(platform).state ?? 'idle';
      if (state === 'idle' || state === 'error') continue;

      const real = await currentViewers(user, platform);
      const offset = offsets[platform] ?? 0;
      if (real === null && offset === 0) continue;

      const value = Math.max(0, (real ?? 0) + offset);
      perPlatform[platform] = value;
      total += value;
      simulatedTotal += offset;

      await exec(
        `INSERT INTO viewer_samples (session_id, platform, viewers, chatters, messages, synthetic)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          platform,
          value,
          counters.chatters[platform] ?? 0,
          counters.messages[platform] ?? 0,
          offset !== 0,
        ],
      );
    }

    if (Object.keys(perPlatform).length === 0) return;

    bus.publish(userId, { type: 'viewers', perPlatform, total, simulated: simulatedTotal });

    await exec(
      `UPDATE stream_sessions
          SET peak_viewers = GREATEST(peak_viewers, $2),
              messages = messages + $3,
              has_simulation = has_simulation OR $4
        WHERE id = $1`,
      [sessionId, total, rates.messagesPerMinute, simulatedTotal !== 0],
    );

    await this.runDetection(userId, sessionId);
  }

  /** Erkennung über das jüngste Fenster. Neue Treffer werden gemeldet. */
  async runDetection(userId: string, sessionId: string): Promise<void> {
    for (const platform of PLATFORMS) {
      const rows = await query<{ at: Date; viewers: number; chatters: number; messages: number; synthetic: boolean }>(
        `SELECT at, viewers, chatters, messages, synthetic
           FROM viewer_samples
          WHERE session_id = $1 AND platform = $2
          ORDER BY at DESC
          LIMIT $3`,
        [sessionId, platform, DETECT_WINDOW],
      );
      if (rows.length < 3) continue;

      const samples: Sample[] = rows
        .map((r) => ({
          at: new Date(r.at),
          viewers: r.viewers,
          chatters: r.chatters,
          messages: r.messages,
          synthetic: r.synthetic,
        }))
        .reverse();

      const raidRows = await query<{ at: Date; amount: number }>(
        `SELECT at, amount FROM stream_events
          WHERE session_id = $1 AND platform = $2 AND type IN ('raid', 'host')
          ORDER BY at DESC LIMIT 20`,
        [sessionId, platform],
      );
      const raids: RaidMarker[] = raidRows.map((r) => ({ at: new Date(r.at), amount: r.amount }));

      const hints = detect(samples, raids, defaultDetectorConfig);
      for (const hint of hints) {
        const exists = await one<{ id: number }>(
          `SELECT id FROM anomalies
            WHERE session_id = $1 AND platform = $2 AND type = $3 AND abs(extract(epoch from (at - $4::timestamptz))) < 30
            LIMIT 1`,
          [sessionId, platform, hint.type, hint.at],
        );
        if (exists) continue;

        const row = await one<{ id: number }>(
          `INSERT INTO anomalies (session_id, platform, type, detail, score, at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
          [sessionId, platform, hint.type, JSON.stringify(hint.detail), hint.score, hint.at],
        );
        if (row) {
          bus.publish(userId, {
            type: 'anomaly',
            hint: {
              id: row.id,
              platform,
              type: hint.type === 'smooth_steps' ? 'flat_curve' : hint.type,
              at: hint.at.toISOString(),
              score: hint.score,
              detail: hint.detail,
            },
          });
        }
      }
    }
  }
}

export const statsCollector = new StatsCollector();
