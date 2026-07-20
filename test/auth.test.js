'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const analytics = require('../src/index');
const { tmpDbPath } = require('./helpers');
const { makeCredential, makeAttestationObject, makeAssertion } = require('./webauthn-fixtures');

const KEY = 'secret-api-key';
const HOST = 'test.local'; // fixed Host header so rpId/origin are deterministic
const RP_ID = 'test.local';
const ORIGIN = 'http://test.local';

function makeApp(opts = {}) {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath(), apiKey: KEY, ...opts });
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return { mw, server };
}

function makeAppNoKey() {
  const mw = analytics({ siteId: 'test', dbPath: tmpDbPath() });
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  return { mw, server };
}

// Pull the boot-time setup code by capturing console.log during app creation.
function makeAppCapturingSetupCode(opts = {}) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let mw, server;
  try {
    mw = analytics({ siteId: 'test', dbPath: tmpDbPath(), apiKey: KEY, ...opts });
    server = http.createServer((req, res) =>
      mw(req, res, () => {
        res.statusCode = 404;
        res.end();
      })
    );
  } finally {
    console.log = origLog;
  }
  const line = logs.find((l) => l.includes('setup='));
  const setupCode = line ? line.match(/setup=([0-9a-f]+)/)[1] : null;
  assert.ok(setupCode, 'boot log printed a setup code');
  return { mw, server, setupCode };
}

async function doRegister(server, { setupCode, cookie, name = '' } = {}) {
  const cred = makeCredential();
  const optsReq = request(server).post('/_analytics/webauthn/reg-options').set('Host', HOST);
  if (cookie) optsReq.set('Cookie', cookie);
  const optsRes = await optsReq.send(setupCode ? { setupCode } : {});
  if (optsRes.status !== 200) return { optsRes, cred };

  const { challengeId, challenge } = optsRes.body;
  const att = makeAttestationObject(cred, { rpId: RP_ID, challenge, origin: ORIGIN });
  const regReq = request(server).post('/_analytics/webauthn/register').set('Host', HOST);
  if (cookie) regReq.set('Cookie', cookie);
  const regRes = await regReq.send({
    challengeId,
    name,
    attestationObject: att.attestationObjectB64u,
    clientDataJSON: att.clientDataJSONB64u,
    ...(setupCode ? { setupCode } : {}),
  });
  return { optsRes, regRes, cred };
}

async function doAuthenticate(server, cred, { tamperSig = false } = {}) {
  const optsRes = await request(server).post('/_analytics/webauthn/auth-options').set('Host', HOST).send({});
  if (optsRes.status !== 200) return { optsRes, authRes: optsRes };
  const { challengeId, challenge } = optsRes.body;
  const asr = makeAssertion(cred, { rpId: RP_ID, challenge, origin: ORIGIN, counter: 1, tamperSig });
  const authRes = await request(server)
    .post('/_analytics/webauthn/authenticate')
    .set('Host', HOST)
    .send({
      challengeId,
      credId: cred.credId.toString('base64url'),
      authenticatorData: asr.authenticatorDataB64u,
      clientDataJSON: asr.clientDataJSONB64u,
      signature: asr.signatureB64u,
    });
  return { optsRes, authRes };
}

// --- setup code gate ---------------------------------------------------------

test('setup: wrong code -> 401 and counts toward throttle', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const cred = makeCredential();
  const res = await request(server)
    .post('/_analytics/webauthn/register')
    .set('Host', HOST)
    .send({ setupCode: 'wrong-' + setupCode, challengeId: 'x' });
  assert.strictEqual(res.status, 401);
  mw.stop();
});

test('setup: correct code registers first passkey, returns token + session cookie', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);
  assert.strictEqual(regRes.body.ok, true);
  assert.ok(regRes.body.token, 'returns bearer token');
  const cookie = regRes.headers['set-cookie'][0];
  assert.match(cookie, /^gm_dash=/);
  mw.stop();
});

