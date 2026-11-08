/* Erkennungstest: jedes Simulator-Szenario wird erzeugt und durch den echten
 * Detektor geschickt. Fünf Muster müssen anschlagen, die Gegenprobe mit einem
 * echten Raid darf es nicht. */
const { load, reporter } = require('./helpers');

process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-key-0123456789abcdefghijklmnopqrst';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const { generateSeries, expectedHints, SCENARIOS, scenarioDescription } = load('stats/sim.js');
const { detect, defaultDetectorConfig } = load('stats/detector.js');
const { check, finish } = reporter();

const BASE = {
  platform: 'twitch',
  mode: 'offline',
  baseViewers: 40,
  magnitude: 300,
  durationMin: 45,
  chatterRatio: 0.06,
  seed: 20261108,
};

for (const scenario of SCENARIOS) {
  const series = generateSeries({ ...BASE, scenario });
  const start = Date.now() - series.points.length * 60_000;

  const samples = series.points.map((p, i) => ({
    at: new Date(start + i * 60_000),
    viewers: p.viewers,
    chatters: p.chatters,
    messages: p.messages,
    synthetic: true,
  }));

  const raids =
    series.raidAtIndex === null
      ? []
      : [{ at: new Date(start + series.raidAtIndex * 60_000), amount: series.raidAmount }];

  const detected = Array.from(new Set(detect(samples, raids, defaultDetectorConfig).map((h) => h.type)));
  const expected = expectedHints(scenario);

  if (expected.length === 0) {
    // Gegenprobe: ein echter Raid darf keinen Hinweis erzeugen.
    check(
      `${scenario}: korrekt nicht gemeldet`,
      detected.length === 0,
      detected.length === 0 ? scenarioDescription(scenario) : `falscher Alarm: ${detected.join(', ')}`,
    );
  } else {
    const missing = expected.filter((e) => !detected.includes(e));
    check(
      `${scenario}: ${expected.join(', ')} erkannt`,
      missing.length === 0,
      missing.length === 0 ? `erkannt: ${detected.join(', ')}` : `fehlt: ${missing.join(', ')}`,
    );
  }
}

finish();
