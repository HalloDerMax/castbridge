/* HTTP-Rauchtest ohne Datenbank: baut die App und fragt über
 * fastify.inject() die Pfade ab, die keine Datenbank brauchen. Prüft, dass
 * alle Routen registriert sind, der Zugangsschutz greift, die eigenen
 * Body-Parser arbeiten und die Oberfläche ausgeliefert wird. */
const { tmpDir, load, reporter } = require('./helpers');

process.env.DATA_DIR = tmpDir('http');
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-key-0123456789abcdefghijklmnopqrst';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.PUBLIC_URL = 'http://localhost:3000';
process.env.LOG_LEVEL = 'error';

const { build } = load('index.js');
const { check, finish } = reporter();

(async () => {
  const app = await build();
  const get = (url) => app.inject({ method: 'GET', url });
  const post = (url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });

  let r = await get('/api/health');
  check('GET /api/health -> 200', r.statusCode === 200 && JSON.parse(r.body).ok === true, String(r.statusCode));

  r = await get('/api/auth/me');
  check('GET /api/auth/me ohne Cookie -> 401', r.statusCode === 401, String(r.statusCode));

  r = await get('/api/stream/state');
  check('Dashboard-Zustand ohne Login -> 401', r.statusCode === 401, String(r.statusCode));

  r = await get('/api/admin/overview');
  check('Admin-Überblick ohne Login -> 401', r.statusCode === 401, String(r.statusCode));

  r = await post('/api/ingest/auth', { action: 'read', path: 'live/x' });
  check('MediaMTX-Hook, internes Lesen -> 200', r.statusCode === 200, String(r.statusCode));

  r = await post('/api/ingest/auth', { action: 'publish', path: 'falsch/x' });
  check('MediaMTX-Hook, falscher Pfad -> 401', r.statusCode === 401, String(r.statusCode));

  r = await post('/api/ingest/auth', { action: 'publish', path: 'live/' });
  check('MediaMTX-Hook, leerer Key -> 401', r.statusCode === 401, String(r.statusCode));

  r = await post('/api/platforms/kick/webhook', { content: 'hallo' }, { 'kick-event-type': 'chat.message.sent' });
  check('Kick-Webhook ohne Signatur -> 400', r.statusCode === 400, String(r.statusCode));

  r = await post('/api/auth/login', { email: 'kaputt', password: 'x' });
  check(
    'Login mit ungültiger Mail -> 400',
    r.statusCode === 400 && r.body.includes('invalid_email'),
    `${r.statusCode} ${r.body.slice(0, 50)}`,
  );

  r = await app.inject({
    method: 'POST',
    url: '/api/speedtest/upload',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(64 * 1024, 7),
  });
  check('Speedtest-Parser läuft, dann 401', r.statusCode === 401, String(r.statusCode));

  r = await get('/api/gibtsnicht');
  check('Unbekannter API-Pfad -> 404 JSON', r.statusCode === 404 && r.body.includes('not_found'), String(r.statusCode));

  r = await get('/dashboard');
  check('SPA-Pfad /dashboard -> index.html', r.statusCode === 200 && r.body.includes('<div id="root">'), String(r.statusCode));

  r = await get('/overlay/abc123');
  check('Overlay-Pfad -> index.html', r.statusCode === 200 && r.body.includes('<div id="root">'), String(r.statusCode));

  await app.close();
  finish();
})().catch((err) => {
  console.error('Abgebrochen:', err);
  process.exit(1);
});
