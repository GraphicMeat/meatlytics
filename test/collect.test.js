'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { tmpDbPath, dumpAll } = require('./helpers');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

function makeApp() {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath() });
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return { mw, server };
}

function rowCount(mw) {
  return mw.store.db.prepare('SELECT COUNT(*) c FROM events').get().c;
}

test('valid batch -> 204, rows appear after flush', async () => {
  const { mw, server } = makeApp();
  await request(server)
    .post('/gm/e')
    .set('User-Agent', UA)
    .send({ s: 'test', v: 1, e: [{ t: 'pageview', p: '/contact', r: 'https://google.com', w: 1440 }] })
    .expect(204);
  assert.strictEqual(rowCount(mw), 0, 'not written before flush');
  mw.collector.flush();
  assert.strictEqual(rowCount(mw), 1);
  const row = mw.store.db.prepare('SELECT * FROM events').get();
  assert.strictEqual(row.type, 'pageview');
  assert.strictEqual(row.path, '/contact');
  assert.strictEqual(row.ref_class, 'search');
  assert.ok(row.visitor && row.session_id, 'server stamped visitor + session');
  mw.stop();
});

test('malformed JSON -> 204, no rows', async () => {
  const { mw, server } = makeApp();
  await request(server)
    .post('/gm/e')
    .set('User-Agent', UA)
    .set('Content-Type', 'application/json')
    .send('{not json')
    .expect(204);
  mw.collector.flush();
  assert.strictEqual(rowCount(mw), 0);
  mw.stop();
});

test('bot UA -> dropped', async () => {
  const { mw, server } = makeApp();
  await request(server)
    .post('/gm/e')
    .set('User-Agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)')
    .send({ s: 'test', v: 1, e: [{ t: 'pageview', p: '/' }] })
    .expect(204);
  mw.collector.flush();
  assert.strictEqual(rowCount(mw), 0);
  mw.stop();
});

test('empty UA -> dropped', async () => {
  const { mw, server } = makeApp();
  await request(server)
    .post('/gm/e')
    .set('User-Agent', '')
    .send({ s: 'test', v: 1, e: [{ t: 'pageview', p: '/' }] })
    .expect(204);
  mw.collector.flush();
  assert.strictEqual(rowCount(mw), 0);
  mw.stop();
});

test('oversized batch -> capped at 50 events', async () => {
  const { mw, server } = makeApp();
  const e = Array.from({ length: 60 }, (_, i) => ({ t: 'pageview', p: '/p' + i }));
  await request(server).post('/gm/e').set('User-Agent', UA).send({ s: 'test', v: 1, e }).expect(204);
  mw.collector.flush();
  assert.strictEqual(rowCount(mw), 50);
  mw.stop();
});

test('mouse grid stored aggregated in props_json', async () => {
  const { mw, server } = makeApp();
  await request(server)
    .post('/gm/e')
    .set('User-Agent', UA)
    .send({ s: 'test', v: 1, e: [{ t: 'mouse', p: '/', w: 1440, dh: 3200, g: { '12:4': 9, '13:4': 22 } }] })
    .expect(204);
  mw.collector.flush();
  const row = mw.store.db.prepare("SELECT * FROM events WHERE type='mouse'").get();
  assert.deepStrictEqual(JSON.parse(row.props_json), { '12:4': 9, '13:4': 22 });
  mw.stop();
});

test('raw IP and UA are never stored in any table', async () => {
  const { mw, server } = makeApp();
  const IP = '203.0.113.77';
  const SECRET_UA = 'SECRET-UA-STRING-9f3a';
  await request(server)
    .post('/gm/e')
    .set('User-Agent', SECRET_UA)
    .set('X-Forwarded-For', IP)
    .send({ s: 'test', v: 1, e: [{ t: 'pageview', p: '/' }] })
    .expect(204);
  mw.collector.flush();
  const dump = dumpAll(mw.store.db);
  assert.ok(!dump.includes(IP), 'raw IP must not appear at rest');
  assert.ok(!dump.includes(SECRET_UA), 'raw UA must not appear at rest');
  mw.stop();
});
