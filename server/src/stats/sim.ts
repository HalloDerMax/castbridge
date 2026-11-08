import { PLATFORMS, type PlatformId } from '../config';
import { bus } from '../lib/bus';
import { exec, one, query } from '../lib/db';
import { logger } from '../lib/log';
import { detect, defaultDetectorConfig, type Hint, type RaidMarker, type Sample } from './detector';

const log = logger('sim');

/**
 * Viewbot-Simulator und Erkennungstest.
 *
 * Zweck: prüfen, ob die Auffälligkeiten-Erkennung aus Abschnitt 3.11 die
 * typischen Botting-Muster wirklich fängt - und bei welchen Schwellen sie
 * daneben greift. Die erzeugten Zuschauerzahlen sind synthetisch und werden
 * in der Datenbank als solche geführt (`synthetic = true`, `run_id`), damit
 * Messung und Simulation nie durcheinandergehen und ein Bericht an Partner
 * oder eine Agentur weiterhin stimmt.
 *
 * Der Simulator beschickt ausschließlich die eigene Statistik-Pipeline. Er
 * schickt keinen Verkehr an Twitch, YouTube oder Kick - deren Zuschauerzahlen
 * sind Messwerte der Plattformen und über keine Schnittstelle beschreibbar.
 */

export const SCENARIOS = [
  'sudden_spike',
  'flat_curve',
  'chatter_gap',
  'creeping_rise',
  'step_pattern',
  'raid_control',
] as const;

export type Scenario = (typeof SCENARIOS)[number];

export interface SimParams {
  scenario: Scenario;
  platform: PlatformId;
  mode: 'offline' | 'live';
  baseViewers: number;
  magnitude: number;
  durationMin: number;
  chatterRatio: number;
  seed?: number;
}

export const defaultSimParams: Omit<SimParams, 'scenario' | 'platform' | 'mode'> = {
  baseViewers: 40,
  magnitude: 300,
  durationMin: 45,
  chatterRatio: 0.06,
};

/** Welche Muster SOLLTEN bei diesem Szenario anschlagen. */
export function expectedHints(scenario: Scenario): string[] {
  switch (scenario) {
    case 'sudden_spike':
      return ['spike'];
    case 'flat_curve':
      return ['flat_curve'];
    case 'chatter_gap':
      return ['low_chat_ratio'];
    case 'creeping_rise':
      return ['smooth_steps'];
    case 'step_pattern':
      return ['smooth_steps'];
    case 'raid_control':
      // Gegenprobe: ein echter Raid darf KEINEN Treffer erzeugen.
      return [];
  }
}

export function scenarioDescription(scenario: Scenario): string {
  switch (scenario) {
    case 'sudden_spike':
      return 'Zuschauerzahl springt ohne Raid innerhalb einer Minute nach oben.';
    case 'flat_curve':
      return 'Zahl bleibt über viele Minuten fast auf den Zuschauer gleich.';
    case 'chatter_gap':
      return 'Viele Zuschauer, aber kaum Chatter.';
    case 'creeping_rise':
      return 'Gleichmäßiger Anstieg wie von einem Taktgeber.';
    case 'step_pattern':
      return 'Immer derselbe Zuwachs pro Minute, treppenförmig.';
    case 'raid_control':
      return 'Echter Raid mit Sprung - darf nicht als Auffälligkeit gelten.';
  }
}

// ── Zufall mit Startwert, damit Läufe wiederholbar sind ──────

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

interface GeneratedPoint {
  viewers: number;
  chatters: number;
  messages: number;
}

export interface GeneratedSeries {
  points: GeneratedPoint[];
  raidAtIndex: number | null;
  raidAmount: number;
}

