'use strict';
// Read-side queries for the dashboard + API. All read raw events (90-day window),
// which keeps today's data live and gives one source of truth. daily_* rollups
// remain the long-term store; surfacing ranges older than the raw window is a
// later concern.
// ponytail: raw-events only; ceiling is the 90-day retention. Union daily_* if
// the dashboard ever needs longer ranges.
const { cleanTag } = require('./collect');

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

// Optional tag filter shared by every range read. Missing/'' -> no filter (all
// traffic), 'none' -> untagged rows only, anything else -> exact match on @tag.
// Built per case rather than one OR'd predicate so a real filter can use
// idx_events_site_tag_ts, and @tag is only referenced when it is bound.
function tagWhere(tag) {
  if (!tag) return '1=1';
  return tag === 'none' ? 'tag IS NULL' : 'tag=@tag';
}

// Reused range predicate: site + type='pageview' + day between from/to (+ tag).
function pvWhere(tag) {
  return `site_id=@siteId AND type='pageview' AND date(ts/1000,'unixepoch') BETWEEN @from AND @to AND ${tagWhere(tag)}`;
}

// viewport_w -> bucket predicate
function vwClause(bucket) {
  if (bucket === 'mobile') return 'viewport_w < 768';
  if (bucket === 'tablet') return 'viewport_w >= 768 AND viewport_w < 1200';
  if (bucket === 'desktop') return 'viewport_w >= 1200';
  return '1=1';
}

// Excluded paths (owner-set, e.g. internal stats pages) are still recorded;
// queries report numbers both with and without them. Stored normalized with no
// trailing slash, so the event side is compared the same way. Bound as one JSON
// param via json_each.
const NOT_EXCLUDED = "rtrim(COALESCE(path,''),'/') NOT IN (SELECT value FROM json_each(@ex))";

// Anything -> deduped list of pathnames (full URLs accepted), trailing slash stripped.
function normalizeExcludes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string' || !v.trim()) continue;
    let p;
    try {
      p = new URL(v.trim(), 'http://x').pathname.replace(/\/+$/, '').slice(0, 512);
    } catch {
      continue;
    }
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 50);
}

function overview(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to, ex: '[]', tag: opts.tag };
  const tw = tagWhere(opts.tag);
  const o = overviewStats(db, p, tw);
  const exclude = opts.exclude || [];
  if (exclude.length) {
    o.filtered = overviewStats(db, { ...p, ex: JSON.stringify(exclude) }, `${NOT_EXCLUDED} AND ${tw}`);
    o.excluded = exclude;
  }
  return o;
}

