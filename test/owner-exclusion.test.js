'use strict';
// A logged-in dashboard owner is never tracked on the host site: login sets a
// signed, site-wide gm_owner cookie and the collector drops its events.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { tmpDbPath } = require('./helpers');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const KEY = 'owner-test-key';
const BATCH = { s: 'test', v: 1, e: [{ t: 'pageview', p: '/home' }] };

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

const rows = (mw) => mw.store.db.prepare('SELECT COUNT(*) c FROM events').get().c;
const cookieNamed = (res, name) =>
  (res.headers['set-cookie'] || []).find((c) => c.startsWith(name + '='));
const pair = (setCookie) => setCookie.split(';')[0];

async function login(server) {
  const res = await request(server).get('/_analytics/login?key=' + KEY).expect(302);
  return res;
}

test('login sets a site-wide, HttpOnly gm_owner cookie next to gm_dash', async () => {
  const { mw, server } = makeApp();
  const res = await login(server);
  const owner = cookieNamed(res, 'gm_owner');
  assert.ok(owner, 'gm_owner cookie set');
  assert.match(owner, /Path=\/(;|$)/);
  assert.match(owner, /HttpOnly/);
  assert.match(owner, /SameSite=Strict/);
  assert.ok(cookieNamed(res, 'gm_dash'), 'gm_dash still set');
  mw.stop();
});

test('beacon from a logged-in owner is dropped; anonymous one is recorded', async () => {
  const { mw, server } = makeApp();
  const res = await login(server);
  const ownerCookie = pair(cookieNamed(res, 'gm_owner'));

  await request(server).post('/gm/e').set('User-Agent', UA).set('Cookie', ownerCookie).send(BATCH).expect(204);
  mw.collector.flush();
  assert.strictEqual(rows(mw), 0, 'owner not tracked');

  await request(server).post('/gm/e').set('User-Agent', UA).send(BATCH).expect(204);
  mw.collector.flush();
  assert.strictEqual(rows(mw), 1, 'visitor still tracked');
  mw.stop();
});

test('forged or expired gm_owner cookie does not exclude', async () => {
  const { mw, server } = makeApp();
  await request(server).post('/gm/e').set('User-Agent', UA).set('Cookie', 'gm_owner=o9999999999999.deadbeef').send(BATCH).expect(204);
  await request(server).post('/gm/e').set('User-Agent', UA).set('Cookie', 'gm_owner=o1.deadbeef').send(BATCH).expect(204);
  mw.collector.flush();
  assert.strictEqual(rows(mw), 2);
  mw.stop();
});

test('a gm_dash session token is not accepted as an owner marker', async () => {
  const { mw, server } = makeApp();
  const sess = encodeURIComponent(mw.auth.makeSession());
  await request(server).post('/gm/e').set('User-Agent', UA).set('Cookie', 'gm_owner=' + sess).send(BATCH).expect(204);
  mw.collector.flush();
  assert.strictEqual(rows(mw), 1);
  mw.stop();
});

test('server-side track() skips a logged-in owner', async () => {
  const { mw, server } = makeApp();
  const res = await login(server);
  const ownerCookie = pair(cookieNamed(res, 'gm_owner'));
  const req = (cookie) => ({ url: '/download/app', headers: { 'user-agent': UA, ...(cookie ? { cookie } : {}) }, socket: {} });
  assert.strictEqual(mw.track(req(ownerCookie), { name: 'app' }), false);
  assert.strictEqual(mw.track(req(), { name: 'app' }), true);
  mw.collector.flush();
  assert.strictEqual(rows(mw), 1);
  mw.stop();
});

test('opening the dashboard with an existing session sets gm_owner (pre-upgrade sessions)', async () => {
  const { mw, server } = makeApp();
  const login1 = await login(server);
  const dash = pair(cookieNamed(login1, 'gm_dash'));
  const res = await request(server).get('/_analytics').set('Cookie', dash).expect(200);
  assert.ok(cookieNamed(res, 'gm_owner'), 'owner cookie refreshed on dashboard load');
  const anon = await request(server).get('/_analytics').expect(200);
  assert.ok(!cookieNamed(anon, 'gm_owner'), 'no cookie without a session');
  mw.stop();
});
