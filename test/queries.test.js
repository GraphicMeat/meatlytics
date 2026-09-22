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

test('countries: pageview visitors grouped by country DESC, unknown as empty string', () => {
  const store = openStore(tmpDbPath());
  store.insertEvents([
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/home', country: 'US' },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'B', session_id: 'sB', type: 'pageview', path: '/home', country: 'US' },
    { ts: at(D2, '10:02'), site_id: SITE, visitor: 'C', session_id: 'sC', type: 'pageview', path: '/home', country: 'DE' },
    { ts: at(D2, '10:03'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'pageview', path: '/home', country: null },
  ]);
  const rows = Q.countries(store.db, RANGE);
  assert.deepStrictEqual(rows[0], { country: 'US', visitors: 2, visitorsFiltered: 2 });
  assert.ok(rows.some((r) => r.country === 'DE' && r.visitors === 1));
  assert.ok(rows.some((r) => r.country === '' && r.visitors === 1), 'unknown country grouped as empty string');
  store.close();
});

test('realtime: countries field counts distinct active visitors per country in window', () => {
  const store = openStore(tmpDbPath());
  const now = Date.now();
  store.insertEvents([
    { ts: now - 60000, site_id: SITE, visitor: 'X', session_id: 'sx', type: 'pageview', path: '/live', country: 'US' },
    { ts: now - 120000, site_id: SITE, visitor: 'Y', session_id: 'sy', type: 'pageview', path: '/live', country: 'US' },
    { ts: now - 90000, site_id: SITE, visitor: 'W', session_id: 'sw', type: 'pageview', path: '/live', country: 'DE' },
    { ts: now - 10 * 60000, site_id: SITE, visitor: 'Z', session_id: 'sz', type: 'pageview', path: '/old', country: 'FR' },
  ]);
  const r = Q.realtime(store.db, { siteId: SITE });
  const us = r.countries.find((c) => c.country === 'US');
  const de = r.countries.find((c) => c.country === 'DE');
  assert.strictEqual(us.n, 2);
  assert.strictEqual(de.n, 1);
  assert.ok(!r.countries.some((c) => c.country === 'FR'), 'outside 5-min window excluded');
  store.close();
});

test('platforms: browsers/os/devices/langs distinct visitors DESC, blanks excluded', () => {
  const store = openStore(tmpDbPath());
  store.insertEvents([
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/', browser: 'Chrome', os: 'Windows', device: 'desktop', lang: 'en' },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'B', session_id: 'sB', type: 'pageview', path: '/', browser: 'Chrome', os: 'macOS', device: 'desktop', lang: 'en' },
    { ts: at(D2, '10:02'), site_id: SITE, visitor: 'C', session_id: 'sC', type: 'pageview', path: '/', browser: 'Safari', os: 'iOS', device: 'mobile', lang: 'fr' },
    { ts: at(D2, '10:03'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'pageview', path: '/', browser: null, os: null, device: null, lang: null },
  ]);
  const pl = Q.platforms(store.db, RANGE);
  assert.deepStrictEqual(pl.browsers[0], { name: 'Chrome', visitors: 2 });
  assert.ok(pl.browsers.some((r) => r.name === 'Safari' && r.visitors === 1));
  assert.ok(!pl.browsers.some((r) => r.name === '' || r.name === null), 'blank/unknown excluded');
  assert.deepStrictEqual(pl.devices[0], { name: 'desktop', visitors: 2 });
  const langs = Object.fromEntries(pl.langs.map((r) => [r.name, r.visitors]));
  assert.strictEqual(langs.en, 2);
  assert.strictEqual(langs.fr, 1);
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

// --- excluded paths ----------------------------------------------------------

test('normalizeExcludes: full URLs -> paths, trailing slash stripped, deduped, blanks dropped', () => {
  assert.deepStrictEqual(
    Q.normalizeExcludes(['https://graphicmeat.com/downloads', '/downloads/', '  ', '/download-stats.html?x=1', 42]),
    ['/downloads', '/download-stats.html']
  );
  assert.deepStrictEqual(Q.normalizeExcludes('nope'), []);
});

test('overview: no excludes -> no filtered block', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  assert.strictEqual(Q.overview(store.db, RANGE).filtered, undefined);
  assert.strictEqual(Q.overview(store.db, { ...RANGE, exclude: [] }).filtered, undefined);
  store.close();
});

test('overview: filtered block drops excluded-path pageviews, recomputes bounce + duration', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  // E only ever visits the internal stats page (with a trailing slash) -> gone from filtered.
  store.insertEvents([
    { ts: at(D2, '13:00'), site_id: SITE, visitor: 'E', session_id: 'sE', type: 'pageview', path: '/stats/' },
    { ts: at(D2, '13:01'), site_id: SITE, visitor: 'E', session_id: 'sE', type: 'pageview', path: '/stats' },
    { ts: at(D2, '13:02'), site_id: SITE, visitor: 'E', session_id: 'sE', type: 'duration', path: '/stats', value_int: 9000 },
  ]);
  const o = Q.overview(store.db, { ...RANGE, exclude: ['/stats', '/checkout'] });
  // unfiltered row still counts everything
  assert.strictEqual(o.visitors, 5);
  assert.strictEqual(o.pageviews, 10);
  // filtered: E gone; A loses /checkout -> 7 pageviews (A2 B2 C1 D2)
  assert.strictEqual(o.filtered.visitors, 4);
  assert.strictEqual(o.filtered.pageviews, 7);
  assert.strictEqual(o.filtered.bounceRate, 1 / 4); // sE no longer a session at all
  assert.strictEqual(o.filtered.avgDuration, Math.round(4000 / 7)); // E's 9000ms excluded
  assert.deepStrictEqual(o.excluded, ['/stats', '/checkout']);
  store.close();
});

test('countries: visitorsFiltered alongside visitors, not subtractive', () => {
  const store = openStore(tmpDbPath());
  store.insertEvents([
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/home', country: 'LT' },
    { ts: at(D2, '10:01'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'pageview', path: '/downloads', country: 'LT' },
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'B', session_id: 'sB', type: 'pageview', path: '/downloads', country: 'LT' },
    { ts: at(D2, '10:00'), site_id: SITE, visitor: 'C', session_id: 'sC', type: 'pageview', path: '/home', country: 'DE' },
  ]);
  const rows = Q.countries(store.db, { ...RANGE, exclude: ['/downloads'] });
  assert.deepStrictEqual(rows, [
    { country: 'LT', visitors: 2, visitorsFiltered: 1 },
    { country: 'DE', visitors: 1, visitorsFiltered: 1 },
  ]);
  // no list -> both numbers equal
  for (const r of Q.countries(store.db, RANGE)) assert.strictEqual(r.visitorsFiltered, r.visitors);
  store.close();
});

// Download conversions: rate must come from summed counts, be per-visitor-day
// (repeat clicks collapse), and survive a zero-pageview day without NaN.
test('conversions: visitor-day rate, repeat clicks collapse, no divide-by-zero', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.insertEvents([
    // A downloads twice from /pricing on D2 -> one converted visitor-day
    { ts: at(D2, '10:05'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'download', path: '/pricing', name: 'App.dmg' },
    { ts: at(D2, '10:06'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'download', path: '/pricing', name: 'App.dmg' },
    // D downloads on D1 from /pricing
    { ts: at(D1, '09:05'), site_id: SITE, visitor: 'D', session_id: 'sD', type: 'download', path: '/pricing', name: 'Other.dmg' },
  ]);
  const c = Q.conversions(store.db, RANGE);
  assert.strictEqual(c.base, 4); // A,B,C on D2 + D on D1 (visitor-days)
  assert.strictEqual(c.converted, 2); // A on D2, D on D1 -- A's two clicks count once
  assert.strictEqual(c.rate, 2 / 4);

  const d2 = c.timeseries.find((r) => r.date === D2);
  assert.strictEqual(d2.base, 3);
  assert.strictEqual(d2.converted, 1);

  const pricing = c.paths.find((r) => r.path === '/pricing');
  assert.strictEqual(pricing.base, 3); // A,B on D2 + D on D1
  assert.strictEqual(pricing.converted, 2);
  assert.strictEqual(c.files.find((f) => f.name === 'App.dmg').clicks, 2);

  // empty range -> 0, never NaN
  const none = Q.conversions(store.db, { siteId: SITE, from: '2026-01-01', to: '2026-01-02' });
  assert.strictEqual(none.rate, 0);
  assert.strictEqual(none.converted, 0);
  store.close();
});

test('conversions: excluded paths drop out of both numerator and denominator', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.insertEvents([
    { ts: at(D2, '10:05'), site_id: SITE, visitor: 'A', session_id: 'sA', type: 'download', path: '/pricing', name: 'App.dmg' },
  ]);
  const c = Q.conversions(store.db, { ...RANGE, exclude: ['/pricing'] });
  assert.strictEqual(c.converted, 0);
  assert.ok(!c.paths.some((r) => r.path === '/pricing'));
  store.close();
});
