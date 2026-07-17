'use strict';
const crypto = require('node:crypto');

// Test-only fixtures for the WebAuthn module: a P-256 keypair standing in for an
// authenticator, plus hand-built attestation/assertion payloads. Includes a tiny
// CBOR *encoder* (the module only decodes). Shared with the integration suite.

const FLAG_UP = 0x01;
const FLAG_AT = 0x40;

// --- CBOR encoder (mirror of the decoder's subset) ---------------------------
// Supports int, Buffer/Uint8Array (bytes), string (text), Array, Map.

function head(major, n) {
  const t = major << 5;
  if (n < 24) return Buffer.from([t | n]);
  if (n < 0x100) return Buffer.from([t | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.from([t | 25, 0, 0]);
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.from([t | 26, 0, 0, 0, 0]);
  b.writeUInt32BE(n, 1);
  return b;
}

function cborEncode(v) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('cborEncode: only integers');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  }
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Array.isArray(v)) {
    return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  }
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
    return Buffer.concat(parts);
  }
  throw new Error('cborEncode: unsupported ' + typeof v);
}

// --- WebAuthn payload builders ----------------------------------------------

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// authData: rpIdHash(32) | flags(1) | counter(4 BE) | [AT: aaguid(16) |
// credIdLen(2 BE) | credId | COSE key].
function buildAuthData({ rpId, flags, counter, credId, coseKey }) {
  const parts = [sha256(rpId), Buffer.from([flags])];
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32BE(counter >>> 0);
  parts.push(cnt);
  if (flags & FLAG_AT) {
    parts.push(Buffer.alloc(16)); // aaguid (zeros)
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    parts.push(len, credId, cborEncode(coseKey));
  }
  return Buffer.concat(parts);
}

function buildClientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin }), 'utf8');
}

// A fresh authenticator credential: keypair + credId + COSE public key map.
function makeCredential() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = new Map([
    [1, 2], // kty EC2
    [3, -7], // alg ES256
    [-1, 1], // crv P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  return { publicKey, privateKey, jwk, coseKey, credId: crypto.randomBytes(16) };
}

// Registration ceremony output (attestationObject + clientDataJSON, b64url).
function makeAttestationObject(cred, { rpId, challenge, origin, flags = FLAG_UP | FLAG_AT, counter = 0 }) {
  const authData = buildAuthData({ rpId, flags, counter, credId: cred.credId, coseKey: cred.coseKey });
  const att = new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]);
  return {
    attestationObjectB64u: cborEncode(att).toString('base64url'),
    clientDataJSONB64u: buildClientData('webauthn.create', challenge, origin).toString('base64url'),
  };
}

// Assertion ceremony output (authenticatorData + clientDataJSON + signature).
// Signature is over authData || sha256(clientDataJSON), ES256 DER (crypto.sign
// default for EC). Pass tamperSig:true to corrupt the signature.
function makeAssertion(cred, { rpId, challenge, origin, flags = FLAG_UP, counter = 0, tamperSig = false }) {
  const authData = buildAuthData({ rpId, flags, counter });
  const clientDataJSON = buildClientData('webauthn.get', challenge, origin);
  const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
  const sig = crypto.sign('sha256', signed, cred.privateKey);
  if (tamperSig) sig[sig.length - 1] ^= 0xff;
  return {
    authenticatorDataB64u: authData.toString('base64url'),
    clientDataJSONB64u: clientDataJSON.toString('base64url'),
    signatureB64u: sig.toString('base64url'),
  };
}

module.exports = {
  cborEncode,
  makeCredential,
  makeAttestationObject,
  makeAssertion,
  FLAG_UP,
  FLAG_AT,
};
