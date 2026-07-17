'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { openStore } = require('./store');
const { createCollector } = require('./collect');

const PLACEHOLDER_JS = '/* meatlytics: tracker not built yet (run `npm run build`) */\n';
const NIGHTLY_MS = 60 * 60 * 1000; // hourly tick; catch-up is idempotent

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(d, n) {
  return dateStr(Date.parse(d + 'T00:00:00Z') + n * 86400000);
}

// Roll up every complete day since the last recorded rollup, then prune.
// Idempotent: safe to run on every boot and on a coarse timer.
function runCatchup(store) {
  const yesterday = dateStr(Date.now() - 86400000);
  let last = store.metaGet('lastRollupDate');
  if (!last) {
    const row = store.db.prepare("SELECT MIN(date(ts/1000,'unixepoch')) d FROM events").get();
    if (!row || !row.d) {
      store.metaSet('lastRollupDate', yesterday);
      return;
    }
    last = addDays(row.d, -1);
  }
  let cur = addDays(last, 1);
  while (cur <= yesterday) {
    store.rollupDay(cur);
    cur = addDays(cur, 1);
  }
  if (yesterday > last) store.metaSet('lastRollupDate', yesterday);
  store.prune(90);
}

module.exports = function analytics(opts) {
  if (!opts || !opts.siteId || !opts.dbPath) {
    throw new Error('meatlytics: opts.siteId and opts.dbPath are required');
  }
  const store = openStore(opts.dbPath);
  const collector = createCollector(store, opts);
  const distGm = path.join(__dirname, '..', 'dist', 'gm.js');

  try {
    runCatchup(store);
  } catch (e) {
    console.error('[meatlytics] rollup catch-up failed:', e.message);
  }
  const nightly = setInterval(() => {
    try {
      runCatchup(store);
    } catch (e) {
      console.error('[meatlytics] nightly rollup failed:', e.message);
    }
  }, NIGHTLY_MS);
  nightly.unref && nightly.unref();

  function mw(req, res, next) {
    const p = (req.url || '').split('?')[0];
    const m = req.method;

    if (m === 'POST' && p === '/gm/e') return collector.middleware(req, res);

    if (m === 'GET' && p === '/gm.js') {
      let body = PLACEHOLDER_JS;
      try {
        if (fs.existsSync(distGm)) body = fs.readFileSync(distGm);
      } catch {
        /* fall back to placeholder */
      }
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.statusCode = 200;
      return res.end(body);
    }

    // Phase 3 replaces these stubs.
    if (m === 'GET' && p === '/_analytics') {
      res.statusCode = 501;
      return res.end('Not Implemented');
    }
    if (p.startsWith('/gm/api/')) {
      res.statusCode = 501;
      return res.end('Not Implemented');
    }

    if (next) return next();
    res.statusCode = 404;
    res.end();
  }

  mw.store = store;
  mw.collector = collector;
  mw.stop = () => {
    collector.stop();
    clearInterval(nightly);
  };
  return mw;
};

module.exports.runCatchup = runCatchup;
