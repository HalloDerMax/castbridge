import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { config } from '../config';
import { logger } from './log';

const log = logger('proc');

export interface ProbeResult {
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string;
  audioCodec: string;
  bitrateKbps: number | null;
  profile: string;
  level: number | null;
  pixelFormat: string;
  audioSampleRate: number | null;
  audioChannels: number | null;
  durationSec: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
}

function parseRate(v: string | undefined): number | null {
  if (!v) return null;
  const [a, b] = v.split('/');
  const num = Number(a);
  const den = Number(b ?? 1);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 && fps < 1000 ? Math.round(fps * 100) / 100 : null;
}

export function runCommand(
  bin: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Liest Auflösung, FPS, Codecs und Bitrate eines Eingangs (Datei oder RTMP-URL). */
export async function probe(input: string, timeoutMs = 20_000): Promise<ProbeResult | null> {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-analyzeduration', '3000000',
    '-probesize', '3000000',
  ];
  if (input.startsWith('rtmp://') || input.startsWith('rtsp://')) {
    args.push('-rw_timeout', '8000000');
  }
  args.push(input);

  const { code, stdout } = await runCommand(config.ffprobe, args, timeoutMs);
  if (code !== 0 || stdout.trim() === '') return null;
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: FfprobeStream[];
      format?: { bit_rate?: string; duration?: string };
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const formatBitrate = Number(parsed.format?.bit_rate ?? NaN);
    const videoBitrate = Number(video?.bit_rate ?? NaN);
    const bits = Number.isFinite(formatBitrate) ? formatBitrate : videoBitrate;
    return {
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
      videoCodec: video?.codec_name ?? '',
      audioCodec: audio?.codec_name ?? '',
      bitrateKbps: Number.isFinite(bits) && bits > 0 ? Math.round(bits / 1000) : null,
      profile: video?.profile ?? '',
      level: typeof video?.level === 'number' && video.level > 0 ? video.level : null,
      pixelFormat: video?.pix_fmt ?? '',
      audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
      audioChannels: audio?.channels ?? null,
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
      hasVideo: video !== undefined,
      hasAudio: audio !== undefined,
    };
  } catch (err) {
    log.warn('ffprobe-Ausgabe nicht lesbar', err);
    return null;
  }
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  readonly pid: number | undefined;
  stop(signal?: NodeJS.Signals): void;
}

export function spawnFfmpeg(args: string[], scope: string): ManagedProcess {
  const child = spawn(config.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let tail = '';
  child.stderr.on('data', (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4000);
    const line = d.toString().trim();
    if (/error|failed|invalid|unable/i.test(line)) log.warn(`${scope}: ${line.slice(0, 300)}`);
  });
  child.on('error', (err) => log.error(`${scope}: Prozessfehler`, err));
  Object.defineProperty(child, 'errorTail', { get: () => tail, configurable: true });
  return {
    child,
    get pid() {
      return child.pid;
    },
    stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          /* bereits beendet */
        }
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignorieren */
            }
          }
        }, 4000).unref();
      }
    },
  };
}

export function errorTail(p: ManagedProcess): string {
  const v = (p.child as unknown as { errorTail?: string }).errorTail;
  return (v ?? '').split('\n').filter((l) => l.trim() !== '').slice(-3).join(' | ').slice(0, 500);
}
