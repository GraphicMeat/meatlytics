'use strict';
const geoip = require('geoip-country');
const { getSalt, visitorHash, resolveSession } = require('./identity');

const MAX_EVENTS = 50;
const MAX_BODY = 32 * 1024;
const FLUSH_MS = 2000;

const BOT_RE =
  /bot|crawl|spider|slurp|headless|crawler|bing|google|yahoo|duckduck|baidu|yandex|facebookexternalhit|preview|monitor|scanner|curl|wget|python-requests|node-fetch|axios|okhttp|phantom|puppeteer|playwright|lighthouse|pingdom|uptime/i;

const TYPES = new Set([
  'pageview', 'click', 'outbound', 'download', 'submit', 'scroll', 'duration', 'custom', 'mouse',
]);

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|ask|aol)\./i;
const SOCIAL =
  /(^|\.)(facebook|instagram|twitter|x\.com$|t\.co$|linkedin|reddit|youtube|pinterest|tiktok|mastodon|threads|news\.ycombinator)\b/i;

function classifyRef(refUrl) {
  let domain = null;
  try {
    domain = new URL(refUrl).hostname.replace(/^www\./, '');
  } catch {
    return { domain: null, cls: 'direct' };
  }
  if (!domain) return { domain: null, cls: 'direct' };
  if (SEARCH.test(domain)) return { domain, cls: 'search' };
  if (SOCIAL.test(domain)) return { domain, cls: 'social' };
  return { domain, cls: 'other' };
}

// IP -> ISO-2 country, uppercase; null on failure or private/unresolvable IP.
// Never stores the IP itself (see identity.js) — resolved once at ingest time.
function resolveCountry(ip) {
  try {
    const g = ip && geoip.lookup(ip);
    return (g && g.country) || null;
  } catch {
    return null;
  }
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function mapEvent(ev, stamp) {
  if (!ev || typeof ev !== 'object' || !TYPES.has(ev.t)) return null;
  const t = ev.t;
  const row = {
    ts: stamp.ts,
    site_id: stamp.siteId,
    visitor: stamp.visitor,
    session_id: stamp.session,
    country: stamp.country,
    type: t,
    path: str(ev.p, 512),
    name: null,
    props_json: null,
    ref_domain: null,
    ref_class: null,
    utm_source: str(ev.u && ev.u.s, 128),
    utm_medium: str(ev.u && ev.u.m, 128),
    utm_campaign: str(ev.u && ev.u.c, 128),
    x_pct: num(ev.x),
    y_pct: num(ev.y),
    viewport_w: Number.isFinite(ev.w) ? ev.w | 0 : null,
    doc_h: Number.isFinite(ev.dh) ? ev.dh | 0 : null,
    value_int: null,
  };

  if (typeof ev.r === 'string' && ev.r) {
    const c = classifyRef(ev.r);
    row.ref_domain = c.domain;
    row.ref_class = c.cls;
  } else if (t === 'pageview') {
    row.ref_class = 'direct';
  }

  if (t === 'scroll') row.value_int = Number.isFinite(ev.d) ? ev.d | 0 : null;
  if (t === 'duration') row.value_int = Number.isFinite(ev.ms) ? ev.ms | 0 : null;
  if (t === 'outbound') row.name = str(ev.h, 255);
  if (t === 'download' || t === 'submit') row.name = str(ev.f, 255);
  if (t === 'custom') {
    row.name = str(ev.n, 255);
    if (ev.pr && typeof ev.pr === 'object') row.props_json = JSON.stringify(ev.pr).slice(0, 2048);
  }
  if (t === 'mouse' && ev.g && typeof ev.g === 'object') {
    row.props_json = JSON.stringify(ev.g).slice(0, 4096);
  }
  return row;
}

function createCollector(store, opts) {
  const siteId = opts.siteId;
  const queue = [];
  const buckets = new Map(); // ip -> { tokens, last }
  // ponytail: in-memory token bucket, generous for humans; per-process only.
  const BURST = 60;
  const REFILL = 20; // tokens/sec

  function allow(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
      b = { tokens: BURST, last: now };
      buckets.set(ip, b);
    }
    b.tokens = Math.min(BURST, b.tokens + ((now - b.last) / 1000) * REFILL);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function ingest(body, ip, ua) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.e)) return;
    const ts = Date.now();
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const salt = getSalt(store.db, dateStr);
    const visitor = visitorHash({ salt, ip, ua, siteId });
    const session = resolveSession(store.db, visitor, ts);
    const country = resolveCountry(ip);
    const stamp = { ts, siteId, visitor, session, country };
    for (const ev of body.e.slice(0, MAX_EVENTS)) {
      const row = mapEvent(ev, stamp);
      if (row) queue.push(row);
    }
  }

  function middleware(req, res) {
    // Always 204: never give a prober an oracle. Drop silently on any issue.
    const done = () => {
      res.statusCode = 204;
      res.end();
    };
    const ua = req.headers['user-agent'] || '';
    const xff = req.headers['x-forwarded-for'];
    const ip = (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || '';

    if (!ua || BOT_RE.test(ua)) return done();
    if (opts.respectDNT && req.headers.dnt === '1') return done();
    if (!allow(ip)) return done();

    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        req.destroy();
        return done();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return done();
      }
      try {
        ingest(body, ip, ua);
      } catch {
        /* drop */
      }
      done();
    });
    req.on('error', () => {
      if (!aborted) done();
    });
  }

  function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      store.insertEvents(batch);
    } catch (e) {
      try {
        store.insertEvents(batch); // retry once (spec: WAL busy is near-impossible)
      } catch (e2) {
        console.error('[meatlytics] flush failed:', e2.message);
      }
    }
  }

  const timer = setInterval(flush, FLUSH_MS);
  timer.unref && timer.unref();

  function stop() {
    clearInterval(timer);
    flush();
  }

  return { middleware, flush, stop };
}

module.exports = { createCollector, classifyRef, mapEvent, resolveCountry };
