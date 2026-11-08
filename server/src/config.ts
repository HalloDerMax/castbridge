import * as crypto from 'crypto';
import * as path from 'path';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Umgebungsvariable ${name} fehlt. Siehe .env.example.`);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 32-Byte-Schlüssel aus SECRET_KEY. Fehlt er, gibt es im Dev-Betrieb einen
 * abgeleiteten Schlüssel plus Warnung, in Produktion einen harten Fehler.
 */
function secretKey(): Buffer {
  const raw = process.env.SECRET_KEY;
  if (raw && raw.length > 0) {
    const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 40;
    const buf = looksBase64 ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
    return crypto.createHash('sha256').update(buf).digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SECRET_KEY fehlt. Ohne ihn lassen sich keine Stream-Keys verschlüsseln.');
  }
  console.warn('[config] SECRET_KEY fehlt - benutze Entwicklungsschluessel. Nicht fuer Produktion.');
  return crypto.createHash('sha256').update('castbridge-dev-key').digest();
}

const dataDir = str('DATA_DIR', path.resolve(process.cwd(), 'data'));

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  ingestHost: str('INGEST_HOST', 'localhost'),
  ingestRtmpPort: num('INGEST_RTMP_PORT', 1935),
  ingestSrtPort: num('INGEST_SRT_PORT', 8890),

  databaseUrl: str('DATABASE_URL', 'postgres://castbridge:castbridge@localhost:5432/castbridge'),
  redisUrl: process.env.REDIS_URL ?? '',

  secretKey: secretKey(),
  sessionSecret: str('SESSION_SECRET', 'castbridge-dev-session'),

  adminEmail: process.env.ADMIN_EMAIL ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',

  mediamtxApiUrl: str('MEDIAMTX_API_URL', 'http://localhost:9997').replace(/\/+$/, ''),
  mediamtxRtmpUrl: str('MEDIAMTX_RTMP_URL', 'rtmp://localhost:1935').replace(/\/+$/, ''),
  ingestPathPrefix: str('MEDIAMTX_INGEST_PATH_PREFIX', 'live'),

  dataDir,
  uploadDir: path.join(dataDir, 'uploads'),
  standbyDir: path.join(dataDir, 'standby'),
  thumbDir: path.join(dataDir, 'thumbs'),
  bundledStandbyDir: path.resolve(process.cwd(), 'standby'),

  ffmpeg: str('FFMPEG_PATH', 'ffmpeg'),
  ffprobe: str('FFPROBE_PATH', 'ffprobe'),

  maxConcurrentStreams: num('MAX_CONCURRENT_STREAMS', 3),
  twitchMaxBitrateKbps: num('TWITCH_MAX_BITRATE_KBPS', 6000),

  oauth: {
    twitch: {
      clientId: process.env.TWITCH_CLIENT_ID ?? '',
      clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
    },
    youtube: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
    kick: {
      clientId: process.env.KICK_CLIENT_ID ?? '',
      clientSecret: process.env.KICK_CLIENT_SECRET ?? '',
    },
  },
};

export type PlatformId = 'twitch' | 'youtube' | 'kick';
export const PLATFORMS: PlatformId[] = ['twitch', 'youtube', 'kick'];

export function isPlatformId(v: string): v is PlatformId {
  return v === 'twitch' || v === 'youtube' || v === 'kick';
}

export function oauthConfigured(p: PlatformId): boolean {
  const c = config.oauth[p];
  return c.clientId !== '' && c.clientSecret !== '';
}

export function redirectUri(p: PlatformId): string {
  return `${config.publicUrl}/api/platforms/${p}/callback`;
}

export function ingestPath(ingestKey: string): string {
  return `${config.ingestPathPrefix}/${ingestKey}`;
}

export function ingestSourceUrl(ingestKey: string): string {
  return `${config.mediamtxRtmpUrl}/${ingestPath(ingestKey)}`;
}
