'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/store');
const { getSalt, visitorHash, resolveSession } = require('../src/identity');
const { tmpDbPath } = require('./helpers');

test('visitorHash: same ip/ua/site/day -> same 32-char hex hash', () => {
  const store = openStore(tmpDbPath());
  const salt = getSalt(store.db, '2026-07-17');
  const a = visitorHash({ salt, ip: '203.0.113.7', ua: 'UA', siteId: 'gm' });
  const b = visitorHash({ salt, ip: '203.0.113.7', ua: 'UA', siteId: 'gm' });
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  store.close();
});

test('visitorHash: different day (different salt) -> different hash', () => {
  const store = openStore(tmpDbPath());
  const s1 = getSalt(store.db, '2026-07-17');
  const s2 = getSalt(store.db, '2026-07-18');
  assert.notStrictEqual(s1, s2);
  const a = visitorHash({ salt: s1, ip: '203.0.113.7', ua: 'UA', siteId: 'gm' });
  const b = visitorHash({ salt: s2, ip: '203.0.113.7', ua: 'UA', siteId: 'gm' });
  assert.notStrictEqual(a, b);
  store.close();
});

test('getSalt: salt survives store reopen (restart simulation)', () => {
  const p = tmpDbPath();
  const s1 = openStore(p);
  const salt = getSalt(s1.db, '2026-07-17');
  s1.close();
  const s2 = openStore(p);
  const salt2 = getSalt(s2.db, '2026-07-17');
  assert.strictEqual(salt, salt2);
  s2.close();
});

test('getSalt: old salts deleted once a newer day rotates in', () => {
  const store = openStore(tmpDbPath());
  getSalt(store.db, '2026-07-17');
  getSalt(store.db, '2026-07-18'); // rotation should purge older
  const rows = store.db
    .prepare("SELECT key FROM meta WHERE key LIKE 'salt:%'")
    .all()
    .map((r) => r.key);
  assert.deepStrictEqual(rows, ['salt:2026-07-18']);
  store.close();
});

test('resolveSession: events 10 min apart -> same session', () => {
  const store = openStore(tmpDbPath());
  const v = 'a'.repeat(32);
  const t0 = Date.parse('2026-07-17T10:00:00Z');
  const s1 = resolveSession(store.db, v, t0);
  const s2 = resolveSession(store.db, v, t0 + 10 * 60 * 1000);
  assert.strictEqual(s1, s2);
  assert.match(s1, /^[0-9a-f]{16}$/);
  store.close();
});

test('resolveSession: events 31 min apart -> new session', () => {
  const store = openStore(tmpDbPath());
  const v = 'b'.repeat(32);
  const t0 = Date.parse('2026-07-17T10:00:00Z');
  const s1 = resolveSession(store.db, v, t0);
  const s2 = resolveSession(store.db, v, t0 + 31 * 60 * 1000);
  assert.notStrictEqual(s1, s2);
  store.close();
});
