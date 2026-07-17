'use strict';
const crypto = require('node:crypto');

// Zero-dep WebAuthn verification: just enough CBOR/COSE to accept ES256
// (alg -7, P-256) passkeys with attestation format 'none'. No attestation
// trust, no RSA, no extensions. Everything else throws.

// --- base64url ---------------------------------------------------------------

function b64uToBuf(s) {
  return Buffer.from(String(s), 'base64url');
}
function bufToB64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

// --- CBOR (decode subset) ----------------------------------------------------
// Supports major types 0/1 (int), 2 (bytes), 3 (text), 4 (array), 5 (map).
// Maps decode to a JS Map so negative-integer COSE keys survive. Throws on
// tags (6), floats/simple (7), and indefinite-length (additional info 31).

// Read one item at pos -> { value, pos: nextPos }.
function readItem(buf, pos) {
  if (pos >= buf.length) throw new Error('cbor: truncated');
  const ib = buf[pos++];
  const major = ib >> 5;
  const ai = ib & 0x1f;

  if (major === 7) throw new Error('cbor: float/simple unsupported');
  if (ai === 31) throw new Error('cbor: indefinite length unsupported');

  // Argument (length or integer value).
  let arg;
  if (ai < 24) {
    arg = ai;
  } else if (ai === 24) {
    if (pos + 1 > buf.length) throw new Error('cbor: truncated');
    arg = buf[pos];
    pos += 1;
  } else if (ai === 25) {
    if (pos + 2 > buf.length) throw new Error('cbor: truncated');
    arg = buf.readUInt16BE(pos);
    pos += 2;
  } else if (ai === 26) {
    if (pos + 4 > buf.length) throw new Error('cbor: truncated');
    arg = buf.readUInt32BE(pos);
    pos += 4;
  } else if (ai === 27) {
    if (pos + 8 > buf.length) throw new Error('cbor: truncated');
    // ponytail: our inputs (counters, key coords) never exceed 2^53.
    arg = Number(buf.readBigUInt64BE(pos));
    pos += 8;
  } else {
    throw new Error('cbor: reserved additional info');
  }

  switch (major) {
    case 0:
      return { value: arg, pos };
    case 1:
      return { value: -1 - arg, pos };
    case 2: {
      if (pos + arg > buf.length) throw new Error('cbor: truncated');
      return { value: buf.subarray(pos, pos + arg), pos: pos + arg };
    }
    case 3: {
      if (pos + arg > buf.length) throw new Error('cbor: truncated');
      return { value: buf.toString('utf8', pos, pos + arg), pos: pos + arg };
    }
    case 4: {
      const arr = [];
      for (let i = 0; i < arg; i++) {
        const r = readItem(buf, pos);
        arr.push(r.value);
        pos = r.pos;
      }
      return { value: arr, pos };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < arg; i++) {
        const k = readItem(buf, pos);
        const v = readItem(buf, k.pos);
        map.set(k.value, v.value);
        pos = v.pos;
      }
      return { value: map, pos };
    }
    case 6:
      throw new Error('cbor: tags unsupported');
    default:
      throw new Error('cbor: bad major type');
  }
}

// Strict decode: consumes the whole buffer.
function decodeCbor(buf) {
  const { value, pos } = readItem(buf, 0);
  if (pos !== buf.length) throw new Error('cbor: trailing bytes');
  return value;
}

// --- authenticator data ------------------------------------------------------
// rpIdHash(32) | flags(1) | signCount(4 BE) | [AT: aaguid(16) | credIdLen(2 BE)
// | credId | COSE key]. Attested-credential-data present only when flag AT set.

const FLAG_UP = 0x01; // user present
const FLAG_AT = 0x40; // attested credential data included

function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authData: too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const counter = buf.readUInt32BE(33);
  const out = { rpIdHash, flags, counter };

  if (flags & FLAG_AT) {
    if (buf.length < 55) throw new Error('authData: attested data too short');
    const credIdLen = buf.readUInt16BE(53);
    const credEnd = 55 + credIdLen;
    if (buf.length < credEnd) throw new Error('authData: credId truncated');
    out.credId = buf.subarray(55, credEnd);
    out.cosePubKey = readItem(buf, credEnd).value; // key consumes exactly its CBOR
  }
  return out;
}

