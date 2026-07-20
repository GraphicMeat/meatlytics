'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { openStore } = require('./store');
const { createCollector } = require('./collect');
const { createAuth } = require('./auth');
const webauthn = require('./webauthn');
const api = require('./api');

const PLACEHOLDER_JS = '/* meatlytics: tracker not built yet (run `npm run build`) */\n';
const DASH_MISSING = '<!doctype html><p>meatlytics: dashboard not built yet (run <code>npm run build</code>)</p>';
const NIGHTLY_MS = 60 * 60 * 1000; // hourly tick; catch-up is idempotent

function sendJson(res, obj, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function unauthorized(res) {
  sendJson(res, { error: 'unauthorized' }, 401);
}

// rpId = Host header minus port.
function rpIdOf(req) {
  return (req.headers.host || '').split(':')[0];
}

// Expected origin: same https-detection as the session cookie's Secure flag.
function originOf(req) {
  const https =
    req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
  return (https ? 'https://' : 'http://') + (req.headers.host || '');
}

function getUserId(store) {
  let uid = store.metaGet('ownerUserId');
  if (!uid) {
    uid = crypto.randomBytes(16).toString('base64url');
    store.metaSet('ownerUserId', uid);
  }
  return uid;
}

// Registration is allowed with a valid session (adding another passkey) or a
// valid one-time setup code (bootstrapping the first passkey).
function regGate(auth, req, body) {
  if (auth.isSession(req)) return { ok: true, viaSetupCode: false };
  if (body && typeof body.setupCode === 'string' && auth.checkSetupCode(body.setupCode)) {
    return { ok: true, viaSetupCode: true };
  }
  return { ok: false, viaSetupCode: false };
}

// Reject + record the failure against the shared throttle, replying 429 once
// the IP is throttled and 401 otherwise.
function regGateFail(auth, req, res) {
  const ip = auth.ipOf(req);
  auth.recordFail(ip);
  sendJson(res, { ok: false }, auth.throttled(ip) ? 429 : 401);
}

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
  const worldSvg = path.join(__dirname, 'dashboard', 'world.svg');

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

    // Vendored world map SVG (public, long-cache); another process supplies the
    // file, so 404 rather than fall back if it hasn't landed yet.
    if (m === 'GET' && p === '/gm/world.svg') {
      if (!fs.existsSync(worldSvg)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.statusCode = 200;
      return res.end(fs.readFileSync(worldSvg));
    }

    if (m === 'GET' && p === '/_analytics/login') {
      return auth.loginByKey(req, res, new URL(req.url, 'http://localhost'));
    }

    if (m === 'POST' && p === '/_analytics/webauthn/auth-options') {
      const ip = auth.ipOf(req);
      if (auth.throttled(ip)) return sendJson(res, { ok: false }, 429);
      if (store.passkeyCount() === 0) return sendJson(res, { error: 'no-passkeys' }, 409);
      const { id, challenge } = auth.newChallenge();
      const allowCredentials = store.passkeyList().map((pk) => ({ id: pk.credId }));
      return sendJson(res, { challengeId: id, challenge, rpId: rpIdOf(req), allowCredentials });
    }

    if (m === 'POST' && p === '/_analytics/webauthn/authenticate') {
      return readBody(req, (body) => {
        const ip = auth.ipOf(req);
        if (auth.throttled(ip)) {
          auth.recordFail(ip);
          return sendJson(res, { ok: false }, 429);
        }
        const fail = () => {
          auth.recordFail(ip);
          sendJson(res, { ok: false }, auth.throttled(ip) ? 429 : 401);
        };
        if (!body || typeof body.challengeId !== 'string' || typeof body.credId !== 'string') {
          return fail();
        }
        const challenge = auth.takeChallenge(body.challengeId);
        if (!challenge) return fail();
        const pk = store.passkeyGet(body.credId);
        if (!pk) return fail();
        let result;
        try {
          result = webauthn.verifyAssertion({
            authenticatorDataB64u: body.authenticatorData,
            clientDataJSONB64u: body.clientDataJSON,
            signatureB64u: body.signature,
            publicKeyJwk: pk.publicKey,
            expectedChallenge: challenge,
            expectedOrigin: originOf(req),
            expectedRpId: rpIdOf(req),
            storedCounter: pk.counter,
          });
        } catch {
          return fail();
        }
        store.passkeyUpdateCounter(pk.credId, result.counter);
        auth.clearFail(ip);
        const tok = auth.setSessionCookie(req, res);
        sendJson(res, { ok: true, token: tok });
      });
    }

    if (m === 'POST' && p === '/_analytics/webauthn/reg-options') {
      return readBody(req, (body) => {
        const gate = regGate(auth, req, body);
        if (!gate.ok) return regGateFail(auth, req, res);
        const { id, challenge } = auth.newChallenge();
        const excludeCredentials = store.passkeyList().map((pk) => ({ id: pk.credId }));
        sendJson(res, {
          challengeId: id,
          challenge,
          rpId: rpIdOf(req),
          userId: getUserId(store),
          excludeCredentials,
        });
      });
    }

    if (m === 'POST' && p === '/_analytics/webauthn/register') {
      return readBody(req, (body) => {
        const gate = regGate(auth, req, body);
        if (!gate.ok) return regGateFail(auth, req, res);
        if (!body || typeof body.challengeId !== 'string') return sendJson(res, { error: 'bad-request' }, 400);
        const challenge = auth.takeChallenge(body.challengeId);
        if (!challenge) return sendJson(res, { error: 'bad-challenge' }, 400);
        let result;
        try {
          result = webauthn.verifyRegistration({
            attestationObjectB64u: body.attestationObject,
            clientDataJSONB64u: body.clientDataJSON,
            expectedChallenge: challenge,
            expectedOrigin: originOf(req),
            expectedRpId: rpIdOf(req),
          });
        } catch {
          return sendJson(res, { error: 'verify-failed' }, 400);
        }
        store.passkeyAdd({
          credId: result.credId,
          publicKey: result.publicKeyJwk,
          counter: result.counter,
          name: (body.name || '').toString().slice(0, 64),
        });
        if (gate.viaSetupCode) {
          auth.clearSetupCode(body.setupCode);
          const tok = auth.setSessionCookie(req, res);
          return sendJson(res, { ok: true, token: tok });
        }
        sendJson(res, { ok: true });
      });
    }

    if (m === 'POST' && p === '/_analytics/api/passkeys/invite') {
      if (!auth.isSession(req)) return unauthorized(res);
      return readBody(req, (body) => {
        const name = ((body && body.name) || '').toString().slice(0, 64);
        sendJson(res, { code: auth.newInvite(name) });
      });
    }

    if (m === 'GET' && p === '/_analytics/api/passkeys/invites') {
      if (!auth.isSession(req)) return unauthorized(res);
      return sendJson(res, { invites: store.inviteList() });
    }

    if (m === 'GET' && p === '/_analytics/api/passkeys') {
      if (!auth.isSession(req)) return unauthorized(res);
      return sendJson(res, { passkeys: store.passkeyList() });
    }

    if (m === 'POST' && p === '/_analytics/api/passkeys/rename') {
      if (!auth.isSession(req)) return unauthorized(res);
      return readBody(req, (body) => {
        if (!body || typeof body.credId !== 'string') return sendJson(res, { error: 'bad-request' }, 400);
        store.passkeyRename(body.credId, (body.name || '').toString().slice(0, 64));
        sendJson(res, { ok: true });
      });
    }

    if (m === 'POST' && p === '/_analytics/api/passkeys/delete') {
      if (!auth.isSession(req)) return unauthorized(res);
      return readBody(req, (body) => {
        if (!body || typeof body.credId !== 'string') return sendJson(res, { error: 'bad-request' }, 400);
        if (store.passkeyCount() <= 1) return sendJson(res, { error: 'last-passkey' }, 400);
        store.passkeyDelete(body.credId);
        sendJson(res, { ok: true });
      });
    }

    if (m === 'GET' && p === '/_analytics/api/key') {
      if (!auth.isSession(req)) return unauthorized(res);
      return sendJson(res, { apiKey: auth.apiKey, overridden: auth.apiKeyOverridden });
    }

    if (m === 'POST' && p === '/_analytics/api/key/rotate') {
      if (!auth.isSession(req)) return unauthorized(res);
      const newKey = auth.rotateApiKey();
      if (newKey === null) return sendJson(res, { error: 'overridden' }, 400);
      return sendJson(res, { apiKey: newKey });
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
