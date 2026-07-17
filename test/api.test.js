'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { buildDashboard } = require('../scripts/build');
const { tmpDbPath } = require('./helpers');

const PASS = 'letmein';
const KEY = 'secret-api-key';

function makeApp() {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath(), dashboardPassword: PASS, apiKey: KEY });
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

test('login: wrong password -> 401, correct -> cookie + token, token authorizes API', async () => {
  const { mw, server } = makeApp();
  await request(server).post('/_analytics/login').send({ password: 'nope' }).expect(401);

  const res = await request(server).post('/_analytics/login').send({ password: PASS }).expect(200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.token, 'returns bearer token');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /gm_dash=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/_analytics/);
  assert.match(cookie, /SameSite=Strict/);

  // session token works as bearer on the API
  await request(server)
    .get('/gm/api/realtime')
    .set('Authorization', 'Bearer ' + res.body.token)
    .expect(200);
  mw.stop();
});

test('dashboard HTML served, self-contained, <= 60KB', async () => {
  buildDashboard(); // ensure dist/dashboard.html exists + within gate
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics').expect(200).expect('Content-Type', /html/);
  const bytes = Buffer.byteLength(res.text, 'utf8');
  assert.ok(bytes <= 60 * 1024, 'dashboard ' + bytes + ' bytes <= 60KB');
  assert.ok(!/%TOKEN%/.test(res.text), 'token placeholder was substituted');
  assert.ok(!/https?:\/\//.test(res.text), 'no external hosts');
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