/** Erzeugt die Kurve für ein Szenario, ein Punkt pro Minute. */
export function generateSeries(params: SimParams): GeneratedSeries {
  const rand = rng(params.seed ?? 20_261_108);
  const n = Math.max(5, Math.min(600, Math.round(params.durationMin)));
  const base = Math.max(0, params.baseViewers);
  const add = Math.max(0, params.magnitude);
  const points: GeneratedPoint[] = [];
  let raidAtIndex: number | null = null;
  let raidAmount = 0;

  const organicChatters = (viewers: number): number =>
    Math.max(0, Math.round(viewers * params.chatterRatio * (0.7 + rand() * 0.6)));

  const wobble = (v: number, pct = 0.08): number => Math.max(0, Math.round(v * (1 + (rand() - 0.5) * pct * 2)));

  const spikeAt = Math.floor(n * 0.35);

  for (let i = 0; i < n; i++) {
    const organic = wobble(base + Math.sin(i / 7) * Math.max(2, base * 0.15));

    switch (params.scenario) {
      case 'sudden_spike': {
        const botted = i >= spikeAt ? add : 0;
        const viewers = organic + botted;
        // Bots chatten nicht: die Chatter bleiben auf organischem Niveau.
        points.push({
          viewers,
          chatters: organicChatters(organic),
          messages: Math.round(organicChatters(organic) * (1.5 + rand())),
        });
        break;
      }
      case 'flat_curve': {
        const botted = i >= spikeAt ? add : 0;
        // Künstlicher Anteil ist absolut konstant, deshalb wird die Kurve glatt.
        const viewers = i >= spikeAt ? base + botted : organic;
        points.push({
          viewers,
          chatters: organicChatters(base),
          messages: Math.round(organicChatters(base) * (1.5 + rand())),
        });
        break;
      }
      case 'chatter_gap': {
        const viewers = organic + add;
        points.push({ viewers, chatters: Math.max(0, Math.round(organic * 0.002)), messages: 1 });
        break;
      }
      case 'creeping_rise': {
        const step = add / n;
        const viewers = Math.round(organic + step * i);
        points.push({
          viewers,
          chatters: organicChatters(organic),
          messages: Math.round(organicChatters(organic) * (1.5 + rand())),
        });
        break;
      }
      case 'step_pattern': {
        const step = Math.max(1, Math.round(add / n));
        const viewers = base + step * i;
        points.push({
          viewers,
          chatters: organicChatters(base),
          messages: Math.round(organicChatters(base) * 2),
        });
        break;
      }
      case 'raid_control': {
        if (i === spikeAt) {
          raidAtIndex = i;
          raidAmount = add;
        }
        // Ein echter Raid springt hoch und fließt dann wieder ab,
        // und die Mitgekommenen chatten auch.
        const since = i - spikeAt;
        const raidPart = since >= 0 ? add * Math.pow(0.5, since / 8) : 0;
        const effective = organic + raidPart;
        const viewers = wobble(effective, 0.06);
        points.push({
          viewers,
          chatters: organicChatters(effective),
          messages: Math.round(organicChatters(effective) * (1.5 + rand())),
        });
        break;
      }
    }
  }

  return { points, raidAtIndex, raidAmount };
}

export interface SimResult {
  runId: string;
  sessionId: string | null;
  scenario: Scenario;
  expected: string[];
  detected: string[];
  verdict: 'detected' | 'missed' | 'partial' | 'false_positive' | 'clean';
  hints: { type: string; at: string; score: number; detail: Record<string, unknown> }[];
  samples: { at: string; viewers: number; chatters: number }[];
}

function verdictFor(expected: string[], detected: string[]): SimResult['verdict'] {
  if (expected.length === 0) return detected.length === 0 ? 'clean' : 'false_positive';
  const hit = expected.filter((e) => detected.includes(e));
  if (hit.length === expected.length) return 'detected';
  if (hit.length === 0) return 'missed';
  return 'partial';
}

class Simulator {
  /** Aufschlag pro Nutzer und Plattform für den Live-Modus. */
  private readonly offsets = new Map<string, Map<PlatformId, number>>();
  private readonly liveTimers = new Map<string, NodeJS.Timeout>();

  liveOffsets(userId: string): Partial<Record<PlatformId, number>> {
    const m = this.offsets.get(userId);
    if (!m) return {};
    const out: Partial<Record<PlatformId, number>> = {};
    for (const [p, v] of m) out[p] = v;
    return out;
  }

  anyLive(userId: string): boolean {
    const m = this.offsets.get(userId);
    if (!m) return false;
    for (const v of m.values()) if (v !== 0) return true;
    return false;
  }

