/* Das Ersatzmedium: Standardbild erzeugen, exakt auf die Parameter eines
 * OBS-Signals aufbereiten und mitten im Strom darauf umschalten. */
const fs = require('fs');
const path = require('path');
const {
  tmpDir,
  load,
  probe,
  ffmpeg,
  remuxLikeRelay,
  timestampRegressions,
  readTags,
  reporter,
} = require('./helpers');

const dir = tmpDir('standby');
process.env.DATA_DIR = dir;
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-key-0123456789abcdefghijklmnopqrst';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const { ensureDefaultImage, buildStandbyArgs, x264Profile, x264Level } = load('relay/standby.js');
const { FlvSplicer } = load('relay/flv.js');
const { check, finish } = reporter();

const OBS = path.join(dir, 'obs.flv');
const STANDBY = path.join(dir, 'standby.flv');
const OUT = path.join(dir, 'out.flv');

// Im Betrieb kommen diese Werte per ffprobe aus dem OBS-Signal.
const PARAMS = {
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2500,
  audioSampleRate: 44100,
  audioChannels: 2,
  videoProfile: 'High',
  videoLevel: 41,
};

(async () => {
  // 1. Standardbild
  const image = await ensureDefaultImage();
  const imgInfo = probe(image);
  const img = imgInfo && imgInfo.streams && imgInfo.streams[0];
  check(
    'Standardbild liegt vor und ist lesbar',
    Boolean(img) && img.width === 1920 && img.height === 1080,
    img ? `${img.width}x${img.height} ${img.codec_name}` : 'nicht lesbar',
  );

  // 2. Aufbereiten
  fs.rmSync(STANDBY, { force: true });
  const enc = ffmpeg(buildStandbyArgs({ path: image, kind: 'image' }, PARAMS, STANDBY, false));
  check('Aufbereitung läuft durch', enc.status === 0, enc.status === 0 ? '' : enc.stderr.slice(0, 200));

  const sInfo = probe(STANDBY) || { streams: [] };
  const sv = sInfo.streams.find((s) => s.codec_type === 'video');
  const sa = sInfo.streams.find((s) => s.codec_type === 'audio');
  check(
    'Auflösung, Codec und Profil getroffen',
    Boolean(sv) && sv.width === 1280 && sv.height === 720 && sv.codec_name === 'h264' && sv.profile === 'High',
    sv ? `${sv.width}x${sv.height} ${sv.codec_name}/${sv.profile}` : 'kein Video',
  );
  check(
    'Tonspur passt (aac, 44100, stereo)',
    Boolean(sa) && sa.codec_name === 'aac' && Number(sa.sample_rate) === 44100 && sa.channels === 2,
    sa ? `${sa.codec_name} ${sa.sample_rate} ${sa.channels}ch` : 'kein Audio',
  );

  // 3. Profil-Zuordnung für alle drei Fälle, die OBS liefern kann
  for (const [profile, level, expected] of [
    ['Constrained Baseline', 31, 'Constrained Baseline'],
    ['Main', 40, 'Main'],
    ['High', 42, 'High'],
  ]) {
    const file = path.join(dir, `p-${x264Profile(profile)}-${level}.flv`);
    const args = buildStandbyArgs(
      { path: image, kind: 'image' },
      { ...PARAMS, width: 854, height: 480, fps: 25, bitrateKbps: 1200, audioSampleRate: 48000, videoProfile: profile, videoLevel: level },
      file,
      false,
    );
    const r = ffmpeg(args);
    const info = r.status === 0 ? probe(file) : null;
    const v = info && info.streams.find((s) => s.codec_type === 'video');
    check(
      `Profil ${profile}/${level} wird übernommen`,
      Boolean(v) && v.profile === expected && v.level === level,
      v ? `x264 ${x264Profile(profile)}/${x264Level(level)} -> ${v.profile}/${v.level}` : 'fehlgeschlagen',
    );
  }

  // 4. OBS-ähnliche Quelle mit denselben Parametern
  const obs = ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '5',
    // veryfast, damit das Profil wirklich High wird (ultrafast erzwingt Baseline).
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-f', 'flv', OBS,
  ]);
  if (obs.status !== 0) throw new Error(obs.stderr);

  const oInfo = probe(OBS) || { streams: [] };
  const ov = oInfo.streams.find((s) => s.codec_type === 'video');
  check(
    'Profil und Level von Ersatzbild und OBS-Signal stimmen überein',
    Boolean(ov) && Boolean(sv) && ov.profile === sv.profile && ov.level === sv.level,
    ov && sv ? `OBS ${ov.profile}/${ov.level} vs. Ersatz ${sv.profile}/${sv.level}` : 'nicht lesbar',
  );

  // 5. Umschalten mitten im Strom
  const splicer = new FlvSplicer('standby-test');
  splicer.setFrameRate(30);
  const out = fs.createWriteStream(OUT);
  splicer.addOutput('platform', out);

  for (const tag of readTags(OBS)) {
    if (tag.timestamp > 2500 && tag.type === 9) break;
    splicer.feed('obs', tag);
  }
  splicer.requestSource('standby');
  for (const tag of readTags(STANDBY)) splicer.feed('standby', tag);
  out.end();
  await new Promise((r) => out.on('close', r));

  const tags = readTags(OUT);
  const duration = Number((probe(OUT) || { format: {} }).format.duration || 0);
  const relayError = remuxLikeRelay(OUT);

  check('Quellenwechsel hat stattgefunden', splicer.switches === 1, String(splicer.switches));
  check('Keine Zeitstempel-Rückschritte pro Spur', timestampRegressions(tags) === 0, String(timestampRegressions(tags)));
  check('Strom läuft durch', duration > 10, `${duration.toFixed(2)} s`);
  check('Relay-Pfad fehlerfrei', relayError === '', relayError.slice(0, 200));

  finish();
})().catch((err) => {
  console.error('Abgebrochen:', err);
  process.exit(1);
});
