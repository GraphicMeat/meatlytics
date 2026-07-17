'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  decodeCbor,
  coseToJwk,
  verifyRegistration,
  verifyAssertion,
} = require('../src/webauthn');
const {
  cborEncode,
  makeCredential,
  makeAttestationObject,
  makeAssertion,
} = require('./webauthn-fixtures');

const RP_ID = 'example.com';
const ORIGIN = 'https://example.com';
const rand = () => crypto.randomBytes(32).toString('base64url');

// Register a fresh credential, return { cred, reg } where reg is the module's
// verifyRegistration output (credId, publicKeyJwk, counter).
function register() {
  const cred = makeCredential();
  const challenge = rand();
  const att = makeAttestationObject(cred, { rpId: RP_ID, challenge, origin: ORIGIN });
  const reg = verifyRegistration({
    attestationObjectB64u: att.attestationObjectB64u,
    clientDataJSONB64u: att.clientDataJSONB64u,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  });
  return { cred, reg };
}

test('registration → assertion happy-path round trip', () => {
  const { cred, reg } = register();
  assert.strictEqual(reg.credId, cred.credId.toString('base64url'));
  assert.strictEqual(reg.publicKeyJwk.kty, 'EC');
  assert.strictEqual(reg.publicKeyJwk.crv, 'P-256');
  assert.strictEqual(reg.publicKeyJwk.x, cred.jwk.x);
  assert.strictEqual(reg.publicKeyJwk.y, cred.jwk.y);
  assert.strictEqual(reg.counter, 0);

  const challenge = rand();
  const asr = makeAssertion(cred, { rpId: RP_ID, challenge, origin: ORIGIN, counter: 1 });
  const out = verifyAssertion({
    authenticatorDataB64u: asr.authenticatorDataB64u,
    clientDataJSONB64u: asr.clientDataJSONB64u,
    signatureB64u: asr.signatureB64u,
    publicKeyJwk: reg.publicKeyJwk,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    storedCounter: 0,
  });
  assert.strictEqual(out.counter, 1);
});

// Helper: build a valid assertion, then verify with overridden params/flags.
function assertVerify(makeOpts, verifyOverrides) {
  const { cred, reg } = register();
  const challenge = rand();
  const asr = makeAssertion(cred, { rpId: RP_ID, challenge, origin: ORIGIN, counter: 1, ...makeOpts });
  return verifyAssertion({
    authenticatorDataB64u: asr.authenticatorDataB64u,
    clientDataJSONB64u: asr.clientDataJSONB64u,
    signatureB64u: asr.signatureB64u,
    publicKeyJwk: reg.publicKeyJwk,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    storedCounter: 0,
    ...verifyOverrides,
  });
}

test('assertion tamper matrix rejects', () => {
  assert.throws(() => assertVerify({}, { expectedChallenge: rand() }), /challenge/);
  assert.throws(() => assertVerify({}, { expectedOrigin: 'https://evil.com' }), /origin/);
  assert.throws(() => assertVerify({}, { expectedRpId: 'evil.com' }), /rpIdHash/);
  assert.throws(() => assertVerify({ flags: 0x00 }, {}), /user not present/);
  assert.throws(() => assertVerify({ tamperSig: true }, {}), /signature/);
});

test('counter regression rejected, 0/0 accepted', () => {
  // stored 5, new 3 -> reject
  assert.throws(
    () => assertVerify({ counter: 3 }, { storedCounter: 5 }),
    /counter regression/
  );
  // stored 0, new 0 -> accept (Apple reports 0)
  const out = assertVerify({ counter: 0 }, { storedCounter: 0 });
  assert.strictEqual(out.counter, 0);
});

test('registration rejects wrong challenge and missing UP flag', () => {
  const cred = makeCredential();
  const challenge = rand();
  const att = makeAttestationObject(cred, { rpId: RP_ID, challenge, origin: ORIGIN });
  assert.throws(
    () =>
      verifyRegistration({
        attestationObjectB64u: att.attestationObjectB64u,
        clientDataJSONB64u: att.clientDataJSONB64u,
        expectedChallenge: rand(),
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
      }),
    /challenge/
  );
  // AT set (0x40) but UP clear -> rejected
  const noUp = makeAttestationObject(cred, { rpId: RP_ID, challenge, origin: ORIGIN, flags: 0x40 });
  assert.throws(
    () =>
      verifyRegistration({
        attestationObjectB64u: noUp.attestationObjectB64u,
        clientDataJSONB64u: noUp.clientDataJSONB64u,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
      }),
    /user not present/
  );
});

test('CBOR decoder round-trips supported types', () => {
  const m = new Map([
    ['fmt', 'none'],
    [1, 2],
    [-1, 1],
    ['bytes', Buffer.from([1, 2, 3])],
    ['arr', [1, 2, 300]],
  ]);
  const out = decodeCbor(cborEncode(m));
  assert.strictEqual(out.get('fmt'), 'none');
  assert.strictEqual(out.get(1), 2);
  assert.strictEqual(out.get(-1), 1);
  assert.ok(out.get('bytes').equals(Buffer.from([1, 2, 3])));
  assert.deepStrictEqual(out.get('arr'), [1, 2, 300]);
});

test('CBOR decoder rejects float, tag, indefinite length', () => {
  assert.throws(() => decodeCbor(Buffer.from([0xf9, 0x00, 0x00])), /float/); // half-float
  assert.throws(() => decodeCbor(Buffer.from([0xfa, 0, 0, 0, 0])), /float/); // single-float
  assert.throws(() => decodeCbor(Buffer.from([0xc0, 0x00])), /tag/); // tag 0
  assert.throws(() => decodeCbor(Buffer.from([0x9f, 0xff])), /indefinite/); // indefinite array
  assert.throws(() => decodeCbor(Buffer.from([0xbf, 0xff])), /indefinite/); // indefinite map
});

test('coseToJwk rejects RSA and wrong curve', () => {
  // kty 3 = RSA
  assert.throws(() => coseToJwk(new Map([[1, 3], [3, -7]])), /kty/);
  // EC2 but crv 2 (P-384)
  assert.throws(
    () =>
      coseToJwk(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 2],
          [-2, Buffer.alloc(32)],
          [-3, Buffer.alloc(32)],
        ])
      ),
    /crv/
  );
});
