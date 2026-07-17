'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
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

test('login throttle: 10 fails from one IP locks it out, correct password still rejected; other IPs unaffected', async () => {
  const { mw, server } = makeApp();
  const ip = '1.2.3.4';
  for (let i = 0; i < 10; i++) {
    const res = await request(server)
      .post('/_analytics/login')
      .set('x-forwarded-for', ip)
      .send({ password: 'wrong' });
    assert.ok(res.status === 401 || res.status === 429, `attempt ${i + 1} got ${res.status}`);
  }
  // 11th attempt, even with the correct password, is throttled
  await request(server)
    .post('/_analytics/login')
    .set('x-forwarded-for', ip)
    .send({ password: PASS })
    .expect(429);

  // a different IP is completely unaffected
  await request(server)
    .post('/_analytics/login')
    .set('x-forwarded-for', '5.6.7.8')
    .send({ password: PASS })
    .expect(200);
  mw.stop();
});

test('successful login resets the fail counter', async () => {
  const { mw, server } = makeApp();
  const ip = '9.9.9.9';
  for (let i = 0; i < 5; i++) {
    await request(server)
      .post('/_analytics/login')
      .set('x-forwarded-for', ip)
      .send({ password: 'wrong' })
      .expect(401);
  }
  await request(server).post('/_analytics/login').set('x-forwarded-for', ip).send({ password: PASS }).expect(200);

  // counter was reset by the success -- 9 more fails must all still be plain 401s
  for (let i = 0; i < 9; i++) {
    await request(server)
      .post('/_analytics/login')
      .set('x-forwarded-for', ip)
      .send({ password: 'wrong' })
      .expect(401);
  }
  await request(server).post('/_analytics/login').set('x-forwarded-for', ip).send({ password: PASS }).expect(200);
  mw.stop();
});

test('secure cookie flag follows x-forwarded-proto', async () => {
  const { mw, server } = makeApp();
  const httpsRes = await request(server)
    .post('/_analytics/login')
    .set('x-forwarded-proto', 'https')
    .send({ password: PASS })
    .expect(200);
  assert.match(httpsRes.headers['set-cookie'][0], /; Secure/);

  const httpRes = await request(server).post('/_analytics/login').send({ password: PASS }).expect(200);
  assert.doesNotMatch(httpRes.headers['set-cookie'][0], /; Secure/);
  mw.stop();
});

test('magic link: good key redirects + sets a cookie that authenticates the dashboard', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics/login?key=' + KEY).expect(302);
  assert.strictEqual(res.headers.location, '/_analytics');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^gm_dash=/);
  assert.match(cookie, /Path=\/_analytics/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const dash = await request(server).get('/_analytics').set('Cookie', cookie).expect(200);
  assert.doesNotMatch(dash.text, /var TOKEN = null;/, 'session cookie should authenticate, not fall back to null token');
  mw.stop();
});

test('magic link: bad key is 401, no body oracle vs missing key', async () => {
  const { mw, server } = makeApp();
  const bad = await request(server).get('/_analytics/login?key=wrong').expect(401);
  const missing = await request(server).get('/_analytics/login').expect(401);
  assert.strictEqual(bad.text, missing.text);
  mw.stop();
});

test('magic link: repeated bad keys throttle the IP; correct key from same IP refused while throttled; other IPs unaffected', async () => {
  const { mw, server } = makeApp();
  const ip = '3.3.3.3';
  for (let i = 0; i < 10; i++) {
    const res = await request(server)
      .get('/_analytics/login?key=wrong')
      .set('x-forwarded-for', ip);
    assert.ok(res.status === 401 || res.status === 429, `attempt ${i + 1} got ${res.status}`);
  }
  await request(server)
    .get('/_analytics/login?key=' + KEY)
    .set('x-forwarded-for', ip)
    .expect(429);

  await request(server)
    .get('/_analytics/login?key=' + KEY)
    .set('x-forwarded-for', '4.4.4.4')
    .expect(302);
  mw.stop();
});

test('heat token: minted via GET /gm/api/token, works on heatmap, rejected on overview, tampered signature rejected', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/gm/api/token').set('Authorization', 'Bearer ' + KEY).expect(200);
  const t = res.body.token;
  assert.ok(t, 'token minted');

  await request(server).get('/gm/api/heatmap?path=/&vw=desktop&type=click&t=' + t).expect(200);
  // heatmap-route-only: the same token must not open other endpoints
  await request(server).get('/gm/api/overview?t=' + t).expect(401);

  // tamper with the signature half of the token -- must be rejected
  const dot = t.lastIndexOf('.');
  const sig = t.slice(dot + 1);
  const tampered = t.slice(0, dot + 1) + (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  await request(server).get('/gm/api/heatmap?path=/&vw=desktop&type=click&t=' + tampered).expect(401);
  mw.stop();
});
