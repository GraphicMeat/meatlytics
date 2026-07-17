'use strict';
const crypto = require('node:crypto');

// Dashboard + API auth. One HMAC secret, minted once and persisted in meta so
// tokens survive restarts. Two token kinds share the secret:
//   session token  s<exp>.<hmac>  -> dashboard owner (cookie + in-memory bearer)
//   heat token     h<exp>.<hmac>  -> short-lived, lets the gm-overlay iframe read /gm/api/heatmap
// Human login is WebAuthn passkeys (see webauthn.js + index.js routes); this
// module owns the session/heat tokens, the api key, the challenge store, the
// one-time setup code, and the shared brute-force throttle.

const COOKIE = 'gm_dash';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const HEAT_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

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

  // Login brute-force throttle: 10 failures / 15 min per IP, in-memory. Shared
  // across password-era routes and the webauthn/setup-code routes in index.js.
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
  function clearFail(ip) {
    fails.delete(ip);
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

  // GET /_analytics/login?key=<apiKey>. Same throttle/fails map as everything
  // else (key attempts count as fails too). Redirects into the dashboard with
  // a fresh session cookie on success -- for bookmarks/internal links.
  function loginByKey(req, res, url) {
    const ip = ipOf(req);
    const key = (url.searchParams.get('key') || '').toString();
    const ok = !throttled(ip) && timingEq(key, apiKey);
    if (!ok) {
      recordFail(ip);
      res.statusCode = throttled(ip) ? 429 : 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"ok":false}');
    }
    clearFail(ip);
    setSessionCookie(req, res);
    res.statusCode = 302;
    res.setHeader('Location', '/_analytics');
    res.end();
  }

  // Guard for /gm/api/*. Accepts: Bearer apiKey, Bearer session token, valid
  // session cookie, or (heatmap route only) a valid heat token in ?t=.
  function apiAllowed(req, url) {
    const b = bearer(req);
    if (apiKey && timingEq(b, apiKey)) return true;
    if (valid(b, 's')) return true;
    if (isSession(req)) return true;
    if (url && url.pathname === '/gm/api/heatmap' && valid(url.searchParams.get('t'), 'h')) return true;
    return false;
  }

  // --- api key: opts.apiKey overrides; otherwise minted once + persisted ----

  const apiKeyOverridden = !!opts.apiKey;
  let apiKey = opts.apiKey || store.metaGet('apiKey');
  if (!apiKey) {
    apiKey = crypto.randomBytes(16).toString('hex');
    store.metaSet('apiKey', apiKey);
  }

  function rotateApiKey() {
    if (apiKeyOverridden) return null;
    apiKey = crypto.randomBytes(16).toString('hex');
    store.metaSet('apiKey', apiKey);
    auth.apiKey = apiKey;
    return apiKey;
  }

  // --- webauthn challenges: in-memory, 2-min TTL, single-use ----------------

  const challenges = new Map(); // id -> { challenge, exp }
  function sweepChallenges() {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.exp <= now) challenges.delete(id);
  }
  function newChallenge() {
    sweepChallenges();
    if (challenges.size > 10000) challenges.clear(); // same cap ethos as fails map
    const id = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.randomBytes(32).toString('base64url');
    challenges.set(id, { challenge, exp: Date.now() + CHALLENGE_TTL_MS });
    return { id, challenge };
  }
  function takeChallenge(id) {
    const c = challenges.get(id);
    if (!c) return null;
    challenges.delete(id); // single-use regardless of outcome
    if (c.exp <= Date.now()) return null;
    return c.challenge;
  }

  // --- one-time setup code: printed at boot while zero passkeys exist -------

  let setupCode = null;
  if (store.passkeyCount() === 0) {
    setupCode = crypto.randomBytes(16).toString('hex');
    console.log(
      `[meatlytics] ${opts.siteId}: no passkey registered — open /_analytics?setup=${setupCode} on the dashboard origin to register one`
    );
  }
  function checkSetupCode(code) {
    if (!setupCode || store.passkeyCount() !== 0) return false;
    return typeof code === 'string' && timingEq(code, setupCode);
  }
  function clearSetupCode() {
    setupCode = null;
  }

  const auth = {
    loginByKey,
    isSession,
    apiAllowed,
    makeSession,
    makeHeatToken,
    setSessionCookie,
    ipOf,
    throttled,
    recordFail,
    clearFail,
    newChallenge,
    takeChallenge,
    checkSetupCode,
    clearSetupCode,
    rotateApiKey,
    apiKey,
    apiKeyOverridden,
    _challenges: challenges, // test seam: force-expire a challenge
  };
  return auth;
}

module.exports = { createAuth, timingEq };
