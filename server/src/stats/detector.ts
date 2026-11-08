import type { PlatformId } from '../config';

export interface Sample {
  at: Date;
  viewers: number;
  chatters: number;
  messages: number;
  synthetic?: boolean;
}

export interface RaidMarker {
  at: Date;
  amount: number;
}

export type HintType = 'spike' | 'drop' | 'flat_curve' | 'low_chat_ratio' | 'smooth_steps';

export interface Hint {
  type: HintType;
  at: Date;
  score: number;
  detail: Record<string, unknown>;
}

export interface DetectorConfig {
  /** Sprung: mindestens so viele Zuschauer und so viel Faktor auf einmal. */
  spikeMinAbsolute: number;
  spikeFactor: number;
  /** Ein Raid in diesem Fenster erklärt einen Sprung. */
  raidWindowSec: number;
  /** Glatte Kurve: Streuung unter diesem Wert bei mindestens so vielen Zuschauern. */
  flatMaxStdDev: number;
  flatMinViewers: number;
  flatWindow: number;
  /** Chatter-Verhältnis: unter diesem Anteil über das Fenster hinweg. */
  minChatRatio: number;
  chatRatioMinViewers: number;
  chatRatioWindow: number;
  /** Abfall: Faktor, um den die Zahl in einem Schritt einbricht. */
  dropFactor: number;
  dropMinAbsolute: number;
  /** Treppenmuster: Differenzen fast immer gleich groß. */
  smoothMaxDiffStdDev: number;
  smoothMinViewers: number;
  smoothWindow: number;
  /**
   * Zu gerader Anstieg: Güte einer Geraden durch das Fenster (0 bis 1).
   * Ein schleichender Bot-Zulauf liegt fast perfekt auf einer Linie, auch
   * wenn der organische Anteil darunter noch wackelt.
   */
  smoothMinR2: number;
}

export const defaultDetectorConfig: DetectorConfig = {
  spikeMinAbsolute: 25,
  spikeFactor: 2.5,
  raidWindowSec: 180,
  flatMaxStdDev: 1.2,
  flatMinViewers: 30,
  flatWindow: 10,
  minChatRatio: 0.005,
  chatRatioMinViewers: 50,
  chatRatioWindow: 15,
  dropFactor: 0.4,
  dropMinAbsolute: 25,
  smoothMaxDiffStdDev: 0.8,
  smoothMinViewers: 40,
  smoothWindow: 12,
  smoothMinR2: 0.97,
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (xs.length - 1));
}

/** Gerade durch die Werte legen und messen, wie gut sie passt. */
function linearFit(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = (n - 1) / 2;
  const my = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (values[i] - my);
    sxx += (i - mx) * (i - mx);
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - my) ** 2;
  }
  if (ssTot === 0) return { slope, r2: 0 };
  return { slope, r2: 1 - ssRes / ssTot };
}

function nearRaid(at: Date, raids: RaidMarker[], windowSec: number): RaidMarker | null {
  for (const r of raids) {
    if (Math.abs(r.at.getTime() - at.getTime()) <= windowSec * 1000) return r;
  }
  return null;
}

/**
 * Sucht Auffälligkeiten in einer Zuschauerkurve. Bewusst als Hinweis
 * formuliert, nicht als Urteil: jeder Treffer trägt einen Wert zwischen 0
 * und 1 und die Rohwerte, auf denen er beruht.
 *
 * Dieselbe Funktion läuft über echte und über simulierte Daten - nur so ist
 * der Erkennungstest überhaupt aussagekräftig.
 */
