'use strict';
const crypto = require('node:crypto');

const SESSION_GAP_MS = 30 * 60 * 1000;

// Salt for a UTC date, persisted in meta so restarts don't split visitors.
// Creating a new day's salt purges all older salts — after 24h nobody can
// re-derive who was who.
function getSalt(db, dateStr) {
  const key = 'salt:' + dateStr;
  const row = db.prepare('SELECT val FROM meta WHERE key=?').get(key);
  if (row) return row.val;
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR IGNORE INTO meta(key,val) VALUES(?,?)').run(key, salt);
  db.prepare("DELETE FROM meta WHERE key LIKE 'salt:%' AND key != ?").run(key);
  // Re-read in case of a race where another writer inserted first.
  return db.prepare('SELECT val FROM meta WHERE key=?').get(key).val;
}

function visitorHash({ salt, ip, ua, siteId }) {
  return crypto
    .createHash('sha256')
    .update(salt + ip + ua + siteId)
    .digest()
    .subarray(0, 16)
    .toString('hex');
}

function resolveSession(db, visitor, tsMs) {
  const row = db.prepare('SELECT session_id, last_ts FROM sessions WHERE visitor=?').get(visitor);
  const sid =
    row && tsMs - row.last_ts <= SESSION_GAP_MS
      ? row.session_id
      : crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO sessions(visitor, session_id, last_ts) VALUES(?,?,?)
     ON CONFLICT(visitor) DO UPDATE SET session_id=excluded.session_id, last_ts=excluded.last_ts`
  ).run(visitor, sid, tsMs);
  return sid;
}

module.exports = { getSalt, visitorHash, resolveSession, SESSION_GAP_MS };
