'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// Full event column set. insertEvents normalizes partial rows against this so
// callers only supply the fields an event actually carries.
const EVENT_COLS = [
  'ts', 'site_id', 'visitor', 'session_id', 'type', 'path', 'name', 'props_json',
  'ref_domain', 'ref_class', 'utm_source', 'utm_medium', 'utm_campaign',
  'x_pct', 'y_pct', 'viewport_w', 'doc_h', 'value_int',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  visitor TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  name TEXT,
  props_json TEXT,
  ref_domain TEXT,
  ref_class TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  x_pct REAL,
  y_pct REAL,
  viewport_w INTEGER,
  doc_h INTEGER,
  value_int INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS daily_stats(
  date TEXT, site_id TEXT, path TEXT,
  visitors INTEGER, pageviews INTEGER, total_duration INTEGER, bounces INTEGER,
  PRIMARY KEY(date, site_id, path)
);
CREATE TABLE IF NOT EXISTS daily_sources(
  date TEXT, site_id TEXT,
  ref_class TEXT, ref_domain TEXT, utm_source TEXT, utm_campaign TEXT,
  visitors INTEGER,
  PRIMARY KEY(date, site_id, ref_class, ref_domain, utm_source, utm_campaign)
);
CREATE TABLE IF NOT EXISTS daily_events(
  date TEXT, site_id TEXT, name TEXT,
  count INTEGER, uniques INTEGER,
  PRIMARY KEY(date, site_id, name)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, val TEXT);
CREATE TABLE IF NOT EXISTS sessions(visitor TEXT PRIMARY KEY, session_id TEXT, last_ts INTEGER);
`;

// SQLite: convert stored ms epoch -> UTC 'YYYY-MM-DD'
const DATE_EXPR = "date(ts/1000,'unixepoch')";

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this._insert = this.db.prepare(
      `INSERT INTO events (${EVENT_COLS.join(',')}) VALUES (${EVENT_COLS.map((c) => '@' + c).join(',')})`
    );
    this._insertMany = this.db.transaction((rows) => {
      for (const r of rows) this._insert.run(normalize(r));
    });
  }

  insertEvents(rows) {
    if (!rows || !rows.length) return;
    this._insertMany(rows);
  }

  rollupDay(date) {
    const db = this.db;
    db.transaction(() => {
      db.prepare('DELETE FROM daily_stats WHERE date=?').run(date);
      db.prepare('DELETE FROM daily_sources WHERE date=?').run(date);
      db.prepare('DELETE FROM daily_events WHERE date=?').run(date);

      db.prepare(
        `INSERT INTO daily_stats(date, site_id, path, visitors, pageviews, total_duration, bounces)
         SELECT ?, site_id, path, COUNT(DISTINCT visitor), COUNT(*), 0, 0
         FROM events WHERE type='pageview' AND ${DATE_EXPR}=?
         GROUP BY site_id, path`
      ).run(date, date);

      // total_duration: sum duration events per path
      db.prepare(
        `UPDATE daily_stats SET total_duration = COALESCE((
           SELECT SUM(value_int) FROM events e
           WHERE e.type='duration' AND date(e.ts/1000,'unixepoch')=?
             AND e.site_id=daily_stats.site_id AND e.path=daily_stats.path
         ), 0)
         WHERE date=?`
      ).run(date, date);

      // bounces: sessions with exactly one pageview that day, attributed to that path
      const bounceRows = db
        .prepare(
          `SELECT site_id, path, COUNT(*) AS bounces FROM (
             SELECT session_id, site_id, MIN(path) AS path
             FROM events WHERE type='pageview' AND ${DATE_EXPR}=?
             GROUP BY session_id HAVING COUNT(*)=1
           ) GROUP BY site_id, path`
        )
        .all(date);
      const upd = db.prepare(
        'UPDATE daily_stats SET bounces=? WHERE date=? AND site_id=? AND path=?'
      );
      for (const b of bounceRows) upd.run(b.bounces, date, b.site_id, b.path);

      db.prepare(
        `INSERT INTO daily_sources(date, site_id, ref_class, ref_domain, utm_source, utm_campaign, visitors)
         SELECT ?, site_id,
           COALESCE(ref_class,''), COALESCE(ref_domain,''),
           COALESCE(utm_source,''), COALESCE(utm_campaign,''),
           COUNT(DISTINCT visitor)
         FROM events WHERE type='pageview' AND ${DATE_EXPR}=?
         GROUP BY site_id, COALESCE(ref_class,''), COALESCE(ref_domain,''),
                  COALESCE(utm_source,''), COALESCE(utm_campaign,'')`
      ).run(date, date);

      db.prepare(
        `INSERT INTO daily_events(date, site_id, name, count, uniques)
         SELECT ?, site_id, name, COUNT(*), COUNT(DISTINCT visitor)
         FROM events WHERE type='custom' AND name IS NOT NULL AND ${DATE_EXPR}=?
         GROUP BY site_id, name`
      ).run(date, date);
    })();
  }

  prune(retentionDays = 90) {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM sessions WHERE last_ts < ?').run(cutoff);
  }

  metaGet(key) {
    const row = this.db.prepare('SELECT val FROM meta WHERE key=?').get(key);
    return row ? row.val : undefined;
  }

  metaSet(key, val) {
    this.db
      .prepare('INSERT INTO meta(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val')
      .run(key, String(val));
  }

  close() {
    this.db.close();
  }
}

function normalize(row) {
  const out = {};
  for (const c of EVENT_COLS) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

function openStore(dbPath) {
  return new Store(dbPath);
}

module.exports = { openStore, Store, EVENT_COLS };
