const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST = path.resolve(__dirname, '..', 'dist');

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `castbridge-test-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function load(relative) {
  return require(path.join(DIST, relative));
}

function probe(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || r.stdout.trim() === '') return null;
  return JSON.parse(r.stdout);
}

function ffmpeg(args) {
  return spawnSync('ffmpeg', args, { encoding: 'utf8' });
}

/**
 * Schickt die Datei genau so durch ffmpeg, wie es das Relay tut:
 * FLV herein, "-c copy", FLV hinaus. Das ist der Pfad, der im Betrieb zählt.
 * Gibt die Fehlerausgabe zurück, leer heißt fehlerfrei.
 *
 * Bewusst NICHT "-f null -": das dekodiert und kodiert neu, und bei
 * B-Frame-Material meldet der Null-Muxer dabei Zeitstempel-Warnungen, die
 * für die Weiterleitung ohne Neukodierung keine Bedeutung haben.
 */
function remuxLikeRelay(file) {
  const target = `${file}.remux.flv`;
  const r = ffmpeg(['-v', 'error', '-y', '-i', file, '-c', 'copy', '-f', 'flv', target]);
  return r.stderr.trim();
}

/** Prüft, dass sich die Datei auch wirklich dekodieren lässt. */
function decodeErrors(file) {
  const r = ffmpeg(['-v', 'error', '-i', file, '-f', 'null', '-']);
  return r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    // Die Warnung des Null-Muxers über Zeitstempel entsteht erst beim
    // Neukodieren und sagt nichts über den weitergeleiteten Strom.
    .filter((l) => !l.includes('non monotonically increasing dts to muxer'))
    .join(' | ');
}

/** Zählt Zeitstempel-Rückschritte je Spur. Zwischen Audio und Video darf
 *  verzahnt werden, das ist in FLV normal. */
function timestampRegressions(tags) {
  const last = {};
  let regressions = 0;
  for (const tag of tags) {
    const prev = last[tag.type];
    if (prev !== undefined && tag.timestamp < prev) regressions += 1;
    last[tag.type] = tag.timestamp;
  }
  return regressions;
}

function readTags(file) {
  const { FlvParser } = load('relay/flv.js');
  const tags = [];
  new FlvParser((t) => tags.push(t)).push(fs.readFileSync(file));
  return tags;
}

function reporter() {
  const results = [];
  return {
    check(name, ok, extra) {
      results.push(ok);
      console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` (${extra})` : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r).length;
      console.log(`${results.length - failed}/${results.length} Prüfungen bestanden`);
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}

module.exports = {
  DIST,
  tmpDir,
  load,
  probe,
  ffmpeg,
  remuxLikeRelay,
  decodeErrors,
  timestampRegressions,
  readTags,
  reporter,
};
