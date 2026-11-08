/* Alle Tests hintereinander. Vorher "npm run build" ausführen.
 * Aufruf: npm test */
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const dist = path.resolve(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(dist, 'relay', 'flv.js'))) {
  console.error('dist/ fehlt. Zuerst "npm run build" ausführen.');
  process.exit(1);
}

// Nur Dateien, die wirklich vorhanden sind. Weitere Tests einfach als
// "<name>.test.js" in dieses Verzeichnis legen.
const tests = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (tests.length === 0) {
  console.error('Keine Testdateien in server/test gefunden.');
  process.exit(1);
}

let failed = 0;
for (const file of tests) {
  console.log(`\n=== ${file} ${'='.repeat(Math.max(0, 56 - file.length))}`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed += 1;
}

console.log(`\n${tests.length - failed}/${tests.length} Testdateien bestanden`);
process.exit(failed === 0 ? 0 : 1);
