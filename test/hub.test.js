'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { tmpDbPath } = require('./helpers');

function boot(opts) {
  const mw = analytics(opts);
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ mw, server, port: server.address().port }));
  });
}

test('hub overview merges local + peer; unreachable peer -> ok:false, 200 overall', async () => {
  const peerKey = 'peer-key';
  const peer = await boot({ siteId: 'peer-site', dbPath: tmpDbPath(), apiKey: peerKey });
  const main = await boot({
    siteId: 'main-site',
    dbPath: tmpDbPath(),
    apiKey: 'main-key',
    peers: [{ name: 'peer-site', url: `http://127.0.0.1:${peer.port}`, apiKey: peerKey }],
  });

  const res = await request(main.server)
    .get('/gm/api/hub/overview')
    .set('Authorization', 'Bearer main-key')
    .expect(200)
    .expect('Content-Type', /json/);

  assert.strictEqual(res.body.sites.length, 2);
  assert.strictEqual(res.body.sites[0].name, 'main-site');
  assert.strictEqual(res.body.sites[0].ok, true);
  assert.ok('visitors' in res.body.sites[0].data);
  const peerSite = res.body.sites.find((s) => s.name === 'peer-site');
  assert.strictEqual(peerSite.ok, true);
  assert.ok('visitors' in peerSite.data);

  // Peer's API key never leaves this process -- the main app's response must not
  // contain it anywhere (defense against an accidental leak into JSON payloads).
  assert.ok(!JSON.stringify(res.body).includes(peerKey));

  peer.mw.stop();
  await new Promise((r) => peer.server.close(r));

  const res2 = await request(main.server)
    .get('/gm/api/hub/overview')
    .set('Authorization', 'Bearer main-key')
    .expect(200);
  const peerSite2 = res2.body.sites.find((s) => s.name === 'peer-site');
  assert.strictEqual(peerSite2.ok, false);
  assert.strictEqual(res2.body.sites[0].ok, true, 'local site unaffected by dead peer');
  assert.strictEqual(res2.body.sites[0].name, 'main-site');

  main.mw.stop();
  await new Promise((r) => main.server.close(r));
});

test('hub overview route requires the local apiKey like any other /gm/api/* route', async () => {
  const main = await boot({ siteId: 'solo', dbPath: tmpDbPath(), apiKey: 'k' });
  await request(main.server).get('/gm/api/hub/overview').expect(401);
  await request(main.server)
    .get('/gm/api/hub/overview')
    .set('Authorization', 'Bearer k')
    .expect(200)
    .expect((res) => {
      if (res.body.sites.length !== 1) throw new Error('expected only local site with no peers configured');
    });
  main.mw.stop();
  await new Promise((r) => main.server.close(r));
});

test('hub overview forwards ?compare=prev: local and peer both return previous', async () => {
  const peer = await boot({ siteId: 'peer-site', dbPath: tmpDbPath(), apiKey: 'pk' });
  const main = await boot({
    siteId: 'main-site',
    dbPath: tmpDbPath(),
    apiKey: 'main-key',
    peers: [{ name: 'peer-site', url: `http://127.0.0.1:${peer.port}`, apiKey: 'pk' }],
  });
  try {
    const res = await request(main.server)
      .get('/gm/api/hub/overview?from=2026-07-10&to=2026-07-16&compare=prev')
      .set('Authorization', 'Bearer main-key')
      .expect(200);
    for (const s of res.body.sites) {
      assert.strictEqual(s.ok, true);
      assert.strictEqual(s.data.previous.from, '2026-07-03', s.name);
      assert.strictEqual(s.data.previous.to, '2026-07-09', s.name);
    }
  } finally {
    peer.mw.stop();
    main.mw.stop();
    await new Promise((r) => peer.server.close(r));
    await new Promise((r) => main.server.close(r));
  }
});