test('setup: code is single-use / dead after first passkey registered', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const first = await doRegister(server, { setupCode });
  assert.strictEqual(first.regRes.status, 200);

  // second registration attempt with the same setup code is now rejected
  const second = await doRegister(server, { setupCode });
  assert.strictEqual(second.optsRes.status, 401);
  mw.stop();
});

// --- invite codes ------------------------------------------------------------

test('invite: session mints code, second admin registers with it, single-use', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const first = await doRegister(server, { setupCode });
  assert.strictEqual(first.regRes.status, 200);
  const cookie = first.regRes.headers['set-cookie'][0].split(';')[0];

  // no session -> 401
  const denied = await request(server).post('/_analytics/api/passkeys/invite').set('Host', HOST).send({});
  assert.strictEqual(denied.status, 401);

  const inv = await request(server)
    .post('/_analytics/api/passkeys/invite')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .send({ name: 'Alice' });
  assert.strictEqual(inv.status, 200);
  assert.ok(inv.body.code, 'returns invite code');

  // list shows the named invite as pending
  let list = await request(server).get('/_analytics/api/passkeys/invites').set('Host', HOST).set('Cookie', cookie);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.invites.length, 1);
  assert.strictEqual(list.body.invites[0].name, 'Alice');
  assert.strictEqual(list.body.invites[0].usedAt, null);
  assert.ok(list.body.invites[0].expiresAt > Date.now() + 23 * 3600 * 1000, '24h TTL');

  // second admin registers with the invite code, no session, gets logged in
  const second = await doRegister(server, { setupCode: inv.body.code });
  assert.strictEqual(second.regRes.status, 200);
  assert.ok(second.regRes.body.token, 'invite registration returns token');
  assert.match(second.regRes.headers['set-cookie'][0], /^gm_dash=/);

  // code is single-use
  const third = await doRegister(server, { setupCode: inv.body.code });
  assert.strictEqual(third.optsRes.status, 401);

  // list now shows it as used
  list = await request(server).get('/_analytics/api/passkeys/invites').set('Host', HOST).set('Cookie', cookie);
  assert.ok(list.body.invites[0].usedAt, 'invite marked used');
  mw.stop();
});

test('invite: expired code rejected, list unauthenticated -> 401', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const first = await doRegister(server, { setupCode });
  const cookie = first.regRes.headers['set-cookie'][0].split(';')[0];

  const inv = await request(server)
    .post('/_analytics/api/passkeys/invite')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .send({ name: 'Bob' });
  mw.store.db.prepare('UPDATE invites SET expires_at=? WHERE code=?').run(Date.now() - 1000, inv.body.code);

  const denied = await doRegister(server, { setupCode: inv.body.code });
  assert.strictEqual(denied.optsRes.status, 401);

  const noAuth = await request(server).get('/_analytics/api/passkeys/invites').set('Host', HOST);
  assert.strictEqual(noAuth.status, 401);
  mw.stop();
});

// --- full passkey login flow -------------------------------------------------

test('passkey login: auth-options -> authenticate -> 200 + session cookie', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { cred, regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  const { optsRes, authRes } = await doAuthenticate(server, cred);
  assert.strictEqual(optsRes.status, 200);
  assert.ok(Array.isArray(optsRes.body.allowCredentials) && optsRes.body.allowCredentials.length === 1);
  assert.strictEqual(authRes.status, 200);
  assert.strictEqual(authRes.body.ok, true);
  assert.ok(authRes.body.token);
  const cookie = authRes.headers['set-cookie'][0];
  assert.match(cookie, /^gm_dash=/);

  // the session cookie authenticates the dashboard
  const dash = await request(server).get('/_analytics').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.doesNotMatch(dash.text, /var TOKEN = null;/);
  mw.stop();
});

