'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { openStore } = require('../src/store');
const { normalize, createReleases, createGithub } = require('../src/github');
const { tmpDbPath, at } = require('./helpers');

const SITE = 'test';

function release(tag, published, assets, extra = {}) {
  return {
    tag_name: tag,
    published_at: published,
    html_url: `https://github.com/o/n/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: assets.map(([name, download_count]) => ({ name, download_count })),
    ...extra,
  };
}

// Fake fetch: serves `body` for every repo, counts calls.
function fakeFetch(body, { status = 200 } = {}) {
  const f = async () => {
    f.calls++;
    return { ok: status === 200, status, json: async () => body };
  };
  f.calls = 0;
  return f;
}

// v1 09-01, v2 09-10, v3 09-20 (latest). Installer + noise assets on each.
const RELEASES = [
  release('v1', '2026-09-01T00:00:00Z', [['App.dmg', 30]]),
  release('v2', '2026-09-10T00:00:00Z', [['App.dmg', 50], ['App.dmg.sig', 5], ['appcast.xml', 999], ['App.zip', 7]]),
  release('v3', '2026-09-20T00:00:00Z', [['App.dmg', 10]]),
];

function dl(visitor, ts, extra = {}) {
  return { ts, site_id: SITE, visitor, session_id: 's' + visitor, type: 'download', path: '/app', name: 'meatpad', ...extra };
}

async function report(cfg, events, fetchBody = RELEASES, exclude = []) {
  const store = openStore(tmpDbPath());
  store.insertEvents(events);
  const gh = createGithub({ github: cfg, githubFetch: fakeFetch(fetchBody) });
  const out = await gh.report(store.db, { siteId: SITE, exclude });
  store.close();
  return out;
}

test('normalize: string, github.com URL, object, array; defaults', () => {
  assert.deepStrictEqual(normalize(undefined), []);
  const [a] = normalize('GraphicMeat/MeatPad');
  assert.strictEqual(a.repo, 'GraphicMeat/MeatPad');
  assert.strictEqual(a.type, 'download');
  assert.strictEqual(a.name, null);
  assert.ok(a.assets.test('MeatPad-1.2.dmg') && a.assets.test('Setup.EXE') && a.assets.test('a.AppImage'));
  assert.ok(!a.assets.test('appcast.xml') && !a.assets.test('latest.json') && !a.assets.test('App.dmg.sig'));

  assert.strictEqual(normalize('https://github.com/GraphicMeat/MeatPad/releases')[0].repo, 'GraphicMeat/MeatPad');
  assert.strictEqual(normalize({ repo: 'https://github.com/o/releases' })[0].repo, 'o/releases');

  const [b, c] = normalize([
    { repo: 'o/a', site: 'download:meatpad', assets: '\\.pkg$' },
    { repo: 'o/b', site: 'event:download_action' },
  ]);
  assert.deepStrictEqual([b.type, b.name, b.assets.test('X.pkg')], ['download', 'meatpad', true]);
  assert.deepStrictEqual([c.type, c.name], ['custom', 'download_action']);
});

test('normalize: rejects bad repo, bad site, nameless event', () => {
  assert.throws(() => normalize('nope'), /owner\/name/);
  assert.throws(() => normalize({ repo: 'a/b/../c' }), /owner\/name/);
  assert.throws(() => normalize({}), /owner\/name/);
  assert.throws(() => normalize({ repo: 'o/n', site: 'pageview' }), /site must be/);
  assert.throws(() => normalize({ repo: 'o/n', site: 'event' }), /site must be/);
  assert.throws(() => normalize({ repo: 'o/n', assets: '(' }));
});

test('analytics(): bad opts.github throws before the DB file exists', () => {
  const dbPath = tmpDbPath();
  assert.throws(() => analytics({ siteId: SITE, dbPath, github: 'nope' }), /owner\/name/);
  assert.ok(!fs.existsSync(dbPath));
});

test('releases: drops drafts + prereleases, sorts newest first, only github.com urls', async () => {
  const get = createReleases({
    fetch: fakeFetch([
      release('v1', '2026-09-01T00:00:00Z', []),
      release('v3', '2026-09-20T00:00:00Z', [['A.dmg', 4]]),
      release('nightly', '2026-09-25T00:00:00Z', [], { prerelease: true }),
      release('v4-draft', '2026-09-26T00:00:00Z', [], { draft: true }),
      release('v2', '2026-09-10T00:00:00Z', [], { html_url: 'javascript:alert(1)' }),
      release('never', null, []),
      null,
    ]),
  });
  const r = await get('o/n');
  assert.deepStrictEqual(r.map((x) => x.tag), ['v3', 'v2', 'v1']);
  assert.strictEqual(r[0].url, 'https://github.com/o/n/releases/tag/v3');
  assert.strictEqual(r[1].url, null);
  assert.deepStrictEqual(r[0].assets, [{ name: 'A.dmg', count: 4 }]);
});

test('releases: cached within ttl, refetched after, one refresh in flight, stale on error', async () => {
  let t = 1000;
  const f = fakeFetch(RELEASES);
  const get = createReleases({ fetch: f, now: () => t, ttl: 100 });

  await Promise.all([get('o/n'), get('o/n')]); // concurrent -> single flight
  assert.strictEqual(f.calls, 1);
  t += 99;
  await get('o/n');
  assert.strictEqual(f.calls, 1); // still fresh
  await get('o/other'); // per-repo cache
  assert.strictEqual(f.calls, 2);

  const boom = createReleases({
    fetch: async () => {
      throw new Error('net down');
    },
  });
  await assert.rejects(boom('o/n'), /net down/); // nothing cached -> throws

  // fresh cache then GitHub starts failing: stale data still served
  const flaky = [RELEASES, new Error('rate limited')];
  const g = createReleases({
    fetch: async () => {
      const v = flaky.shift() || flaky[0];
      if (v instanceof Error) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => v };
    },
    now: () => t,
    ttl: 10,
  });
  const first = await g('o/n');
  t += 11;
  assert.deepStrictEqual(await g('o/n'), first);
});

test('releases: non-200 and non-array payloads are errors', async () => {
  await assert.rejects(createReleases({ fetch: fakeFetch([], { status: 500 }) })('o/n'), /github 500/);
  await assert.rejects(createReleases({ fetch: fakeFetch({ message: 'x' }) })('o/n'), /unexpected/);
});

test('report: per-release windows split gh downloads into new users and updates', async () => {
  const out = await report('o/n', [
    // first site download is 09-02, so v1 (published 09-01) opened before tracking
    dl('a', at('2026-09-02', '10:00')),
    // v2 window [09-10, 09-20): two visitors
    dl('b', at('2026-09-11', '10:00')),
    dl('c', at('2026-09-19', '23:59')),
    // v3 window [09-20, now): one visitor, exactly on the publish instant
    dl('d', at('2026-09-20', '00:00')),
  ]);
  assert.strictEqual(out.configured, true);
  const [app] = out.apps;
  assert.strictEqual(app.repo, 'o/n');
  const [v3, v2, v1] = app.releases;

  // only installers count: .sig, appcast.xml and the zip are ignored
  assert.deepStrictEqual([v2.tag, v2.gh, v2.site, v2.newUsers, v2.updates], ['v2', 50, 2, 2, 48]);
  assert.deepStrictEqual([v3.tag, v3.gh, v3.site, v3.newUsers, v3.updates], ['v3', 10, 1, 1, 9]);
  // predates the first tracked download -> unknown, not "all updates"
  assert.deepStrictEqual([v1.tag, v1.gh, v1.site, v1.newUsers, v1.updates], ['v1', 30, null, null, null]);
  assert.strictEqual(v3.published, '2026-09-20T00:00:00.000Z');
  assert.strictEqual(v3.url, 'https://github.com/o/n/releases/tag/v3');

  // gh/newUsers/updates cover the two releases with site data and add up; allTime is all three
  assert.deepStrictEqual(app.totals, { gh: 60, newUsers: 3, updates: 57, releases: 2, allTime: 90, platforms: { macOS: 90 } });
  assert.strictEqual(app.totals.newUsers + app.totals.updates, app.totals.gh);
});

test('report: site clicks above the GitHub count clamp updates to 0', async () => {
  const events = ['a', 'b', 'c', 'd', 'e'].map((v) => dl(v, at('2026-09-21', '10:00')));
  events.unshift(dl('z', at('2026-09-02', '10:00')));
  const out = await report('o/n', events, [release('v3', '2026-09-20T00:00:00Z', [['App.dmg', 3]])]);
  const [v3] = out.apps[0].releases;
  assert.deepStrictEqual([v3.gh, v3.site, v3.newUsers, v3.updates], [3, 5, 3, 0]);
});

test('report: visitor-days — same visitor twice a day is one, across two days is two', async () => {
  const out = await report(
    'o/n',
    [
      dl('a', at('2026-09-02', '09:00')),
      dl('a', at('2026-09-21', '10:00')),
      dl('a', at('2026-09-21', '11:00')),
      dl('a', at('2026-09-22', '10:00')),
    ],
    [release('v3', '2026-09-20T00:00:00Z', [['App.dmg', 100]])]
  );
  assert.strictEqual(out.apps[0].releases[0].site, 2);
});

test('report: site signal picks download name or custom event; excluded paths drop out', async () => {
  const events = [
    dl('a', at('2026-09-02', '09:00')),
    dl('b', at('2026-09-21', '10:00')),
    dl('c', at('2026-09-21', '10:00'), { name: 'photobooks' }),
    dl('p', at('2026-09-02', '09:00'), { name: 'photobooks' }),
    dl('e', at('2026-09-21', '10:00'), { path: '/stats' }),
    { ts: at('2026-09-21', '10:00'), site_id: SITE, visitor: 'f', session_id: 'sf', type: 'custom', name: 'download_action', path: '/app' },
    { ts: at('2026-09-02', '09:00'), site_id: SITE, visitor: 'g', session_id: 'sg', type: 'custom', name: 'download_action', path: '/app' },
    { ts: at('2026-09-21', '10:00'), site_id: SITE, visitor: 'h', session_id: 'sh', type: 'custom', name: 'other', path: '/app' },
    // other site's events never count
    dl('x', at('2026-09-21', '10:00'), { site_id: 'elsewhere' }),
  ];
  const rel = [release('v3', '2026-09-20T00:00:00Z', [['App.dmg', 100]])];
  const site = async (cfg, exclude) => (await report(cfg, events, rel, exclude)).apps[0].releases[0].site;

  assert.strictEqual(await site({ repo: 'o/n' }), 3); // every download event: b, c, e
  assert.strictEqual(await site({ repo: 'o/n', site: 'download:meatpad' }), 2); // b, e
  assert.strictEqual(await site({ repo: 'o/n', site: 'download:photobooks' }), 1);
  assert.strictEqual(await site({ repo: 'o/n', site: 'event:download_action' }), 1); // f
  assert.strictEqual(await site({ repo: 'o/n', site: 'download:meatpad' }, ['/stats']), 1);
});

test('report: assets option overrides the installer default', async () => {
  const out = await report(
    { repo: 'o/n', assets: '\\.zip$' },
    [dl('a', at('2026-09-02', '09:00'))],
    [release('v3', '2026-09-20T00:00:00Z', [['App.dmg', 100], ['App.zip', 8]])]
  );
  assert.strictEqual(out.apps[0].releases[0].gh, 8);
});

test('report: per-platform split by installer extension, zero counts omitted, totals across releases', async () => {
  const rels = [
    release('v2', '2026-09-10T00:00:00Z', [['A.dmg', 5]]),
    release('v1', '2026-09-01T00:00:00Z', [
      ['A.dmg', 10], ['A-setup.exe', 5], ['A.msi', 1], ['A.deb', 2], ['A.AppImage', 3], ['A.snap', 4],
      ['A.rpm', 0], // no downloads: no platform entry of its own
      ['A.zip', 9], ['appcast.xml', 99], // not installers
    ]),
  ];
  const [app] = (await report('o/n', [], rels)).apps;
  const [v2, v1] = app.releases;
  assert.deepStrictEqual(v1.platforms, { macOS: 10, Windows: 6, Linux: 9 });
  assert.deepStrictEqual(v2.platforms, { macOS: 5 });
  assert.deepStrictEqual(app.totals.platforms, { macOS: 15, Windows: 6, Linux: 9 });
  assert.strictEqual(v1.gh, 25);

  // an assets override can let through files with no known platform
  const [other] = (await report({ repo: 'o/n', assets: '\\.(dmg|zip)$' }, [], rels)).apps;
  assert.deepStrictEqual(other.releases[1].platforms, { macOS: 10, Other: 9 });
});

test('report: perHour is lifetime downloads over the release window, null under an hour', async () => {
  const day = 86400000;
  const latest = new Date(Date.now() - 2 * day).toISOString(); // still the latest: window runs to now
  const [app] = (
    await report('o/n', [], [
      release('vD', latest, [['A.dmg', 96]]),
      release('vC', '2026-09-05T04:30:00Z', [['A.dmg', 3]]),
      release('vB', '2026-09-05T04:00:00Z', [['A.dmg', 8]]), // 30 min until vC
      release('vA', '2026-09-01T00:00:00Z', [['A.dmg', 50]]), // 100 h until vB
    ])
  ).apps;
  const byTag = Object.fromEntries(app.releases.map((r) => [r.tag, r.perHour]));
  assert.strictEqual(byTag.vA, 0.5);
  assert.strictEqual(byTag.vB, null);
  assert.ok(Math.abs(byTag.vD - 2) < 0.01, `vD perHour ${byTag.vD}`);
  assert.ok(byTag.vC > 0);
});

test('report: no signal events at all -> gh totals only, no split', async () => {
  const out = await report('o/n', []);
  const [app] = out.apps;
  assert.ok(app.releases.every((r) => r.site === null && r.updates === null));
  assert.deepStrictEqual(app.totals, { gh: 0, newUsers: 0, updates: 0, releases: 0, allTime: 90, platforms: { macOS: 90 } });
});

test('report: a failing repo is reported as unavailable, others still answer', async () => {
  const store = openStore(tmpDbPath());
  const gh = createGithub({
    github: ['o/good', 'o/bad'],
    githubFetch: async (url) =>
      url.includes('/o/bad/')
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => RELEASES },
  });
  const err = console.error;
  console.error = () => {};
  let out;
  try {
    out = await gh.report(store.db, { siteId: SITE });
  } finally {
    console.error = err;
  }
  assert.strictEqual(out.apps[0].releases.length, 3);
  assert.deepStrictEqual(out.apps[1], { repo: 'o/bad', error: 'unavailable', releases: [], totals: null });
  store.close();
});

test('report: unconfigured -> { configured: false, apps: [] }, no fetch', async () => {
  const f = fakeFetch(RELEASES);
  const gh = createGithub({ githubFetch: f });
  const store = openStore(tmpDbPath());
  assert.deepStrictEqual(await gh.report(store.db, { siteId: SITE }), { configured: false, apps: [] });
  assert.strictEqual(f.calls, 0);
  store.close();
});

test('GET /gm/api/releases: auth-gated, joins track() downloads with GitHub counts', async () => {
  const KEY = 'k';
  const published = new Date(Date.now() - 86400000).toISOString();
  const mw = analytics({
    siteId: SITE,
    dbPath: tmpDbPath(),
    apiKey: KEY,
    github: { repo: 'o/n', site: 'download:meatpad' },
    githubFetch: fakeFetch([release('v9', published, [['MeatPad-9.dmg', 12]])]),
  });
  const server = http.createServer((req, res) => mw(req, res, () => res.end()));
  const visitor = (ip) => ({
    url: '/download/meatpad',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605', host: 'example.com' },
    socket: { remoteAddress: ip },
  });
  // The first tracked download opens the window's data; the second is a new visitor.
  assert.strictEqual(mw.track(visitor('1.1.1.1'), { name: 'meatpad' }), true);
  assert.strictEqual(mw.track(visitor('2.2.2.2'), { name: 'meatpad' }), true);
  mw.collector.flush();

  await request(server).get('/gm/api/releases').expect(401);
  const res = await request(server)
    .get('/gm/api/releases')
    .set('Authorization', 'Bearer ' + KEY)
    .expect(200)
    .expect('Content-Type', /json/);
  assert.strictEqual(res.body.configured, true);
  const [v9] = res.body.apps[0].releases;
  // published a day ago, before the first tracked download -> window predates tracking
  assert.deepStrictEqual([v9.tag, v9.gh, v9.site], ['v9', 12, null]);
  assert.deepStrictEqual(res.body.apps[0].totals, { gh: 0, newUsers: 0, updates: 0, releases: 0, allTime: 12, platforms: { macOS: 12 } });
  mw.stop();
});

test('GET /gm/api/releases: counts tracked downloads inside the latest window', async () => {
  const KEY = 'k';
  const mw = analytics({
    siteId: SITE,
    dbPath: tmpDbPath(),
    apiKey: KEY,
    github: { repo: 'o/n', site: 'download:meatpad' },
    githubFetch: fakeFetch([release('v9', new Date(Date.now() - 1000).toISOString(), [['MeatPad-9.dmg', 12]])]),
  });
  // Backfill an older download so tracking "started" before v9 was published,
  // then two live ones after it.
  mw.store.insertEvents([dl('old', Date.now() - 5 * 86400000)]);
  const visitor = (ip) => ({
    url: '/download/meatpad',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605', host: 'example.com' },
    socket: { remoteAddress: ip },
  });
  mw.track(visitor('1.1.1.1'), { name: 'meatpad' });
  mw.track(visitor('2.2.2.2'), { name: 'meatpad' });
  mw.collector.flush();
  const server = http.createServer((req, res) => mw(req, res, () => res.end()));
  const res = await request(server).get('/gm/api/releases').set('Authorization', 'Bearer ' + KEY).expect(200);
  const [v9] = res.body.apps[0].releases;
  assert.deepStrictEqual([v9.gh, v9.site, v9.newUsers, v9.updates], [12, 2, 2, 10]);
  mw.stop();
});

test('GET /gm/api/releases: unconfigured site answers configured:false', async () => {
  const mw = analytics({ siteId: SITE, dbPath: tmpDbPath(), apiKey: 'k' });
  const server = http.createServer((req, res) => mw(req, res, () => res.end()));
  const res = await request(server).get('/gm/api/releases').set('Authorization', 'Bearer k').expect(200);
  assert.deepStrictEqual(res.body, { configured: false, apps: [] });
  mw.stop();
});
