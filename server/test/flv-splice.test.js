/* Der Umschalter: zwei Quellen mit gleichen Parametern werden mitten im Strom
 * getauscht. Erwartung: ein durchgehender FLV-Strom, Zeitstempel laufen pro
 * Spur weiter, ffmpeg liest das Ergebnis ohne Fehler. */
const fs = require('fs');
const path = require('path');
const {
  tmpDir,
  load,
  probe,
  ffmpeg,
  remuxLikeRelay,
  decodeErrors,
  timestampRegressions,
  readTags,
  reporter,
} = require('./helpers');

process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-key-0123456789abcdefghijklmnopqrst';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const { FlvSplicer } = load('relay/flv.js');
const { check, finish } = reporter();

const dir = tmpDir('flv');
const A = path.join(dir, 'a.flv');
const B = path.join(dir, 'b.flv');
const OUT = path.join(dir, 'out.flv');

const ENCODE = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
  '-pix_fmt', 'yuv420p', '-s', '1280x720', '-r', '30', '-g', '60', '-keyint_min', '60',
  '-sc_threshold', '0', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-f', 'flv',
];

function make(file, video, audio) {
  const r = ffmpeg(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio, '-t', '6', ...ENCODE, file]);
  if (r.status !== 0) throw new Error(`ffmpeg (${file}): ${r.stderr}`);
}

make(A, 'testsrc2=size=1280x720:rate=30', 'sine=frequency=440:sample_rate=44100');
make(B, 'color=c=0x102030:size=1280x720:rate=30', 'sine=frequency=220:sample_rate=44100');

const splicer = new FlvSplicer('test');
splicer.setFrameRate(30);
const out = fs.createWriteStream(OUT);
splicer.addOutput('platform', out);

for (const tag of readTags(A)) {
  if (tag.timestamp > 3000 && tag.type === 9) break;
  splicer.feed('a', tag);
}
splicer.requestSource('b');
for (const tag of readTags(B)) splicer.feed('b', tag);
out.end();

out.on('close', () => {
  const tags = readTags(OUT);
  const info = probe(OUT) || { streams: [], format: {} };
  const streams = info.streams.map((s) => `${s.codec_type}:${s.codec_name}`);
  const duration = Number(info.format.duration || 0);
  const relayError = remuxLikeRelay(OUT);
  const decodeError = decodeErrors(OUT);

  check('Quellenwechsel auf einem Keyframe', splicer.switches === 1, String(splicer.switches));
  check('Keine Zeitstempel-Rückschritte pro Spur', timestampRegressions(tags) === 0, String(timestampRegressions(tags)));
  check('Video- und Tonspur erhalten', streams.includes('video:h264') && streams.includes('audio:aac'), streams.join(', '));
  check('Strom läuft über den Wechsel hinaus', duration > 7.5, `${duration.toFixed(2)} s`);
  check('Relay-Pfad (-c copy -f flv) fehlerfrei', relayError === '', relayError.slice(0, 200));
  check('Strom lässt sich dekodieren', decodeError === '', decodeError.slice(0, 200));
  finish();
});