test('passkey login: wrong signature -> 401 + recordFail', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { cred, regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  const { authRes } = await doAuthenticate(server, cred, { tamperSig: true });
  assert.strictEqual(authRes.status, 401);
  mw.stop();
});

test('passkey login: 10 fails throttles the IP to 429', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { cred, regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  for (let i = 0; i < 10; i++) {
    const { authRes } = await doAuthenticate(server, cred, { tamperSig: true });
    assert.ok(authRes.status === 401 || authRes.status === 429, `attempt ${i + 1} got ${authRes.status}`);
  }
  const { authRes } = await doAuthenticate(server, cred, { tamperSig: true });
  assert.strictEqual(authRes.status, 429);
  mw.stop();
});

// --- challenge single-use + expiry ------------------------------------------

test('challenge is single-use: replaying authenticate with the same challengeId fails', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { cred, regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  const optsRes = await request(server).post('/_analytics/webauthn/auth-options').set('Host', HOST).send({});
  const { challengeId, challenge } = optsRes.body;
  const asr = makeAssertion(cred, { rpId: RP_ID, challenge, origin: ORIGIN, counter: 1 });
  const body = {
    challengeId,
    credId: cred.credId.toString('base64url'),
    authenticatorData: asr.authenticatorDataB64u,
    clientDataJSON: asr.clientDataJSONB64u,
    signature: asr.signatureB64u,
  };
  const first = await request(server).post('/_analytics/webauthn/authenticate').set('Host', HOST).send(body);
  assert.strictEqual(first.status, 200);

  // replay: challenge was consumed, must fail even though the signature is valid
  const second = await request(server).post('/_analytics/webauthn/authenticate').set('Host', HOST).send(body);
  assert.strictEqual(second.status, 401);
  mw.stop();
});

test('challenge expiry: expired challengeId is rejected', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { cred, regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  const optsRes = await request(server).post('/_analytics/webauthn/auth-options').set('Host', HOST).send({});
  const { challengeId, challenge } = optsRes.body;
  // force-expire the challenge by reaching into the auth module's map
  const chal = mw.auth._challenges;
  assert.ok(chal, 'test hook present');
  const entry = chal.get(challengeId);
  entry.exp = Date.now() - 1000;

  const asr = makeAssertion(cred, { rpId: RP_ID, challenge, origin: ORIGIN, counter: 1 });
  const res = await request(server)
    .post('/_analytics/webauthn/authenticate')
    .set('Host', HOST)
    .send({
      challengeId,
      credId: cred.credId.toString('base64url'),
      authenticatorData: asr.authenticatorDataB64u,
      clientDataJSON: asr.clientDataJSONB64u,
      signature: asr.signatureB64u,
    });
  assert.strictEqual(res.status, 401);
  mw.stop();
});

// --- reg-options / register gated by session --------------------------------

test('reg-options and register require a session once a passkey already exists', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { regRes } = await doRegister(server, { setupCode });
  assert.strictEqual(regRes.status, 200);

  const noSession = await request(server).post('/_analytics/webauthn/reg-options').set('Host', HOST).send({});
  assert.strictEqual(noSession.status, 401);

  const cookie = regRes.headers['set-cookie'][0];
  const withSession = await doRegister(server, { cookie, name: 'second key' });
  assert.strictEqual(withSession.optsRes.status, 200);
  assert.strictEqual(withSession.regRes.status, 200);
  assert.strictEqual(withSession.regRes.body.ok, true);
  // session-gated registration doesn't need to mint a fresh token
  assert.strictEqual(withSession.regRes.body.token, undefined);
  mw.stop();
});

// --- passkey list / rename / delete ------------------------------------------

