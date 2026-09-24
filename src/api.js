'use strict';
const Q = require('./queries');
const hub = require('./hub');

// Parse ?steps=path:/a,event:signup,path:/b into [{type,value}].
function parseSteps(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i < 0) return { type: 'path', value: s };
      const type = s.slice(0, i);
      const value = s.slice(i + 1);
      return { type: type === 'event' ? 'event' : 'path', value };
    });
}

// Owner-managed list in meta (Settings > Excluded paths); already normalized on save.
function excludePaths(store) {
  try {
    return JSON.parse(store.metaGet('excludePaths') || '[]');
  } catch {
    return [];
  }
}

function json(res, obj, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

// ctx: { store, siteId, auth }. Returns true if it handled the request.
function handle(req, res, url, ctx) {
  const p = url.pathname;
  if (!p.startsWith('/gm/api/')) return false;
  const sp = url.searchParams;
  const db = ctx.store.db;
  // tag: '' / absent = all traffic, 'none' = untagged only, else exact match (see queries.tagWhere).
  const base = {
    siteId: ctx.siteId,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
    tag: sp.get('tag') || undefined,
  };
  const exclude = excludePaths(ctx.store);

  switch (p) {
    case '/gm/api/token':
      return json(res, { token: ctx.auth.makeHeatToken() }), true;
    case '/gm/api/overview':
      return json(res, Q.overview(db, { ...base, exclude })), true;
    case '/gm/api/pages':
      return json(res, Q.pages(db, base)), true;
    case '/gm/api/sources':
      return json(res, Q.sources(db, base)), true;
    case '/gm/api/flows':
      return json(res, Q.flows(db, { ...base, depth: Math.max(2, Math.min(6, +sp.get('depth') || 3)) })), true;
    case '/gm/api/funnel':
      return json(res, Q.funnel(db, { ...base, steps: parseSteps(sp.get('steps')) })), true;
    case '/gm/api/heatmap':
      return json(res, Q.heatmap(db, {
        siteId: ctx.siteId,
        path: sp.get('path') || '/',
        vwBucket: sp.get('vw') || 'desktop',
        kind: sp.get('type') === 'mouse' ? 'mouse' : 'click',
      })), true;
    case '/gm/api/realtime':
      return json(res, Q.realtime(db, { siteId: ctx.siteId })), true;
    case '/gm/api/events':
      return json(res, Q.eventsList(db, base)), true;
    case '/gm/api/conversions':
      return json(res, Q.conversions(db, { ...base, exclude })), true;
    case '/gm/api/countries':
      return json(res, Q.countries(db, { ...base, exclude })), true;
    case '/gm/api/platforms':
      return json(res, Q.platforms(db, base)), true;
    case '/gm/api/tags':
      return json(res, Q.tags(db, base)), true;
    case '/gm/api/compare': {
      // Segments carry their own tag; ?tag= is ignored here, ?from/&to bound tag segments.
      const r = Q.compare(db, { ...base, a: sp.get('a'), b: sp.get('b'), by: sp.get('by') || undefined });
      return json(res, r, r.error ? 400 : 200), true;
    }
    case '/gm/api/hub/overview':
      hub.overview({ store: ctx.store, siteId: ctx.siteId, peers: ctx.peers }, sp.toString()).then((data) => json(res, data));
      return true;
    default:
      return json(res, { error: 'not found' }, 404), true;
  }
}

module.exports = { handle, parseSteps, excludePaths };