// --- COSE key -> JWK ---------------------------------------------------------
// EC2 (kty 2), ES256 (alg -7), P-256 (crv 1) only. COSE keys: 1=kty, 3=alg,
// -1=crv, -2=x, -3=y.

function coseToJwk(map) {
  if (!(map instanceof Map)) throw new Error('cose: not a map');
  if (map.get(1) !== 2) throw new Error('cose: kty not EC2');
  if (map.get(3) !== -7) throw new Error('cose: alg not ES256');
  if (map.get(-1) !== 1) throw new Error('cose: crv not P-256');
  const x = map.get(-2);
  const y = map.get(-3);
  if (!Buffer.isBuffer(x) && !(x instanceof Uint8Array)) throw new Error('cose: missing x');
  if (!Buffer.isBuffer(y) && !(y instanceof Uint8Array)) throw new Error('cose: missing y');
  return { kty: 'EC', crv: 'P-256', x: bufToB64u(x), y: bufToB64u(y) };
}

// --- registration / assertion ------------------------------------------------

function parseClientData(b64u, expectedType, expectedChallenge, expectedOrigin) {
  const cd = JSON.parse(b64uToBuf(b64u).toString('utf8'));
  if (cd.type !== expectedType) throw new Error('clientData: wrong type');
  if (cd.challenge !== expectedChallenge) throw new Error('clientData: wrong challenge');
  if (cd.origin !== expectedOrigin) throw new Error('clientData: wrong origin');
}

function verifyRegistration({
  attestationObjectB64u,
  clientDataJSONB64u,
  expectedChallenge,
  expectedOrigin,
  expectedRpId,
}) {
  parseClientData(clientDataJSONB64u, 'webauthn.create', expectedChallenge, expectedOrigin);

  const att = decodeCbor(b64uToBuf(attestationObjectB64u));
  if (!(att instanceof Map)) throw new Error('attestation: not a map');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData) && !(authData instanceof Uint8Array))
    throw new Error('attestation: no authData');

  const ad = parseAuthData(authData);
  const rpHash = crypto.createHash('sha256').update(expectedRpId).digest();
  if (!ad.rpIdHash.equals(rpHash)) throw new Error('registration: rpIdHash mismatch');
  if (!(ad.flags & FLAG_UP)) throw new Error('registration: user not present');
  if (!ad.credId || !ad.cosePubKey) throw new Error('registration: no attested credential');

  return {
    credId: bufToB64u(ad.credId),
    publicKeyJwk: coseToJwk(ad.cosePubKey),
    counter: ad.counter,
  };
}

function verifyAssertion({
  authenticatorDataB64u,
  clientDataJSONB64u,
  signatureB64u,
  publicKeyJwk,
  expectedChallenge,
  expectedOrigin,
  expectedRpId,
  storedCounter,
}) {
  parseClientData(clientDataJSONB64u, 'webauthn.get', expectedChallenge, expectedOrigin);

  const authData = b64uToBuf(authenticatorDataB64u);
  const ad = parseAuthData(authData);
  const rpHash = crypto.createHash('sha256').update(expectedRpId).digest();
  if (!ad.rpIdHash.equals(rpHash)) throw new Error('assertion: rpIdHash mismatch');
  if (!(ad.flags & FLAG_UP)) throw new Error('assertion: user not present');

  // Signature is over authData || sha256(clientDataJSON), ES256, DER-encoded.
  const cdHash = crypto.createHash('sha256').update(b64uToBuf(clientDataJSONB64u)).digest();
  const signed = Buffer.concat([authData, cdHash]);
  const pub = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  if (!crypto.verify('sha256', signed, pub, b64uToBuf(signatureB64u)))
    throw new Error('assertion: bad signature');

  // Counter clone-detection: only meaningful when both are non-zero (Apple
  // reports 0). Otherwise accept.
  const newCounter = ad.counter;
  if (storedCounter > 0 && newCounter > 0 && newCounter <= storedCounter)
    throw new Error('assertion: counter regression');

  return { counter: newCounter };
}

module.exports = {
  b64uToBuf,
  bufToB64u,
  decodeCbor,
  parseAuthData,
  coseToJwk,
  verifyRegistration,
  verifyAssertion,
};
