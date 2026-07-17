'use strict';
const crypto = require('node:crypto');

// Dashboard + API auth. One HMAC secret, minted once and persisted in meta so
// tokens survive restarts. Two token kinds share the secret:
//   session token  s<exp>.<hmac>  -> dashboard owner (cookie + in-memory bearer)
//   heat token     h<exp>.<hmac>  -> short-lived, lets the gm-overlay iframe read /gm/api/heatmap
// Password is compared in constant time; no bcrypt (would break the 1-dep budget).
// ponytail: plaintext password compare — it's the owner's own env secret, not stored.

const COOKIE = 'gm_dash';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const HEAT_TTL_MS = 10 * 60 * 1000;

function getSecret(store) {
  let s = store.metaGet('dashSecret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    store.metaSet('dashSecret', s);
  }
  return s;
}

function timingEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function createAuth(store, opts) {
  const secret = getSecret(store);
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');

  function mint(kind, ttl) {
    const p = kind + (Date.now() + ttl);
    return p + '.' + sign(p);
  }
  function valid(tok, kind) {
    if (!tok) return false;
    const i = tok.lastIndexOf('.');
    if (i < 0) return false;
    const p = tok.slice(0, i);
    const sig = tok.slice(i + 1);
    if (p[0] !== kind) return false;
    if (!timingEq(sig, sign(p))) return false;
    const exp = +p.slice(1);
    return Number.isFinite(exp) && exp > Date.now();
  }

  const makeSession = () => mint('s', SESSION_TTL_MS);
  const makeHeatToken = () => mint('h', HEAT_TTL_MS);

  function cookieToken(req) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)gm_dash=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  }

  // Session present via HttpOnly cookie (used when serving the dashboard HTML).
  const isSession = (req) => valid(cookieToken(req), 's');

  // Login brute-force throttle: 10 failures / 15 min per IP, in-memory.
  const fails = new Map();
  function throttled(ip) {
    const f = fails.get(ip);
    return !!f && f.n >= 10 && Date.now() - f.t < 15 * 60 * 1000;
  }
  function recordFail(ip) {
    const f = fails.get(ip);
    if (f && Date.now() - f.t < 15 * 60 * 1000) f.n++;
    else fails.set(ip, { n: 1, t: Date.now() });
    if (fails.size > 10000) fails.clear();
  }

  function ipOf(req) {
    return (
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) ||
      ''
    );
  }

  function setSessionCookie(req, res) {
    const tok = makeSession();
    const https =
      req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(tok)}; Path=/_analytics; HttpOnly; SameSite=Strict${https ? '; Secure' : ''}; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    return tok;
  }

  // POST /_analytics/login body {password}. Sets cookie + returns bearer token.
  function login(req, res, body) {
    const ip = ipOf(req);
    const pass = body && typeof body.password === 'string' ? body.password : '';
    const ok =
      !throttled(ip) && !!opts.dashboardPassword && timingEq(pass, opts.dashboardPassword);
    res.setHeader('Content-Type', 'application/json');
    if (!ok) {
      recordFail(ip);
      res.statusCode = throttled(ip) ? 429 : 401;
      return res.end('{"ok":false}');
    }
    fails.delete(ip);
    const tok = setSessionCookie(req, res);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, token: tok }));
  }

  // GET /_analytics/login?key=<apiKey>. Same throttle/fails map as password
  // login (key attempts count as fails too). Redirects into the dashboard
  // with a fresh session cookie on success -- for bookmarks/internal links.
  function loginByKey(req, res, url) {
    const ip = ipOf(req);
    const key = (url.searchParams.get('key') || '').toString();
    const ok = !throttled(ip) && !!opts.apiKey && timingEq(key, opts.apiKey);
    if (!ok) {
      recordFail(ip);
      res.statusCode = throttled(ip) ? 429 : 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"ok":false}');
    }
    fails.delete(ip);
    setSessionCookie(req, res);
    res.statusCode = 302;
    res.setHeader('Location', '/_analytics');
    res.end();
  }

  // Guard for /gm/api/*. Accepts: Bearer apiKey, Bearer session token, valid
  // session cookie, or (heatmap route only) a valid heat token in ?t=.
  function apiAllowed(req, url) {
    const b = bearer(req);
    if (opts.apiKey && timingEq(b, opts.apiKey)) return true;
    if (valid(b, 's')) return true;
    if (isSession(req)) return true;
    if (url && url.pathname === '/gm/api/heatmap' && valid(url.searchParams.get('t'), 'h')) return true;
    return false;
  }

  return { login, loginByKey, isSession, apiAllowed, makeSession, makeHeatToken };
}

module.exports = { createAuth, timingEq };