test('passkey list, rename, delete; last passkey delete refused', async () => {
  const { mw, server, setupCode } = makeAppCapturingSetupCode();
  const { regRes } = await doRegister(server, { setupCode, name: 'first key' });
  const cookie = regRes.headers['set-cookie'][0];

  const list1 = await request(server).get('/_analytics/api/passkeys').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.strictEqual(list1.body.passkeys.length, 1);
  assert.strictEqual(list1.body.passkeys[0].name, 'first key');
  const credId1 = list1.body.passkeys[0].credId;

  // last passkey: delete refused
  const refused = await request(server)
    .post('/_analytics/api/passkeys/delete')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .send({ credId: credId1 });
  assert.strictEqual(refused.status, 400);

  // rename
  await request(server)
    .post('/_analytics/api/passkeys/rename')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .send({ credId: credId1, name: 'renamed' })
    .expect(200);
  const list2 = await request(server).get('/_analytics/api/passkeys').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.strictEqual(list2.body.passkeys[0].name, 'renamed');

  // add a second passkey, then delete is allowed
  const second = await doRegister(server, { cookie });
  assert.strictEqual(second.regRes.status, 200);
  const list3 = await request(server).get('/_analytics/api/passkeys').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.strictEqual(list3.body.passkeys.length, 2);

  await request(server)
    .post('/_analytics/api/passkeys/delete')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .send({ credId: credId1 })
    .expect(200);
  const list4 = await request(server).get('/_analytics/api/passkeys').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.strictEqual(list4.body.passkeys.length, 1);

  mw.stop();
});

test('passkey settings routes require a session', async () => {
  const { mw, server } = makeApp();
  await request(server).get('/_analytics/api/passkeys').set('Host', HOST).expect(401);
  await request(server).post('/_analytics/api/passkeys/rename').set('Host', HOST).send({}).expect(401);
  await request(server).post('/_analytics/api/passkeys/delete').set('Host', HOST).send({}).expect(401);
  mw.stop();
});

// --- auth-options with zero passkeys -----------------------------------------

test('auth-options with zero passkeys -> 409', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).post('/_analytics/webauthn/auth-options').set('Host', HOST).send({});
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'no-passkeys');
  mw.stop();
});

// --- apiKey: minted, persists, loginByKey, rotate, override -----------------

test('apiKey: minted automatically and persists across store close/reopen', async () => {
  const dbPath = tmpDbPath();
  const mw1 = analytics({ siteId: 'test', dbPath });
  const minted = mw1.auth.apiKey;
  assert.match(minted, /^[0-9a-f]{32}$/);
  mw1.stop();
  mw1.store.close();

  const mw2 = analytics({ siteId: 'test', dbPath });
  assert.strictEqual(mw2.auth.apiKey, minted);
  mw2.stop();
  mw2.store.close();
});

test('apiKey: minted key works with loginByKey', async () => {
  const { mw, server } = makeAppNoKey();
  const key = mw.auth.apiKey;
  const res = await request(server).get('/_analytics/login?key=' + key).set('Host', HOST).expect(302);
  assert.strictEqual(res.headers.location, '/_analytics');
  mw.stop();
});

test('apiKey: rotate mints a new key; opts.apiKey override wins and rotate is refused', async () => {
  // no opts.apiKey override here -> the key is server-minted and rotatable
  const { mw, server, setupCode } = makeAppCapturingSetupCode({ apiKey: undefined });
  const before = mw.auth.apiKey;
  const reg = await doRegister(server, { setupCode });
  const cookie = reg.regRes.headers['set-cookie'][0];

  const rotated = await request(server)
    .post('/_analytics/api/key/rotate')
    .set('Host', HOST)
    .set('Cookie', cookie)
    .expect(200);
  assert.notStrictEqual(rotated.body.apiKey, before);
  assert.strictEqual(mw.auth.apiKey, rotated.body.apiKey);
  mw.stop();

  // opts.apiKey override: rotate refused with 400
  const overrideApp = makeAppCapturingSetupCode({ apiKey: 'override-key' });
  const reg2 = await doRegister(overrideApp.server, { setupCode: overrideApp.setupCode });
  const cookie2 = reg2.regRes.headers['set-cookie'][0];
  const keyRes = await request(overrideApp.server)
    .get('/_analytics/api/key')
    .set('Host', HOST)
    .set('Cookie', cookie2)
    .expect(200);
  assert.strictEqual(keyRes.body.apiKey, 'override-key');
  assert.strictEqual(keyRes.body.overridden, true);
  await request(overrideApp.server)
    .post('/_analytics/api/key/rotate')
    .set('Host', HOST)
    .set('Cookie', cookie2)
    .expect(400);
  overrideApp.mw.stop();
});

