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

test('basePath with a single quote is rejected at construction', () => {
  assert.throws(
    () => analytics({ siteId: 'test', dbPath: tmpDbPath(), basePath: "/s/it's" }),
    /basePath must start with/
  );
});

test('basePath with a $ is rejected at construction', () => {
  assert.throws(
    () => analytics({ siteId: 'test', dbPath: tmpDbPath(), basePath: '/s/$&' }),
    /basePath must start with/
  );
});

test('basePath with dots, underscores, tildes and dashes is served verbatim', async () => {
  buildDashboard();
  const { mw, server } = makeApp({ basePath: '/s/my-shop.myshopify.com' });
  const res = await request(server).get('/_analytics').expect(200);
  assert.match(res.text, /var BASE = '\/s\/my-shop\.myshopify\.com'/);
  mw.stop();
});

test('dashboard with basePath hides the Settings entry point (gear button)', async () => {
  buildDashboard();
  const { mw, server } = makeApp({ basePath: '/s/x' });
  const res = await request(server).get('/_analytics').expect(200);
  assert.match(res.text, /id="gear"[^>]*class="hidden"/, 'gear button should carry the hidden class under a basePath mount');
  assert.ok(!/%GEARCLASS%/.test(res.text), 'gear class placeholder was substituted');
  mw.stop();
});

test('dashboard without basePath keeps the Settings entry point visible', async () => {
  buildDashboard();
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics').expect(200);
  assert.match(res.text, /id="gear"[^>]*class=""/, 'gear button should not be hidden on root mount');
  mw.stop();
});
