'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatlytics-'));
  return path.join(dir, crypto.randomBytes(4).toString('hex') + '.db');
}

// UTC ms for a 'YYYY-MM-DD' + optional HH:MM
function at(dateStr, hhmm = '00:00') {
  return Date.parse(`${dateStr}T${hhmm}:00Z`);
}

// Dump every row of every table as one string, for privacy sweeps.
function dumpAll(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  let out = '';
  for (const t of tables) {
    out += JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
  }
  return out;
}

module.exports = { tmpDbPath, at, dumpAll };