// extra: SQL predicate ANDed onto every event scan (pageviews, durations, sessions).
function overviewStats(db, p, extra) {

  const tot = db
    .prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT visitor) visitors FROM events WHERE ${pvWhere()} AND ${extra}`)
    .get(p);
  const dur = db
    .prepare(
      `SELECT COALESCE(SUM(value_int),0) d FROM events
       WHERE site_id=@siteId AND type='duration' AND date(ts/1000,'unixepoch') BETWEEN @from AND @to AND ${extra}`
    )
    .get(p);
  const sess = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT session_id, COUNT(*) pv FROM events WHERE ${pvWhere()} AND ${extra} GROUP BY session_id
       )`
    )
    .get(p).c;
  const bounces = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT session_id, COUNT(*) pv FROM events WHERE ${pvWhere()} AND ${extra} GROUP BY session_id HAVING pv=1
       )`
    )
    .get(p).c;
  const timeseries = db
    .prepare(
      `SELECT ${DAY} date, COUNT(DISTINCT visitor) visitors, COUNT(*) pageviews
       FROM events WHERE ${pvWhere()} AND ${extra} GROUP BY date ORDER BY date`
    )
    .all(p);

  return {
    visitors: tot.visitors,
    pageviews: tot.pageviews,
    avgDuration: tot.pageviews ? Math.round(dur.d / tot.pageviews) : 0,
    sessions: sess,
    bounceRate: sess ? bounces / sess : 0,
    timeseries,
  };
}

function pages(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to, tag: opts.tag };
  const rows = db
    .prepare(
      `SELECT path, COUNT(DISTINCT visitor) visitors, COUNT(*) pageviews
       FROM events WHERE ${pvWhere(opts.tag)} GROUP BY path ORDER BY pageviews DESC LIMIT 100`
    )
    .all(p);
  const durs = db
    .prepare(
      `SELECT path, COALESCE(SUM(value_int),0) d, COUNT(*) n FROM events
       WHERE site_id=@siteId AND type='duration' AND date(ts/1000,'unixepoch') BETWEEN @from AND @to
         AND ${tagWhere(opts.tag)}
       GROUP BY path`
    )
    .all(p);
  const dmap = {};
  for (const r of durs) dmap[r.path] = r.n ? Math.round(r.d / r.n) : 0;
  return rows.map((r) => ({ ...r, avgDuration: dmap[r.path] || 0 }));
}

function sources(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to, tag: opts.tag };
  const classes = db
    .prepare(
      `SELECT COALESCE(ref_class,'direct') ref_class, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere(opts.tag)} GROUP BY COALESCE(ref_class,'direct') ORDER BY visitors DESC`
    )
    .all(p);
  const domains = db
    .prepare(
      `SELECT ref_domain, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere(opts.tag)} AND ref_domain IS NOT NULL AND ref_domain<>''
       GROUP BY ref_domain ORDER BY visitors DESC LIMIT 50`
    )
    .all(p);
  const campaigns = db
    .prepare(
      `SELECT utm_campaign, utm_source, COUNT(DISTINCT visitor) visitors
       FROM events WHERE ${pvWhere(opts.tag)} AND utm_campaign IS NOT NULL AND utm_campaign<>''
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
      `SELECT session_id, path FROM events WHERE ${pvWhere(opts.tag)} ORDER BY session_id, ts, id`
    )
    .all({ siteId: opts.siteId, from, to, tag: opts.tag });

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
         AND date(ts/1000,'unixepoch') BETWEEN @from AND @to AND ${tagWhere(opts.tag)}
       ORDER BY session_id, ts, id`
    )
    .all({ siteId: opts.siteId, from, to, tag: opts.tag });

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

// Download conversions. "Success" = a download event (tracker click on a file
// link, or a server-side track() hit on a /download route) -- the browser
// actually asked for the file; whether the bytes landed is unknowable when the
// asset lives on GitHub releases.
//
// Rate is computed from counts, never by averaging daily percentages, and the
// unit is visitor-DAYS: getSalt() rotates the visitor salt at UTC midnight, so
// COUNT(DISTINCT visitor) across a multi-day range counts person-days anyway.
// Making that explicit with date||visitor keeps numerator and denominator on
// the same unit in the per-path and total rows.
const VDAY = (type) =>
  `COUNT(DISTINCT CASE WHEN type='${type}' THEN ${DAY}||visitor END)`;

function conversions(db, opts) {
  const { from, to } = range(opts);
  const exclude = opts.exclude || [];
  const p = { siteId: opts.siteId, from, to, ex: JSON.stringify(exclude), tag: opts.tag };
  const extra = `${exclude.length ? NOT_EXCLUDED : '1=1'} AND ${tagWhere(opts.tag)}`;
  const where = `site_id=@siteId AND type IN ('pageview','download')
      AND ${DAY} BETWEEN @from AND @to AND ${extra}`;

  const timeseries = db
    .prepare(
      `SELECT ${DAY} date, ${VDAY('pageview')} base, ${VDAY('download')} converted
       FROM events WHERE ${where} GROUP BY date ORDER BY date`
    )
    .all(p);
  const paths = db
    .prepare(
      `SELECT COALESCE(path,'') path, ${VDAY('pageview')} base, ${VDAY('download')} converted
       FROM events WHERE ${where} GROUP BY COALESCE(path,'')
       HAVING base > 0 OR converted > 0
       ORDER BY converted DESC, base DESC LIMIT 100`
    )
    .all(p);
  const files = db
    .prepare(
      `SELECT name, ${VDAY('download')} converted, COUNT(*) clicks FROM events
       WHERE site_id=@siteId AND type='download' AND name IS NOT NULL AND name<>''
         AND ${DAY} BETWEEN @from AND @to AND ${extra}
       GROUP BY name ORDER BY converted DESC LIMIT 50`
    )
    .all(p);

  let base = 0;
  let converted = 0;
  for (const r of timeseries) {
    base += r.base;
    converted += r.converted;
  }
  return {
    from,
    to,
    base,
    converted,
    rate: base ? converted / base : 0,
    timeseries,
    paths,
    files,
    excluded: exclude,
  };
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
  const p = { siteId: opts.siteId, from, to, ex: JSON.stringify(opts.exclude || []), tag: opts.tag };
  return db
    .prepare(
      `SELECT COALESCE(country,'') country, COUNT(DISTINCT visitor) visitors,
         COUNT(DISTINCT CASE WHEN ${NOT_EXCLUDED} THEN visitor END) visitorsFiltered
       FROM events WHERE ${pvWhere(opts.tag)} GROUP BY COALESCE(country,'') ORDER BY visitors DESC`
    )
    .all(p);
}

function platforms(db, opts) {
  const { from, to } = range(opts);
  const p = { siteId: opts.siteId, from, to, tag: opts.tag };
  const dim = (col) =>
    db
      .prepare(
        `SELECT ${col} name, COUNT(DISTINCT visitor) visitors
         FROM events WHERE ${pvWhere(opts.tag)} AND ${col} IS NOT NULL AND ${col}<>''
         GROUP BY ${col} ORDER BY visitors DESC LIMIT 20`
      )
      .all(p);
  return { browsers: dim('browser'), os: dim('os'), devices: dim('device'), langs: dim('lang') };
}

// by: prop key (caller-validated) -> names split into 'name:value'. Events
// without that prop keep the bare name, as do props stored truncated (invalid
// JSON; json_extract would throw on them).
function eventsList(db, opts) {
  const { from, to } = range(opts);
  const nm = opts.by
    ? `COALESCE(name||':'||CASE WHEN json_valid(props_json) THEN json_extract(props_json,'$."'||@by||'"') END, name)`
    : 'name';
  return db
    .prepare(
      `SELECT ${nm} name, COUNT(*) count, COUNT(DISTINCT visitor) uniques FROM events
       WHERE site_id=@siteId AND type='custom' AND name IS NOT NULL
         AND date(ts/1000,'unixepoch') BETWEEN @from AND @to AND ${tagWhere(opts.tag)}
       GROUP BY 1 ORDER BY count DESC LIMIT 100`
    )
    .all({ siteId: opts.siteId, from, to, tag: opts.tag, by: opts.by });
}

// Every tag in the retained raw events (all time, i.e. the 90-day window),
// newest first, plus a tag:null entry for untagged traffic -- always present
// so the dashboard can offer "Untagged" even before any tag exists.
function tags(db, opts) {
  const rows = db
    .prepare(
      `SELECT tag, COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) visitors,
         COUNT(CASE WHEN type='pageview' THEN 1 END) pageviews, MIN(${DAY}) first, MAX(${DAY}) last
       FROM events WHERE site_id=? GROUP BY tag ORDER BY first DESC, tag IS NULL, tag`
    )
    .all(opts.siteId);
  if (!rows.some((r) => r.tag === null)) rows.push({ tag: null, visitors: 0, pageviews: 0, first: null, last: null });
  return rows;
}

// Segment string -> { from, to, tag? }, or null if malformed.
//   tag:<name>  rows with that tag, within the request's from/to when given, else all retained data
//   untagged    rows with no tag, same range rule
//   date:A..B   every row on UTC days A..B inclusive, whatever its tag
function parseSegment(seg, opts) {
  if (typeof seg !== 'string') return null;
  const all = { from: opts.from || '0000-01-01', to: opts.to || '9999-12-31' };
  if (seg === 'untagged') return { ...all, tag: 'none' };
  if (seg.startsWith('tag:')) {
    const tag = cleanTag(seg.slice(4));
    return tag && tag === seg.slice(4) ? { ...all, tag } : null;
  }
  const m = /^date:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(seg);
  return m && m[1] <= m[2] ? { from: m[1], to: m[2] } : null;
}

// Before/after report, e.g. old site (untagged) vs a redesign's tag. Per
// segment: overview stats + custom events with rate = uniques / visitors (both
// visitor-days, like conversions). rows merges the two by event name, delta =
// b.rate - a.rate, biggest combined uniques first. Bad input -> { error }.
function compare(db, opts) {
  if (opts.by !== undefined && !/^[A-Za-z0-9_]{1,32}$/.test(opts.by)) {
    return { error: 'by must be a prop key: [A-Za-z0-9_]{1,32}' };
  }
  const out = {};
  for (const k of ['a', 'b']) {
    const seg = parseSegment(opts[k], opts);
    if (!seg) return { error: `bad segment ${k}: want tag:<name>, untagged or date:YYYY-MM-DD..YYYY-MM-DD` };
    const p = { siteId: opts.siteId, ...seg };
    const s = overviewStats(db, p, tagWhere(seg.tag));
    s.events = eventsList(db, { ...p, by: opts.by }).map((e) => ({ ...e, rate: s.visitors ? e.uniques / s.visitors : 0 }));
    out[k] = { segment: opts[k], ...s };
  }
  const zero = { count: 0, uniques: 0, rate: 0 };
  const byName = {};
  for (const k of ['a', 'b']) {
    for (const e of out[k].events) {
      const r = byName[e.name] || (byName[e.name] = { name: e.name, a: zero, b: zero });
      r[k] = { count: e.count, uniques: e.uniques, rate: e.rate };
    }
  }
  out.rows = Object.values(byName)
    .map((r) => ({ ...r, delta: r.b.rate - r.a.rate }))
    .sort((x, y) => y.a.uniques + y.b.uniques - (x.a.uniques + x.b.uniques) || (x.name < y.name ? -1 : 1));
  return out;
}

module.exports = { overview, pages, sources, flows, funnel, conversions, heatmap, realtime, eventsList, countries, platforms, tags, compare, range, vwClause, normalizeExcludes };
