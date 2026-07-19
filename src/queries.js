'use strict';
// Read-side queries for the dashboard + API. All read raw events (90-day window),
// which keeps today's data live and gives one source of truth. daily_* rollups
// remain the long-term store; surfacing ranges older than the raw window is a
// later concern.
// ponytail: raw-events only; ceiling is the 90-day retention. Union daily_* if
// the dashboard ever needs longer ranges.

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Inclusive 'YYYY-MM-DD' range; defaults to last 7 days.
function range(opts) {
  const to = opts.to || today();
  const from = opts.from || new Date(Date.parse(to + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

const DAY = "date(ts/1000,'unixepoch')";
// Reused range predicate: site + type='pageview' + day between from/to.
function pvWhere(alias) {
  const t = alias ? alias + '.' : '';
  return `${t}site_id=@siteId AND ${t}type='pageview' AND date(${t}ts/1000,'unixepoch') BETWEEN @from AND @to`;
}

// viewport_w -> bucket predicate
function vwClause(bucket) {
  if (bucket === 'mobile') return 'viewport_w < 768';
  if (bucket === 'tablet') return 'viewport_w >= 768 AND viewport_w < 1200';
  if (bucket === 'desktop') return 'viewport_w >= 1200';
  return '1=1';
}

function overview(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to };

  const tot = db
    .prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT visitor) visitors FROM events WHERE ${pvWhere()}`)
    .get(p);
  const dur = db
    .prepare(
      `SELECT COALESCE(SUM(value_int),0) d FROM events
       WHERE site_id=@siteId AND type='duration' AND date(ts/1000,'unixepoch') BETWEEN @from AND @to`
    )
    .get(p);
  const sess = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT session_id, COUNT(*) pv FROM events WHERE ${pvWhere()} GROUP BY session_id
       )`
    )
    .get(p).c;
  const bounces = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT session_id, COUNT(*) pv FROM events WHERE ${pvWhere()} GROUP BY session_id HAVING pv=1
       )`
    )
    .get(p).c;
  const timeseries = db
    .prepare(
      `SELECT ${DAY} date, COUNT(DISTINCT visitor) visitors, COUNT(*) pageviews
       FROM events WHERE ${pvWhere()} GROUP BY date ORDER BY date`
    )
    .all(p);

  return {
    visitors: tot.visitors,
    pageviews: tot.pageviews,
    avgDuration: tot.pageviews ? Math.round(dur.d / tot.pageviews) : 0,
    bounceRate: sess ? bounces / sess : 0,
    timeseries,
  };
}

function pages(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to };
  const rows = db
    .prepare(
      `SELECT path, COUNT(DISTINCT visitor) visitors, COUNT(*) pageviews
       FROM events WHERE ${pvWhere()} GROUP BY path ORDER BY pageviews DESC LIMIT 100`
    )
    .all(p);
  const durs = db
    .prepare(
      `SELECT path, COALESCE(SUM(value_int),0) d, COUNT(*) n FROM events
       WHERE site_id=@siteId AND type='duration' AND date(ts/1000,'unixepoch') BETWEEN @from AND @to
       GROUP BY path`
    )
    .all(p);
  const dmap = {};
  for (const r of durs) dmap[r.path] = r.n ? Math.round(r.d / r.n) : 0;
  return rows.map((r) => ({ ...r, avgDuration: dmap[r.path] || 0 }));
}

function sources(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to };
  const classes = db
    .prepare(
      `SELECT COALESCE(ref_class,'direct') ref_class, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere()} GROUP BY COALESCE(ref_class,'direct') ORDER BY visitors DESC`
    )
    .all(p);
  const domains = db
    .prepare(
      `SELECT ref_domain, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere()} AND ref_domain IS NOT NULL AND ref_domain<>''
       GROUP BY ref_domain ORDER BY visitors DESC LIMIT 50`
    )
    .all(p);
  const campaigns = db
    .prepare(
      `SELECT utm_campaign, utm_source, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere()} AND utm_campaign IS NOT NULL AND utm_campaign<>''
       GROUP BY utm_campaign, utm_source ORDER BY visitors DESC LIMIT 50`
    )
    .all(p);
  return { classes, domains, campaigns };
}

// Session path chains from raw pageviews; consecutive duplicate paths collapsed.
function flows(db, opts) {
  const depth = opts.depth || 3;
  const { from, to } = range(opts);
  const rows = db
    .prepare(
      `SELECT session_id, path FROM events WHERE ${pvWhere()} ORDER BY session_id, ts, id`
    )
    .all({ siteId: opts.siteId, from, to });

  const chains = {};
  let curSid = null;
  let steps = [];
  const flush = () => {
    if (steps.length) {
      const key = steps.slice(0, depth).join(' › ');
      chains[key] = (chains[key] || 0) + 1;
    }
    steps = [];
  };
  for (const r of rows) {
    if (r.session_id !== curSid) {
      flush();
      curSid = r.session_id;
    }
    if (steps[steps.length - 1] !== r.path) steps.push(r.path);
  }
  flush();

  return Object.entries(chains)
    .map(([k, count]) => ({ steps: k.split(' › '), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

// Ordered funnel over sessions. steps: [{type:'path'|'event', value}].
function funnel(db, opts) {
  const steps = opts.steps || [];
  const { from, to } = range(opts);
  if (steps.length < 1) return [];
  const rows = db
    .prepare(
      `SELECT session_id, type, path, name FROM events
       WHERE site_id=@siteId AND type IN ('pageview','custom')
         AND date(ts/1000,'unixepoch') BETWEEN @from AND @to
       ORDER BY session_id, ts, id`
    )
    .all({ siteId: opts.siteId, from, to });

  const reached = new Array(steps.length).fill(0);
  const match = (step, ev) =>
    step.type === 'event'
      ? ev.type === 'custom' && ev.name === step.value
      : ev.type === 'pageview' && ev.path === step.value;

  // Advance a pointer through the ordered steps for each session; count how far it got.
  const runSession = (evs) => {
    let i = 0;
    for (const ev of evs) {
      if (i >= steps.length) break;
      if (match(steps[i], ev)) reached[i++]++;
    }
  };
  let curSid = null;
  let evs = [];
  for (const r of rows) {
    if (r.session_id !== curSid) {
      if (evs.length) runSession(evs);
      curSid = r.session_id;
      evs = [];
    }
    evs.push(r);
  }
  if (evs.length) runSession(evs);

  const base = reached[0] || 0;
  return steps.map((s, i) => ({
    step: s.value,
    entered: reached[i],
    converted: i < steps.length - 1 ? reached[i + 1] : reached[i],
    rate: base ? reached[i] / base : 0,
  }));
}

function heatmap(db, opts) {
  const bucket = vwClause(opts.vwBucket);
  if (opts.kind === 'mouse') {
    const rows = db
      .prepare(
        `SELECT props_json FROM events
         WHERE site_id=? AND type='mouse' AND path=? AND ${bucket} AND props_json IS NOT NULL`
      )
      .all(opts.siteId, opts.path);
    const cells = {};
    for (const r of rows) {
      let g;
      try {
        g = JSON.parse(r.props_json);
      } catch {
        continue;
      }
      for (const k in g) cells[k] = (cells[k] || 0) + g[k];
    }
    return Object.entries(cells).map(([k, n]) => {
      const [col, row] = k.split(':').map(Number);
      return { col, row, n };
    });
  }
  return db
    .prepare(
      `SELECT x_pct x, y_pct y, COUNT(*) n FROM events
       WHERE site_id=? AND type='click' AND path=? AND ${bucket}
         AND x_pct IS NOT NULL AND y_pct IS NOT NULL
       GROUP BY x_pct, y_pct`
    )
    .all(opts.siteId, opts.path);
}

function realtime(db, opts) {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const active = db
    .prepare('SELECT COUNT(DISTINCT visitor) c FROM events WHERE site_id=? AND ts>=?')
    .get(opts.siteId, cutoff).c;
  const pages_ = db
    .prepare(
      `SELECT path, COUNT(*) n FROM events
       WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY path ORDER BY n DESC LIMIT 20`
    )
    .all(opts.siteId, cutoff);
  const countries_ = db
    .prepare(
      `SELECT COALESCE(country,'') country, COUNT(DISTINCT visitor) n FROM events
       WHERE site_id=? AND ts>=? GROUP BY COALESCE(country,'') ORDER BY n DESC`
    )
    .all(opts.siteId, cutoff);
  return { active, pages: pages_, countries: countries_ };
}

function countries(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to };
  return db
    .prepare(
      `SELECT COALESCE(country,'') country, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere()} GROUP BY COALESCE(country,'') ORDER BY visitors DESC`
    )
    .all(p);
}

function platforms(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to };
  const dim = (col) =>
    db
      .prepare(
        `SELECT ${col} name, COUNT(DISTINCT visitor) visitors
         FROM events WHERE ${pvWhere()} AND ${col} IS NOT NULL AND ${col}<>''
         GROUP BY ${col} ORDER BY visitors DESC LIMIT 20`
      )
      .all(p);
  return { browsers: dim('browser'), os: dim('os'), devices: dim('device'), langs: dim('lang') };
}

function eventsList(db, opts) {
  const { from, to } = range(opts);
  return db
    .prepare(
      `SELECT name, COUNT(*) count, COUNT(DISTINCT visitor) uniques FROM events
       WHERE site_id=@siteId AND type='custom' AND name IS NOT NULL
         AND date(ts/1000,'unixepoch') BETWEEN @from AND @to
       GROUP BY name ORDER BY count DESC LIMIT 100`
    )
    .all({ siteId: opts.siteId, from, to });
}

module.exports = { overview, pages, sources, flows, funnel, heatmap, realtime, eventsList, countries, platforms, range, vwClause };
