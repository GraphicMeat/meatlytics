'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { buildDashboard } = require('../scripts/build');
const { tmpDbPath } = require('./helpers');

const KEY = 'secret-api-key';

function makeApp() {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath(), apiKey: KEY });
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return { mw, server };
}

test('api requires auth: no key -> 401', async () => {
  const { mw, server } = makeApp();
  await request(server).get('/gm/api/overview').expect(401);
  mw.stop();
});

test('api bad key -> 401', async () => {
  const { mw, server } = makeApp();
  await request(server).get('/gm/api/overview').set('Authorization', 'Bearer wrong').expect(401);
  mw.stop();
});

test('api good key -> 200 JSON', async () => {
  const { mw, server } = makeApp();
  const res = await request(server)
    .get('/gm/api/overview')
    .set('Authorization', 'Bearer ' + KEY)
    .expect(200)
    .expect('Content-Type', /json/);
  assert.ok('visitors' in res.body && 'timeseries' in res.body);
  mw.stop();
});

// track() is the server-side conversion hook the /download redirect routes call;
// it must land in the events table and surface through /gm/api/conversions.
test('conversions: track() records a download attributed to the Referer page', async () => {
  const { mw, server } = makeApp();
  const req = {
    url: '/download/meatpad',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
      host: 'example.com',
      referer: 'https://example.com/meatpad',
    },
    socket: { remoteAddress: '1.2.3.4' },
  };
  assert.strictEqual(mw.track(req, { type: 'pageview', path: '/meatpad' }), true);
  assert.strictEqual(mw.track(req, { name: 'meatpad' }), true);
  assert.strictEqual(mw.track({ headers: { 'user-agent': 'Googlebot/2.1' } }, { name: 'x' }), false);
  mw.collector.flush();

  const res = await request(server)
    .get('/gm/api/conversions')
    .set('Authorization', 'Bearer ' + KEY)
    .expect(200)
    .expect('Content-Type', /json/);
  assert.strictEqual(res.body.converted, 1);
  assert.strictEqual(res.body.base, 1);
  assert.strictEqual(res.body.rate, 1);
  assert.deepStrictEqual(res.body.paths[0].path, '/meatpad'); // the page, not /download/meatpad
  assert.strictEqual(res.body.files[0].name, 'meatpad');
  mw.stop();
});

test('magic link login: wrong key -> 401, correct -> cookie, cookie session mints a bearer usable on the API', async () => {
  const { mw, server } = makeApp();
  await request(server).get('/_analytics/login?key=nope').expect(401);

  const res = await request(server).get('/_analytics/login?key=' + KEY).expect(302);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /gm_dash=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/_analytics/);
  assert.match(cookie, /SameSite=Strict/);

  // session cookie works directly as API auth
  await request(server).get('/gm/api/realtime').set('Cookie', cookie).expect(200);
  mw.stop();
});

test('dashboard HTML served, self-contained, <= 60KB', async () => {
  buildDashboard(); // ensure dist/dashboard.html exists + within gate
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics').expect(200).expect('Content-Type', /html/);
  const bytes = Buffer.byteLength(res.text, 'utf8');
  assert.ok(bytes <= 60 * 1024, 'dashboard ' + bytes + ' bytes <= 60KB');
  assert.ok(!/%TOKEN%/.test(res.text), 'token placeholder was substituted');
  assert.ok(!/%PREVIEW%/.test(res.text), 'preview placeholder was substituted');
  assert.ok(!/https?:\/\//.test(res.text), 'no external hosts');
  mw.stop();
});

test('previewPath lands in dashboard HTML for the heatmap iframe', async () => {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath(), previewPath: '/s/x/preview' });
  const server = http.createServer((req, res) => mw(req, res, () => res.end()));
  const res = await request(server).get('/_analytics').expect(200);
  assert.ok(res.text.includes("var PREVIEW = '/s/x/preview'"), 'PREVIEW substituted');
  assert.ok(mw.auth.checkHeat(mw.auth.makeHeatToken()), 'checkHeat accepts fresh heat token');
  assert.ok(!mw.auth.checkHeat('h123.bogus'), 'checkHeat rejects bad token');
  assert.throws(() => analytics({ siteId: 'x', dbPath: tmpDbPath(), previewPath: 'https://evil.example' }));
  mw.stop();
});

test('heat token authorizes only the heatmap route', async () => {
  const { mw, server } = makeApp();
  const t = mw.auth.makeHeatToken();
  await request(server).get('/gm/api/heatmap?path=/&vw=desktop&type=click&t=' + t).expect(200);
  // same token must not open other endpoints
  await request(server).get('/gm/api/overview?t=' + t).expect(401);
  mw.stop();
});

test('api good key -> /gm/api/countries returns array', async () => {
  const { mw, server } = makeApp();
  const res = await request(server)
    .get('/gm/api/countries')
    .set('Authorization', 'Bearer ' + KEY)
    .expect(200)
    .expect('Content-Type', /json/);
  assert.ok(Array.isArray(res.body));
  mw.stop();
});

test('/gm/world.svg -> served with no auth required', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/gm/world.svg').expect(200);
  assert.match(res.headers['content-type'], /svg/);
  mw.stop();
});

test('/gm/world.svg -> 404 when the asset file is absent', async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const real = path.join(__dirname, '..', 'src', 'dashboard', 'world.svg');
  const tmp = real + '.bak';
  fs.renameSync(real, tmp);
  try {
    const { mw, server } = makeApp();
    await request(server).get('/gm/world.svg').expect(404);
    mw.stop();
  } finally {
    fs.renameSync(tmp, real);
  }
});

test('gm-overlay.js is served', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/gm-overlay.js').expect(200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /export function init/);
  mw.stop();
});

test('excluded paths: session-only settings route persists list, API applies it', async () => {
  const { mw, server } = makeApp();
  await request(server).get('/_analytics/api/excludes').expect(401);
  await request(server).post('/_analytics/api/excludes').send({ paths: ['/x'] }).expect(401);

  const login = await request(server).get('/_analytics/login?key=' + KEY).expect(302);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const saved = await request(server)
    .post('/_analytics/api/excludes')
    .set('Cookie', cookie)
    .send({ paths: ['https://example.com/downloads/', '/downloads'] })
    .expect(200);
  assert.deepStrictEqual(saved.body, { paths: ['/downloads'] });
  const got = await request(server).get('/_analytics/api/excludes').set('Cookie', cookie).expect(200);
  assert.deepStrictEqual(got.body, { paths: ['/downloads'] });
  await request(server).post('/_analytics/api/excludes').set('Cookie', cookie).send({ nope: 1 }).expect(400);

  const today = new Date().toISOString().slice(0, 10);
  mw.store.insertEvents([
    { ts: Date.now(), site_id: 'test', visitor: 'A', session_id: 'sA', type: 'pageview', path: '/', country: 'LT' },
    { ts: Date.now(), site_id: 'test', visitor: 'B', session_id: 'sB', type: 'pageview', path: '/downloads', country: 'LT' },
  ]);
  const auth = { Authorization: 'Bearer ' + KEY };
  const o = await request(server).get(`/gm/api/overview?from=${today}&to=${today}`).set(auth).expect(200);
  assert.strictEqual(o.body.visitors, 2);
  assert.strictEqual(o.body.filtered.visitors, 1);
  assert.deepStrictEqual(o.body.excluded, ['/downloads']);
  const c = await request(server).get(`/gm/api/countries?from=${today}&to=${today}`).set(auth).expect(200);
  assert.deepStrictEqual(c.body, [{ country: 'LT', visitors: 2, visitorsFiltered: 1 }]);
  mw.stop();
});
