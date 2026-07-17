'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { openStore } = require('./store');
const { createCollector } = require('./collect');
const { createAuth } = require('./auth');
const api = require('./api');

const PLACEHOLDER_JS = '/* meatlytics: tracker not built yet (run `npm run build`) */\n';
const DASH_MISSING = '<!doctype html><p>meatlytics: dashboard not built yet (run <code>npm run build</code>)</p>';
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
  const auth = createAuth(store, opts);
  const distGm = path.join(__dirname, '..', 'dist', 'gm.js');
  const distDash = path.join(__dirname, '..', 'dist', 'dashboard.html');
  const srcDash = path.join(__dirname, 'dashboard', 'index.html');
  const overlayJs = path.join(__dirname, 'tracker', 'gm-overlay.js');

  function readBody(req, cb) {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        cb(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        cb(null);
      }
    });
    req.on('error', () => cb(null));
  }

  function serveFile(res, file, type, fallback) {
    let body = fallback;
    try {
      if (fs.existsSync(file)) body = fs.readFileSync(file);
    } catch {
      /* fallback */
    }
    res.setHeader('Content-Type', type);
    res.statusCode = 200;
    res.end(body);
  }

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

    if (m === 'GET' && p === '/gm-overlay.js') {
      return serveFile(res, overlayJs, 'application/javascript; charset=utf-8', '');
    }

    if (m === 'POST' && p === '/_analytics/login') {
      return readBody(req, (body) => auth.login(req, res, body));
    }

    // Dashboard shell (public). If the owner already has a valid session cookie,
    // inject a fresh in-memory bearer so reloads don't force re-login.
    if (m === 'GET' && p === '/_analytics') {
      let html;
      try {
        html = fs.readFileSync(fs.existsSync(distDash) ? distDash : srcDash, 'utf8');
      } catch {
        html = DASH_MISSING;
      }
      const tok = auth.isSession(req) ? JSON.stringify(auth.makeSession()) : 'null';
      html = html.replace('%TOKEN%', tok);
      html = html.replace('%PEERS%', JSON.stringify((opts.peers || []).map((p) => p.name)));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      return res.end(html);
    }

    if (p.startsWith('/gm/api/')) {
      const url = new URL(req.url, 'http://localhost');
      if (!auth.apiAllowed(req, url)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        return res.end('{"error":"unauthorized"}');
      }
      return api.handle(req, res, url, { store, siteId: opts.siteId, auth, peers: opts.peers });
    }

    if (next) return next();
    res.statusCode = 404;
    res.end();
  }

  mw.store = store;
  mw.collector = collector;
  mw.auth = auth;
  mw.stop = () => {
    collector.stop();
    clearInterval(nightly);
  };
  return mw;
};

module.exports.runCatchup = runCatchup;