// --- heat token + apiAllowed (unchanged) -------------------------------------

test('heat token: minted via GET /gm/api/token, works on heatmap, rejected on overview, tampered signature rejected', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/gm/api/token').set('Authorization', 'Bearer ' + KEY).expect(200);
  const t = res.body.token;
  assert.ok(t, 'token minted');

  await request(server).get('/gm/api/heatmap?path=/&vw=desktop&type=click&t=' + t).expect(200);
  // heatmap-route-only: the same token must not open other endpoints
  await request(server).get('/gm/api/overview?t=' + t).expect(401);

  // tamper with the signature half of the token -- must be rejected
  const dot = t.lastIndexOf('.');
  const sig = t.slice(dot + 1);
  const tampered = t.slice(0, dot + 1) + (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  await request(server).get('/gm/api/heatmap?path=/&vw=desktop&type=click&t=' + tampered).expect(401);
  mw.stop();
});

test('magic link: good key redirects + sets a cookie that authenticates the dashboard', async () => {
  const { mw, server } = makeApp();
  const res = await request(server).get('/_analytics/login?key=' + KEY).set('Host', HOST).expect(302);
  assert.strictEqual(res.headers.location, '/_analytics');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^gm_dash=/);
  assert.match(cookie, /Path=\/_analytics/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const dash = await request(server).get('/_analytics').set('Host', HOST).set('Cookie', cookie).expect(200);
  assert.doesNotMatch(dash.text, /var TOKEN = null;/, 'session cookie should authenticate, not fall back to null token');
  mw.stop();
});

test('magic link: bad key is 401, no body oracle vs missing key', async () => {
  const { mw, server } = makeApp();
  const bad = await request(server).get('/_analytics/login?key=wrong').set('Host', HOST).expect(401);
  const missing = await request(server).get('/_analytics/login').set('Host', HOST).expect(401);
  assert.strictEqual(bad.text, missing.text);
  mw.stop();
});

test('magic link: repeated bad keys throttle the IP; correct key from same IP refused while throttled; other IPs unaffected', async () => {
  const { mw, server } = makeApp();
  const ip = '3.3.3.3';
  for (let i = 0; i < 10; i++) {
    const res = await request(server)
      .get('/_analytics/login?key=wrong')
      .set('Host', HOST)
      .set('x-forwarded-for', ip);
    assert.ok(res.status === 401 || res.status === 429, `attempt ${i + 1} got ${res.status}`);
  }
  await request(server)
    .get('/_analytics/login?key=' + KEY)
    .set('Host', HOST)
    .set('x-forwarded-for', ip)
    .expect(429);

  await request(server)
    .get('/_analytics/login?key=' + KEY)
    .set('Host', HOST)
    .set('x-forwarded-for', '4.4.4.4')
    .expect(302);
  mw.stop();
});

test('secure cookie flag follows x-forwarded-proto on magic link', async () => {
  const { mw, server } = makeApp();
  const httpsRes = await request(server)
    .get('/_analytics/login?key=' + KEY)
    .set('Host', HOST)
    .set('x-forwarded-proto', 'https')
    .expect(302);
  assert.match(httpsRes.headers['set-cookie'][0], /; Secure/);

  const httpRes = await request(server).get('/_analytics/login?key=' + KEY).set('Host', HOST).expect(302);
  assert.doesNotMatch(httpRes.headers['set-cookie'][0], /; Secure/);
  mw.stop();
});