export function detect(
  samples: Sample[],
  raids: RaidMarker[] = [],
  cfg: DetectorConfig = defaultDetectorConfig,
): Hint[] {
  const hints: Hint[] = [];
  if (samples.length < 3) return hints;

  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());

  // 1. Sprünge und Einbrüche
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const delta = cur.viewers - prev.viewers;

    if (delta >= cfg.spikeMinAbsolute && cur.viewers >= prev.viewers * cfg.spikeFactor) {
      const raid = nearRaid(cur.at, raids, cfg.raidWindowSec);
      if (!raid) {
        const score = Math.min(1, delta / Math.max(cfg.spikeMinAbsolute * 4, 1));
        hints.push({
          type: 'spike',
          at: cur.at,
          score: Math.round(score * 1000) / 1000,
          detail: { from: prev.viewers, to: cur.viewers, delta, raid: false },
        });
      }
    }

    if (
      prev.viewers >= cfg.dropMinAbsolute &&
      cur.viewers <= prev.viewers * cfg.dropFactor &&
      prev.viewers - cur.viewers >= cfg.dropMinAbsolute
    ) {
      hints.push({
        type: 'drop',
        at: cur.at,
        score: Math.min(1, (prev.viewers - cur.viewers) / Math.max(prev.viewers, 1)),
        detail: { from: prev.viewers, to: cur.viewers },
      });
    }
  }

  // 2. Unnatürlich glatte Kurve
  for (let i = cfg.flatWindow; i <= ordered.length; i++) {
    const window = ordered.slice(i - cfg.flatWindow, i);
    const values = window.map((s) => s.viewers);
    const m = mean(values);
    if (m < cfg.flatMinViewers) continue;
    const sd = stdDev(values);
    if (sd <= cfg.flatMaxStdDev) {
      const last = window[window.length - 1];
      if (!hints.some((h) => h.type === 'flat_curve' && last.at.getTime() - h.at.getTime() < 10 * 60_000)) {
        hints.push({
          type: 'flat_curve',
          at: last.at,
          score: Math.round(Math.max(0, 1 - sd / Math.max(cfg.flatMaxStdDev, 0.001)) * 1000) / 1000,
          detail: { windowSamples: cfg.flatWindow, average: Math.round(m), stdDev: Math.round(sd * 100) / 100 },
        });
      }
    }
  }

  // 3. Zu wenige Chatter für die Zuschauerzahl
  for (let i = cfg.chatRatioWindow; i <= ordered.length; i++) {
    const window = ordered.slice(i - cfg.chatRatioWindow, i);
    const avgViewers = mean(window.map((s) => s.viewers));
    if (avgViewers < cfg.chatRatioMinViewers) continue;
    const avgChatters = mean(window.map((s) => s.chatters));
    const ratio = avgChatters / Math.max(avgViewers, 1);
    if (ratio < cfg.minChatRatio) {
      const last = window[window.length - 1];
      if (!hints.some((h) => h.type === 'low_chat_ratio' && last.at.getTime() - h.at.getTime() < 15 * 60_000)) {
        hints.push({
          type: 'low_chat_ratio',
          at: last.at,
          score: Math.round(Math.max(0, 1 - ratio / Math.max(cfg.minChatRatio, 0.0001)) * 1000) / 1000,
          detail: {
            averageViewers: Math.round(avgViewers),
            averageChatters: Math.round(avgChatters * 100) / 100,
            ratio: Math.round(ratio * 10_000) / 10_000,
          },
        });
      }
    }
  }

  // 4. Treppenmuster: immer derselbe Zuwachs, wie von einem Taktgeber
  for (let i = cfg.smoothWindow; i <= ordered.length; i++) {
    const window = ordered.slice(i - cfg.smoothWindow, i);
    const values = window.map((s) => s.viewers);
    if (mean(values) < cfg.smoothMinViewers) continue;
    const diffs: number[] = [];
    for (let k = 1; k < values.length; k++) diffs.push(values[k] - values[k - 1]);
    const diffSd = stdDev(diffs);
    const diffMean = mean(diffs);

    // Beide Wege verlangen einen STEIGENDEN Verlauf. Eine gleichmäßig
    // fallende Kurve ist normales Abfließen nach einem Raid und kein
    // Hinweis auf Botting - ein künstlicher Zulauf geht nach oben, und
    // ein künstliches Plateau fängt bereits 'flat_curve' ab.
    // Weg 1: Treppe - jeder Schritt gleich groß.
    const stepHit = diffSd <= cfg.smoothMaxDiffStdDev && diffMean >= 1;
    // Weg 2: zu gerader Anstieg - die Werte liegen fast perfekt auf einer Linie.
    const fit = linearFit(values);
    const lineHit = fit.r2 >= cfg.smoothMinR2 && fit.slope >= 1;

    if (stepHit || lineHit) {
      const last = window[window.length - 1];
      if (!hints.some((h) => h.type === 'smooth_steps' && last.at.getTime() - h.at.getTime() < 10 * 60_000)) {
        const stepScore = stepHit ? 1 - diffSd / Math.max(cfg.smoothMaxDiffStdDev, 0.001) : 0;
        const lineScore = lineHit ? (fit.r2 - cfg.smoothMinR2) / Math.max(1 - cfg.smoothMinR2, 0.001) : 0;
        hints.push({
          type: 'smooth_steps',
          at: last.at,
          score: Math.round(Math.min(1, Math.max(0, Math.max(stepScore, lineScore))) * 1000) / 1000,
          detail: {
            pattern: stepHit && lineHit ? 'steps+line' : stepHit ? 'steps' : 'line',
            direction: 'rising',
            stepAverage: Math.round(diffMean * 100) / 100,
            stepStdDev: Math.round(diffSd * 100) / 100,
            slopePerSample: Math.round(fit.slope * 100) / 100,
            fitQuality: Math.round(fit.r2 * 1000) / 1000,
            windowSamples: cfg.smoothWindow,
          },
        });
      }
    }
  }

  return hints.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Vergleicht Plattformen: Botting trifft meist nur eine von dreien. */
export function platformDivergence(
  perPlatform: Map<PlatformId, Sample[]>,
): { platform: PlatformId; share: number; others: number }[] {
  const totals: { platform: PlatformId; peak: number }[] = [];
  for (const [p, samples] of perPlatform) {
    let peak = 0;
    for (const s of samples) if (s.viewers > peak) peak = s.viewers;
    totals.push({ platform: p, peak });
  }
  const sum = totals.reduce((a, b) => a + b.peak, 0);
  if (sum === 0) return [];
  return totals
    .map((t) => ({
      platform: t.platform,
      share: Math.round((t.peak / sum) * 1000) / 1000,
      others: sum - t.peak,
    }))
    .filter((t) => t.share >= 0.9 && t.others > 0);
}
