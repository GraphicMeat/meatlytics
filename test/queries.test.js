'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/store');
const Q = require('../src/queries');
const { tmpDbPath, at } = require('./helpers');

const SITE = 'test';
const D1 = '2026-07-15';
const D2 = '2026-07-16';
const RANGE = { siteId: SITE, from: D1, to: D2 };

// Fixture:
//  A: session sA, D2 -> /home, /pricing, /checkout (full funnel), search/google, duration
//  B: session sB, D2 -> /home, /pricing (drops before checkout), direct
//  C: session sC, D2 -> /home only (bounce), social/twitter
//  D: session sD, D1 -> /home, /pricing, custom 'signup'  (event funnel)
function seed(store) {
  store.insertEvents([
    // A
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/home', ref_class: 'search', ref_domain: 'google.com' },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/pricing', ref_class: 'search', ref_domain: 'google.com' },
    { ts: at(D2, '10:02'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/checkout', ref_class: 'search', ref_domain: 'google.com' },
    { ts: at(D2, '10:03'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'duration', path: '/home', value_int: 4000 },
    { ts: at(D2, '10:03'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'custom', path: '/checkout', name: 'signup' },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'click', path: '/home', x_pct: 40, y_pct: 10, viewport_w: 1440 },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'click', path: '/home', x_pct: 40, y_pct: 10, viewport_w: 1440 },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'click', path: '/home', x_pct: 12, y_pct: 80, viewport_w: 500 },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'mouse', path: '/home', viewport_w: 1440, props_json: JSON.stringify({ '3:2': 5, '4:2': 1 }) },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'mouse', path: '/home', viewport_w: 1440, props_json: JSON.stringify({ '3:2': 2 }) },
    // B
    { ts: at(D2, '11:00'), site_id: SITE, visitor: 'B', session_id: 'sB', type: 'pageview', path: '/home', ref_class: 'direct' },
    { ts: at(D2, '11:01'), site_id: SITE, visitor: 'B', session_id: 'sB', type: 'pageview', path: '/pricing' },
    // C
    { ts: at(D2, '12:00'), site_id: SITE, visitor: 'C', session_id: 'sC', type: 'pageview', path: '/home', ref_class: 'social', ref_domain: 'twitter.com' },
    // D (previous day)
    { ts: at(D1, '09:00'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'pageview', path: '/home', ref_class: 'direct' },
    { ts: at(D1, '09:01'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'pageview', path: '/pricing' },
    { ts: at(D1, '09:02'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'custom', path: '/pricing', name: 'signup' },
  ]);
}

test('overview: totals, bounce, avg time, timeseries', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const o = Q.overview(store.db, RANGE);
  assert.strictEqual(o.visitors, 4); // A,B,C,D
  assert.strictEqual(o.pageviews, 8); // A3 B2 C1 D2
  // 4 sessions, only sC is a 1-pageview bounce
  assert.strictEqual(o.bounceRate, 1 / 4);
  assert.strictEqual(o.avgDuration, Math.round(4000 / 8));
  assert.strictEqual(o.timeseries.length, 2);
  assert.deepStrictEqual(o.timeseries.map((t) => t.date), [D1, D2]);
  store.close();
});

test('pages: grouped views/visitors ordered by views', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const p = Q.pages(store.db, RANGE);
  const home = p.find((r) => r.path === '/home');
  assert.strictEqual(home.pageviews, 4); // A,B,C,D each once
  assert.strictEqual(home.visitors, 4);
  assert.strictEqual(p[0].path, '/home'); // most viewed first
  store.close();
});

test('sources: classes with distinct visitors + domains', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const s = Q.sources(store.db, RANGE);
  const byClass = Object.fromEntries(s.classes.map((c) => [c.ref_class, c.visitors]));
  assert.strictEqual(byClass.search, 1);
  assert.strictEqual(byClass.social, 1);
  assert.strictEqual(byClass.direct, 2); // B and D
  assert.ok(s.domains.some((d) => d.ref_domain === 'google.com'));
  store.close();
});

test('flows: session path chains with counts', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const f = Q.flows(store.db, { ...RANGE, depth: 3 });
  const top = f.find((c) => c.steps.join('>') === '/home>/pricing>/checkout');
  assert.ok(top, 'A produced full 3-step chain');
  assert.strictEqual(top.count, 1);
  const two = f.find((c) => c.steps.join('>') === '/home>/pricing');
  assert.strictEqual(two.count, 2); // B (day2) and D (day1)
  store.close();
});

test('funnel: ordered drop-offs over path steps', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const r = Q.funnel(store.db, {
    ...RANGE,
    steps: [
      { type: 'path', value: '/home' },
      { type: 'path', value: '/pricing' },
      { type: 'path', value: '/checkout' },
    ],
  });
  assert.strictEqual(r[0].entered, 4); // A,B,C,D reach /home
  assert.strictEqual(r[1].entered, 3); // A,B,D reach /pricing
  assert.strictEqual(r[2].entered, 1); // only A reaches /checkout
  assert.strictEqual(r[0].converted, 3);
  assert.strictEqual(r[2].rate, 1 / 4);
});

test('funnel: event step matches custom event name', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const r = Q.funnel(store.db, {
    ...RANGE,
    steps: [
      { type: 'path', value: '/pricing' },
      { type: 'event', value: 'signup' },
    ],
  });
  assert.strictEqual(r[0].entered, 3); // A,B,D hit /pricing
  assert.strictEqual(r[1].entered, 2); // A and D fire signup after pricing
  store.close();
});

test('heatmap click: aggregated points bucketed by viewport', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const desktop = Q.heatmap(store.db, { siteId: SITE, path: '/home', vwBucket: 'desktop', kind: 'click' });
  const pt = desktop.find((p) => p.x === 40 && p.y === 10);
  assert.strictEqual(pt.n, 2); // two identical desktop clicks
  assert.ok(!desktop.some((p) => p.x === 12), 'mobile click excluded from desktop bucket');
  const mobile = Q.heatmap(store.db, { siteId: SITE, path: '/home', vwBucket: 'mobile', kind: 'click' });
  assert.strictEqual(mobile.length, 1);
  assert.strictEqual(mobile[0].x, 12);
  store.close();
});

test('heatmap mouse: grid cells summed across events', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const cells = Q.heatmap(store.db, { siteId: SITE, path: '/home', vwBucket: 'desktop', kind: 'mouse' });
  const c = cells.find((x) => x.col === 3 && x.row === 2);
  assert.strictEqual(c.n, 7); // 5 + 2
  store.close();
});

test('realtime: active visitors + current pages in last 5 min', () => {
  const store = openStore(tmpDbPath());
  const now = Date.now();
  store.insertEvents([
    { ts: now - 60000, site_id: SITE, visitor: 'X', session_id: 'sx', type: 'pageview', path: '/live' },
    { ts: now - 120000, site_id: SITE, visitor: 'Y', session_id: 'sy', type: 'pageview', path: '/live' },
    { ts: now - 10 * 60000, site_id: SITE, visitor: 'Z', session_id: 'sz', type: 'pageview', path: '/old' },
  ]);
  const r = Q.realtime(store.db, { siteId: SITE });
  assert.strictEqual(r.active, 2);
  assert.strictEqual(r.pages[0].path, '/live');
  assert.strictEqual(r.pages[0].n, 2);
  store.close();
});

test('eventsList: custom event counts + uniques', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  const ev = Q.eventsList(store.db, RANGE);
  const signup = ev.find((e) => e.name === 'signup');
  assert.strictEqual(signup.count, 2); // A and D
  assert.strictEqual(signup.uniques, 2);
  store.close();
});