  /**
   * Offline-Lauf: erzeugt eine vollständige synthetische Sitzung, lässt den
   * echten Detektor darüber laufen und hält fest, was angeschlagen hat.
   */
  async runOffline(userId: string, createdBy: string, params: SimParams): Promise<SimResult> {
    const series = generateSeries(params);
    const expected = expectedHints(params.scenario);

    const session = await one<{ id: string }>(
      `INSERT INTO stream_sessions (user_id, title, has_simulation, started_at, ended_at)
       VALUES ($1, $2, true, now() - ($3 || ' minutes')::interval, now())
       RETURNING id`,
      [userId, `Simulation: ${params.scenario}`, String(series.points.length)],
    );
    const sessionId = session?.id ?? null;

    const run = await one<{ id: string }>(
      `INSERT INTO sim_runs (session_id, user_id, created_by, scenario, platform, params, mode, state, expected)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'offline','running',$7::jsonb)
       RETURNING id`,
      [sessionId, userId, createdBy, params.scenario, params.platform, JSON.stringify(params), JSON.stringify(expected)],
    );
    const runId = run?.id ?? '';

    const startMs = Date.now() - series.points.length * 60_000;
    const samples: Sample[] = [];

    for (let i = 0; i < series.points.length; i++) {
      const p = series.points[i];
      const at = new Date(startMs + i * 60_000);
      samples.push({ at, viewers: p.viewers, chatters: p.chatters, messages: p.messages, synthetic: true });
      if (sessionId) {
        await exec(
          `INSERT INTO viewer_samples (session_id, platform, at, viewers, chatters, messages, synthetic, run_id)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
          [sessionId, params.platform, at, p.viewers, p.chatters, p.messages, runId],
        );
      }
    }

    const raids: RaidMarker[] = [];
    if (series.raidAtIndex !== null && sessionId) {
      const at = new Date(startMs + series.raidAtIndex * 60_000);
      raids.push({ at, amount: series.raidAmount });
      await exec(
        `INSERT INTO stream_events (user_id, session_id, platform, type, actor, amount, payload, at)
         VALUES ($1,$2,$3,'raid','Simulation',$4,'{"simulated":true}'::jsonb,$5)`,
        [userId, sessionId, params.platform, series.raidAmount, at],
      );
    }

    const hints: Hint[] = detect(samples, raids, defaultDetectorConfig);
    const detected = Array.from(new Set(hints.map((h) => h.type)));
    const verdict = verdictFor(expected, detected);

    if (sessionId) {
      for (const h of hints) {
        await exec(
          `INSERT INTO anomalies (session_id, platform, type, detail, score, at, run_id)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
          [sessionId, params.platform, h.type, JSON.stringify(h.detail), h.score, h.at, runId],
        );
      }
    }

    await exec(
      `UPDATE sim_runs SET state = 'done', detected = $2::jsonb, verdict = $3, finished_at = now() WHERE id = $1`,
      [runId, JSON.stringify(detected), verdict],
    );

    bus.publish(userId, { type: 'sim', runId, state: 'done', detected, expected, verdict });
    log.info(`Simulation ${params.scenario}: erwartet [${expected.join(', ')}], erkannt [${detected.join(', ')}] -> ${verdict}`);

    return {
      runId,
      sessionId,
      scenario: params.scenario,
      expected,
      detected,
      verdict,
      hints: hints.map((h) => ({ type: h.type, at: h.at.toISOString(), score: h.score, detail: h.detail })),
      samples: samples.map((s) => ({ at: s.at.toISOString(), viewers: s.viewers, chatters: s.chatters })),
    };
  }

