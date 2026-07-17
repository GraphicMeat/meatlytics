'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/store');
const analytics = require('../src/index');
const { tmpDbPath } = require('./helpers');

// A stale lastRollupDate + un-rolled events from a past day should be caught up
// on boot of the middleware factory.
test('boot catches up missed daily rollups from a stale marker', () => {
  const dbPath = tmpDbPath();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

  // Pre-seed: events for two-days-ago, marker stuck ten-days-ago (never rolled).
  const s = openStore(dbPath);
  s.insertEvents([
    { ts: Date.parse(twoDaysAgo + 'T10:00:00Z'), site_id: 'test', visitor: 'A', session_id: 's1', type: 'pageview', path: '/' },
  ]);
  s.metaSet('lastRollupDate', tenDaysAgo);
  assert.strictEqual(s.db.prepare('SELECT COUNT(*) c FROM daily_stats').get().c, 0);
  s.close();

  const mw = analytics({ siteId: 'test', dbPath });
  const c = mw.store.db.prepare('SELECT COUNT(*) c FROM daily_stats WHERE date=?').get(twoDaysAgo).c;
  assert.ok(c > 0, 'catch-up rollup ran for the un-rolled day');
  assert.ok(mw.store.metaGet('lastRollupDate') > tenDaysAgo, 'marker advanced');
  mw.stop();
});
