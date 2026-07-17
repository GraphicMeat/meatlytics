'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { openStore } = require('../src/store');
const { tmpDbPath, at } = require('./helpers');

const SITE = 'test';
const DAY = '2026-07-16';

// Build a fixture day: visitor A has a 2-pageview session, visitor B a 1-pageview
// (bounce) session, durations, and one custom event.
function seed(store) {
  store.insertEvents([
    // A, session s1: two pageviews -> not a bounce
    { ts: at(DAY, '10:00'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'pageview', path: '/home', ref_class: 'search', ref_domain: 'google.com' },
    { ts: at(DAY, '10:05'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'pageview', path: '/about', ref_class: 'search', ref_domain: 'google.com' },
    { ts: at(DAY, '10:06'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'duration', path: '/home', value_int: 5000 },
    { ts: at(DAY, '10:07'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'duration', path: '/about', value_int: 3000 },
    { ts: at(DAY, '10:08'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'custom', path: '/about', name: 'signup' },
    // B, session s2: single pageview -> bounce on /home
    { ts: at(DAY, '11:00'), site_id: SITE, visitor: 'B', session_id: 's2', type: 'pageview', path: '/home', ref_class: 'direct' },
    { ts: at(DAY, '11:01'), site_id: SITE, visitor: 'B', session_id: 's2', type: 'duration', path: '/home', value_int: 2000 },
  ]);
}

test('rollupDay: daily_stats visitors/pageviews/duration/bounces are correct', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.rollupDay(DAY);
  const rows = store.db
    .prepare('SELECT * FROM daily_stats WHERE date=? ORDER BY path')
    .all(DAY);
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

  assert.strictEqual(byPath['/home'].visitors, 2);
  assert.strictEqual(byPath['/home'].pageviews, 2);
  assert.strictEqual(byPath['/home'].total_duration, 7000);
  assert.strictEqual(byPath['/home'].bounces, 1);

  assert.strictEqual(byPath['/about'].visitors, 1);
  assert.strictEqual(byPath['/about'].pageviews, 1);
  assert.strictEqual(byPath['/about'].total_duration, 3000);
  assert.strictEqual(byPath['/about'].bounces, 0);
  store.close();
});

test('rollupDay: daily_sources groups by ref/utm with distinct visitors', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.rollupDay(DAY);
  const rows = store.db
    .prepare('SELECT * FROM daily_sources WHERE date=? ORDER BY ref_class')
    .all(DAY);
  const search = rows.find((r) => r.ref_class === 'search');
  const direct = rows.find((r) => r.ref_class === 'direct');
  assert.strictEqual(search.ref_domain, 'google.com');
  assert.strictEqual(search.visitors, 1);
  assert.strictEqual(direct.visitors, 1);
  store.close();
});

test('rollupDay: daily_countries groups pageview visitors by country, unknown as empty string', () => {
  const store = openStore(tmpDbPath());
  store.insertEvents([
    { ts: at(DAY, '10:00'), site_id: SITE, visitor: 'A', session_id: 's1', type: 'pageview', path: '/home', country: 'DE' },
    { ts: at(DAY, '10:05'), site_id: SITE, visitor: 'B', session_id: 's2', type: 'pageview', path: '/home', country: 'DE' },
    { ts: at(DAY, '11:00'), site_id: SITE, visitor: 'C', session_id: 's3', type: 'pageview', path: '/home', country: null },
  ]);
  store.rollupDay(DAY);
  const rows = store.db.prepare('SELECT * FROM daily_countries WHERE date=?').all(DAY);
  const de = rows.find((r) => r.country === 'DE');
  const unknown = rows.find((r) => r.country === '');
  assert.strictEqual(de.visitors, 2);
  assert.strictEqual(unknown.visitors, 1);
  store.close();
});

test('migration: pre-existing DB without `country` column gets it added via ALTER TABLE', () => {
  const dbPath = tmpDbPath();
  // Simulate a DB created before `country` existed (pre-migration schema).
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE events(
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, site_id TEXT NOT NULL, visitor TEXT NOT NULL,
    session_id TEXT NOT NULL, type TEXT NOT NULL, path TEXT, name TEXT, props_json TEXT,
    ref_domain TEXT, ref_class TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
    x_pct REAL, y_pct REAL, viewport_w INTEGER, doc_h INTEGER, value_int INTEGER
  )`);
  raw.close();

  const store = openStore(dbPath);
  const cols = store.db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  assert.ok(cols.includes('country'), 'migration added the country column');
  store.insertEvents([
    { ts: Date.now(), site_id: SITE, visitor: 'A', session_id: 's1', type: 'pageview', path: '/', country: 'US' },
  ]);
  assert.strictEqual(store.db.prepare('SELECT country FROM events').get().country, 'US');
  store.close();
});

test('rollupDay: daily_events counts custom events + uniques', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.rollupDay(DAY);
  const row = store.db
    .prepare('SELECT * FROM daily_events WHERE date=? AND name=?')
    .get(DAY, 'signup');
  assert.strictEqual(row.count, 1);
  assert.strictEqual(row.uniques, 1);
  store.close();
});

test('rollupDay is idempotent (re-running does not double-count)', () => {
  const store = openStore(tmpDbPath());
  seed(store);
  store.rollupDay(DAY);
  store.rollupDay(DAY);
  const row = store.db
    .prepare('SELECT * FROM daily_stats WHERE date=? AND path=?')
    .get(DAY, '/home');
  assert.strictEqual(row.pageviews, 2);
  store.close();
});

test('prune: deletes raw events older than retention, keeps aggregates', () => {
  const store = openStore(tmpDbPath());
  const oldTs = Date.now() - 100 * 86400000;
  const newTs = Date.now() - 1 * 86400000;
  store.insertEvents([
    { ts: oldTs, site_id: SITE, visitor: 'A', session_id: 's1', type: 'pageview', path: '/old' },
    { ts: newTs, site_id: SITE, visitor: 'B', session_id: 's2', type: 'pageview', path: '/new' },
  ]);
  store.rollupDay(new Date(oldTs).toISOString().slice(0, 10));
  const aggBefore = store.db.prepare('SELECT COUNT(*) c FROM daily_stats').get().c;

  store.prune(90);

  const paths = store.db.prepare('SELECT path FROM events').all().map((r) => r.path);
  assert.deepStrictEqual(paths, ['/new']);
  const aggAfter = store.db.prepare('SELECT COUNT(*) c FROM daily_stats').get().c;
  assert.strictEqual(aggAfter, aggBefore);
  assert.ok(aggAfter > 0);
  store.close();
});

test('meta get/set round-trips', () => {
  const store = openStore(tmpDbPath());
  assert.strictEqual(store.metaGet('missing'), undefined);
  store.metaSet('k', 'v');
  assert.strictEqual(store.metaGet('k'), 'v');
  store.close();
});