  /**
   * Live-Lauf: schlägt die simulierte Zahl auf die echte auf, damit im
   * Dashboard sichtbar wird, wie so ein Verlauf aussieht. Die Proben landen
   * mit `synthetic = true` in der Datenbank.
   */
  async startLive(userId: string, createdBy: string, params: SimParams): Promise<{ runId: string }> {
    const expected = expectedHints(params.scenario);
    const sessionIdRow = await one<{ id: string }>(
      `SELECT id FROM stream_sessions WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );

    const run = await one<{ id: string }>(
      `INSERT INTO sim_runs (session_id, user_id, created_by, scenario, platform, params, mode, state, expected)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'live','running',$7::jsonb)
       RETURNING id`,
      [
        sessionIdRow?.id ?? null,
        userId,
        createdBy,
        params.scenario,
        params.platform,
        JSON.stringify(params),
        JSON.stringify(expected),
      ],
    );
    const runId = run?.id ?? '';

    const series = generateSeries(params);
    let index = 0;

    const apply = (): void => {
      const point = series.points[Math.min(index, series.points.length - 1)];
      const organicGuess = Math.max(1, params.baseViewers);
      const offset = Math.max(0, point.viewers - organicGuess);
      let m = this.offsets.get(userId);
      if (!m) {
        m = new Map();
        this.offsets.set(userId, m);
      }
      m.set(params.platform, offset);
      index += 1;
      if (index >= series.points.length) void this.stopLive(userId, runId);
    };

    apply();
    const timer = setInterval(apply, 60_000);
    timer.unref();
    this.liveTimers.set(runId, timer);

    bus.publish(userId, { type: 'sim', runId, state: 'running', detected: [], expected, verdict: '' });
    log.info(`Live-Simulation gestartet: ${params.scenario} auf ${params.platform}`);
    return { runId };
  }

  async stopLive(userId: string, runId: string): Promise<void> {
    const timer = this.liveTimers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.liveTimers.delete(runId);
    }
    const m = this.offsets.get(userId);
    if (m) {
      for (const p of PLATFORMS) m.set(p, 0);
      this.offsets.delete(userId);
    }

    const row = await one<{ session_id: string | null; expected: string[] }>(
      'SELECT session_id, expected FROM sim_runs WHERE id = $1',
      [runId],
    );
    let detected: string[] = [];
    if (row?.session_id) {
      const hits = await query<{ type: string }>(
        'SELECT DISTINCT type FROM anomalies WHERE session_id = $1 AND at > now() - interval \'6 hours\'',
        [row.session_id],
      );
      detected = hits.map((h) => h.type);
    }
    const expected = Array.isArray(row?.expected) ? row.expected : [];
    const verdict = verdictFor(expected, detected);

    await exec(
      `UPDATE sim_runs SET state = 'stopped', detected = $2::jsonb, verdict = $3, finished_at = now()
        WHERE id = $1 AND state = 'running'`,
      [runId, JSON.stringify(detected), verdict],
    );
    bus.publish(userId, { type: 'sim', runId, state: 'stopped', detected, expected, verdict });
  }

  async stopAllFor(userId: string): Promise<void> {
    const runs = await query<{ id: string }>(
      "SELECT id FROM sim_runs WHERE user_id = $1 AND mode = 'live' AND state = 'running'",
      [userId],
    );
    for (const r of runs) await this.stopLive(userId, r.id);
  }
}

export const simulator = new Simulator();

export function liveOffsets(userId: string): Partial<Record<PlatformId, number>> {
  return simulator.liveOffsets(userId);
}

export interface SimRunRow {
  id: string;
  session_id: string | null;
  user_id: string;
  scenario: string;
  platform: string;
  mode: string;
  state: string;
  expected: string[];
  detected: string[];
  verdict: string;
  params: Record<string, unknown>;
  started_at: Date;
  finished_at: Date | null;
}

export async function listRuns(limit = 50): Promise<(SimRunRow & { email: string })[]> {
  return query<SimRunRow & { email: string }>(
    `SELECT r.*, u.email FROM sim_runs r JOIN users u ON u.id = r.user_id
      ORDER BY r.started_at DESC LIMIT $1`,
    [limit],
  );
}

export async function runDetail(runId: string): Promise<{
  run: SimRunRow | null;
  samples: { at: string; viewers: number; chatters: number }[];
  hints: { type: string; at: string; score: number; detail: Record<string, unknown> }[];
}> {
  const run = await one<SimRunRow>('SELECT * FROM sim_runs WHERE id = $1', [runId]);
  if (!run) return { run: null, samples: [], hints: [] };
  const samples = await query<{ at: Date; viewers: number; chatters: number }>(
    'SELECT at, viewers, chatters FROM viewer_samples WHERE run_id = $1 ORDER BY at',
    [runId],
  );
  const hints = await query<{ type: string; at: Date; score: string; detail: Record<string, unknown> }>(
    'SELECT type, at, score, detail FROM anomalies WHERE run_id = $1 ORDER BY at',
    [runId],
  );
  return {
    run,
    samples: samples.map((s) => ({ at: new Date(s.at).toISOString(), viewers: s.viewers, chatters: s.chatters })),
    hints: hints.map((h) => ({
      type: h.type,
      at: new Date(h.at).toISOString(),
      score: Number(h.score),
      detail: h.detail,
    })),
  };
}

export async function deleteRun(runId: string): Promise<void> {
  const run = await one<{ session_id: string | null }>('SELECT session_id FROM sim_runs WHERE id = $1', [runId]);
  await exec('DELETE FROM sim_runs WHERE id = $1', [runId]);
  // Die synthetische Sitzung mitnehmen, damit die Statistik sauber bleibt.
  if (run?.session_id) {
    await exec('DELETE FROM stream_sessions WHERE id = $1 AND has_simulation', [run.session_id]);
  }
}
