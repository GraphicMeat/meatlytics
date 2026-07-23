'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { buildDashboard } = require('../scripts/build');
const { tmpDbPath } = require('./helpers');

function makeApp(extraOpts) {
  const mw = analytics(Object.assign({ siteId: 'test', dbPath: tmpDbPath() }, extraOpts));
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return { mw, server };
}

test('dashboard with basePath rewrites api + world.svg fetches to the prefix', async () => {
  buildDashboard();
  const { mw, server } = makeApp({ basePath: '/s/x' });
  const res = await request(server).get('/_analytics').expect(200);
  assert.match(res.text, /var BASE = '\/s\/x'/);
  assert.match(res.text, /fetch\(BASE\+'\/gm\/api\/'/);
  assert.match(res.text, /fetch\(BASE\+'\/gm\/world\.svg'/);
  assert.ok(!/%BASE%/.test(res.text), 'basePath placeholder was substituted');
  mw.stop();
});

test('dashboard without basePath keeps default unprefixed paths', async () => {
  buildDashboard();
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics').expect(200);
  assert.match(res.text, /var BASE = ''/);
  assert.ok(!/%BASE%/.test(res.text), 'basePath placeholder was substituted');
  assert.match(res.text, /fetch\(BASE\+'\/gm\/api\/'/);
  assert.match(res.text, /fetch\(BASE\+'\/gm\/world\.svg'/);
  mw.stop();
});
