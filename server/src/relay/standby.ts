import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../lib/log';
import { probe, runCommand } from '../lib/proc';
import { one } from '../lib/db';

const log = logger('standby');

export interface StreamParams {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  audioSampleRate: number;
  audioChannels: number;
  /** Profil des OBS-Signals, z. B. "High", "Main", "Constrained Baseline". */
  videoProfile: string;
  /** Level als Zahl, z. B. 41 für 4.1. */
  videoLevel: number | null;
}

export const FALLBACK_PARAMS: StreamParams = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 6000,
  audioSampleRate: 44100,
  audioChannels: 2,
  videoProfile: 'High',
  videoLevel: 41,
};

/**
 * Übersetzt das Profil des OBS-Signals in das, was libx264 versteht.
 * Weicht das Profil ab, bricht beim Umschalten unter Umständen die
 * Plattformverbindung - deshalb wird es übernommen, nicht geraten.
 */
export function x264Profile(profile: string): 'baseline' | 'main' | 'high' {
  const p = profile.toLowerCase();
  if (p.includes('baseline')) return 'baseline';
  if (p.includes('main')) return 'main';
  return 'high';
}

/** Level als x264-Schreibweise: 41 -> "4.1". */
export function x264Level(level: number | null): string {
  if (level === null || level <= 0) return '4.1';
  if (level >= 10) return `${Math.floor(level / 10)}.${level % 10}`;
  return String(level);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function signature(source: string, p: StreamParams): string {
  return crypto
    .createHash('sha1')
    .update(
      [
        source,
        p.width,
        p.height,
        p.fps,
        p.bitrateKbps,
        p.audioSampleRate,
        p.audioChannels,
        x264Profile(p.videoProfile),
        x264Level(p.videoLevel),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16);
}

/** Erzeugt einmalig ein Standardbild, falls keines mitgeliefert wurde. */
export async function ensureDefaultImage(): Promise<string> {
  ensureDir(config.standbyDir);
  const bundled = path.join(config.bundledStandbyDir, 'default.png');
  if (fs.existsSync(bundled)) return bundled;

  const generated = path.join(config.standbyDir, 'default.png');
  if (fs.existsSync(generated)) return generated;

  const fontCandidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'C\\:/Windows/Fonts/segoeuib.ttf',
    'C\\:/Windows/Fonts/arialbd.ttf',
  ];
  const font = fontCandidates.find((f) => fs.existsSync(f.replace('C\\:', 'C:')));

  const base = 'color=c=0x0b0f17:s=1920x1080,format=rgb24';
  const withGlow =
    `${base},drawbox=x=0:y=0:w=1920:h=1080:color=0x121a28@1:t=fill,` +
    'drawbox=x=0:y=460:w=1920:h=160:color=0x1b2638@1:t=fill';
  const vf = font
    ? `${withGlow},drawtext=fontfile='${font}':text='Gleich geht es weiter':fontcolor=0xe8eefc:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `drawtext=fontfile='${font}':text='Back shortly':fontcolor=0x7d8aa5:fontsize=38:x=(w-text_w)/2:y=(h-text_h)/2+90`
    : withGlow;

  const res = await runCommand(
    config.ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', vf, '-frames:v', '1', generated],
    30_000,
  );
  if (res.code !== 0 || !fs.existsSync(generated)) {
    // Letzter Ausweg: einfarbige Fläche ohne Text.
    await runCommand(
      config.ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', base, '-frames:v', '1', generated],
      30_000,
    );
  }
  if (!fs.existsSync(generated)) throw new Error('Standardbild konnte nicht erzeugt werden.');
  log.info('Standardbild erzeugt.');
  return generated;
}

export async function activeStandbySource(userId: string): Promise<{ path: string; kind: 'image' | 'video' } | null> {
  const row = await one<{ original_path: string; kind: string }>(
    'SELECT original_path, kind FROM standby_assets WHERE user_id = $1 AND active ORDER BY created_at DESC LIMIT 1',
    [userId],
  );
  if (row && fs.existsSync(row.original_path)) {
    return { path: row.original_path, kind: row.kind === 'video' ? 'video' : 'image' };
  }
  return null;
}

/**
 * Baut die ffmpeg-Argumente für die Aufbereitung. Getrennt, damit sich genau
 * diese Argumente testen lassen, ohne eine Datenbank zu brauchen.
 */
export function buildStandbyArgs(
  source: { path: string; kind: 'image' | 'video' },
  params: StreamParams,
  target: string,
  hasOwnAudio: boolean,
): string[] {
  const fps = Math.max(1, Math.min(120, Math.round(params.fps)));
  const gop = Math.max(2, fps * 2);
  const kbps = Math.max(800, Math.min(20_000, Math.round(params.bitrateKbps)));
  const width = params.width % 2 === 0 ? params.width : params.width + 1;
  const height = params.height % 2 === 0 ? params.height : params.height + 1;
  const channels = params.audioChannels >= 2 ? 2 : 1;

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];

  if (source.kind === 'image') {
    args.push('-loop', '1', '-framerate', String(fps), '-t', '10', '-i', source.path);
  } else {
    args.push('-i', source.path);
  }

  // Stille Tonspur, damit die Ausgänge durchgehend Audio sehen.
  args.push(
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=${channels === 2 ? 'stereo' : 'mono'}:sample_rate=${params.audioSampleRate}`,
  );

  args.push(
    '-map', '0:v:0',
    '-map', hasOwnAudio ? '0:a:0' : '1:a:0',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    // Profil und Level vom OBS-Signal übernehmen, nicht festnageln.
    '-profile:v', x264Profile(params.videoProfile),
    '-level', x264Level(params.videoLevel),
    '-pix_fmt', 'yuv420p',
    // Das Bild wird eingepasst und mit Rand aufgefüllt, damit es exakt die
    // Maße des OBS-Signals hat, ohne verzerrt zu werden.
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,setsar=1`,
    '-r', String(fps),
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-b:v', `${kbps}k`,
    '-maxrate', `${kbps}k`,
    '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', String(params.audioSampleRate),
    '-ac', String(channels),
    '-f', 'flv',
    target,
  );

  return args;
}

/**
 * Bereitet das Ersatzbild/-video so auf, dass es exakt zu den Parametern des
 * OBS-Signals passt: gleiche Auflösung, FPS, GOP-Länge, Profil, Pixelformat,
 * Bitrate und Audioformat. Nur dann kann der Splicer mitten im Stream
 * umschalten, ohne dass die Plattformen die Verbindung abbrechen.
 *
 * Das Ergebnis liegt im Cache. Ändern sich die OBS-Einstellungen, wird beim
 * nächsten Mal automatisch neu aufbereitet.
 */
export async function prepareStandby(
  userId: string,
  params: StreamParams,
): Promise<{ file: string; prepared: boolean } | null> {
  ensureDir(config.standbyDir);

  const own = await activeStandbySource(userId);
  const source = own ?? { path: await ensureDefaultImage(), kind: 'image' as const };

  const target = path.join(config.standbyDir, `${userId}-${signature(source.path, params)}.flv`);
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    return { file: target, prepared: false };
  }

  const hasOwnAudio = source.kind === 'video' ? (await probe(source.path))?.hasAudio === true : false;
  const args = buildStandbyArgs(source, params, target, hasOwnAudio);

  log.info(
    `Ersatzbild aufbereiten: ${params.width}x${params.height}@${params.fps}, ` +
      `${x264Profile(params.videoProfile)}/${x264Level(params.videoLevel)}`,
  );
  const res = await runCommand(config.ffmpeg, args, 180_000);
  if (res.code !== 0 || !fs.existsSync(target)) {
    log.error('Ersatzbild konnte nicht aufbereitet werden', res.stderr.slice(-600));
    return null;
  }
  return { file: target, prepared: true };
}

/** Räumt alte Cache-Dateien eines Nutzers weg (z. B. nach neuem Upload). */
export function clearPreparedStandby(userId: string): void {
  if (!fs.existsSync(config.standbyDir)) return;
  for (const f of fs.readdirSync(config.standbyDir)) {
    if (f.startsWith(`${userId}-`) && f.endsWith('.flv')) {
      try {
        fs.unlinkSync(path.join(config.standbyDir, f));
      } catch {
        /* egal */
      }
    }
  }
}
