'use strict';
// GitHub release download counts vs website download clicks -> new users vs updates.
//
// A stable release is "the latest" from its publish time until the next one;
// that is the window in which the site sends people to it. GitHub counts every
// fetch of an installer, the site counts visitors who clicked. Per release:
//   newUsers = min(site, gh)      updates = gh - newUsers
// `updates` is everything the site did not send: in-app updaters plus anyone
// who went straight to GitHub. Both inputs are estimates (fetches vs
// visitor-days), so treat the split as a trend, not a census.
//
// Opt-in: the backend only talks to api.github.com when opts.github is set,
// and only ever GETs public release metadata. No visitor data leaves.
const Q = require('./queries');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Real installers only: update-check files (appcast.xml, latest.json, .sig)
// count checks, not installs.
const INSTALLERS = /\.(dmg|exe|msi|deb|snap|rpm|appimage)$/i;
const SITE_RE = /^(download|event)(?::(.+))?$/;
const TTL = 60 * 60 * 1000;

// opts.github: 'owner/name' | 'https://github.com/owner/name/releases' | { repo, site?, assets? } | array of those.
//   site:   which website event counts as "asked for the app" — 'download' (default,
//           every file-download event), 'download:<name>' (e.g. a /download/:app route
//           recorded with track()) or 'event:<name>' (a custom event).
//   assets: regex for the release files that count as installs (default: dmg, exe, msi,
//           deb, snap, rpm, AppImage).
function normalize(g) {
  if (!g) return [];
  return (Array.isArray(g) ? g : [g]).map((a) => {
    const o = typeof a === 'string' ? { repo: a } : a || {};
    const url = /^https?:\/\/github\.com\/([^/]+\/[^/?#]+)/.exec(String(o.repo));
    const repo = url ? url[1] : String(o.repo || '');
    if (!REPO_RE.test(repo)) {
      throw new Error(`meatlytics: opts.github needs "owner/name" or a github.com URL, got "${o.repo}"`);
    }
    const m = SITE_RE.exec(o.site || 'download');
    if (!m || (m[1] === 'event' && !m[2])) {
      throw new Error(`meatlytics: opts.github site must be "download", "download:<name>" or "event:<name>", got "${o.site}"`);
    }
    return {
      repo,
      type: m[1] === 'event' ? 'custom' : 'download',
      name: m[2] || null,
      assets: o.assets ? new RegExp(o.assets, 'i') : INSTALLERS,
    };
  });
}

// Cached per repo for an hour (three sites share one VPS IP and GitHub allows
// 60 unauthenticated calls an hour), one refresh in flight at a time, stale
// data served when GitHub errors.
// ponytail: first 100 releases only; follow the Link header if a repo ever outgrows that.
function createReleases({ fetch = globalThis.fetch, now = Date.now, ttl = TTL } = {}) {
  const cache = new Map(); // repo -> { at, releases }
  const pending = new Map();

  async function refresh(repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'meatlytics' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('unexpected releases payload');
    // Nightlies are a rolling prerelease and drafts are invisible to /releases/latest,
    // which is what the sites link to: neither is ever "the latest".
    const releases = body
      .filter((r) => r && !r.draft && !r.prerelease && Date.parse(r.published_at))
      .map((r) => ({
        tag: String(r.tag_name || ''),
        published: Date.parse(r.published_at),
        // Rendered as a link by the dashboard: only ever a github.com page.
        url: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : null,
        assets: (r.assets || []).map((a) => ({ name: String(a.name || ''), count: a.download_count | 0 })),
      }))
      .sort((a, b) => b.published - a.published);
    cache.set(repo, { at: now(), releases });
    return releases;
  }

  return async function get(repo) {
    const c = cache.get(repo);
    if (c && now() - c.at < ttl) return c.releases;
    if (!pending.has(repo)) pending.set(repo, refresh(repo).finally(() => pending.delete(repo)));
    try {
      return await pending.get(repo);
    } catch (e) {
      if (c) return c.releases;
      throw e;
    }
  };
}

// releases: newest first. Site counts exist only for windows that start after
// the first recorded signal event: an earlier start predates tracking or the
// 90-day raw retention, and would read as "all updates".
// ponytail: raw events only; persist closed-window counts if history beyond 90 days is wanted.
function split(db, siteId, exclude, app, releases) {
  const q = { siteId, type: app.type, name: app.name, exclude };
  const since = Q.signalSince(db, q);
  // gh/newUsers/updates cover only the `releases` with a site count, so gh = newUsers + updates;
  // allTime is every stable release, whatever its window.
  const totals = { gh: 0, newUsers: 0, updates: 0, releases: 0, allTime: 0 };
  const rows = releases.map((r, i) => {
    const gh = r.assets.reduce((s, a) => (app.assets.test(a.name) ? s + a.count : s), 0);
    totals.allTime += gh;
    const row = { tag: r.tag, published: new Date(r.published).toISOString(), url: r.url, gh, site: null, newUsers: null, updates: null };
    if (since === null || r.published < since) return row;
    // i === 0 is still the latest: its window runs to now.
    row.site = Q.signalCount(db, { ...q, from: r.published, to: i ? releases[i - 1].published : Number.MAX_SAFE_INTEGER });
    row.newUsers = Math.min(row.site, gh);
    row.updates = gh - row.newUsers;
    totals.gh += gh;
    totals.newUsers += row.newUsers;
    totals.updates += row.updates;
    totals.releases++;
    return row;
  });
  return { releases: rows, totals };
}

function createGithub(opts) {
  const apps = normalize(opts.github);
  const get = createReleases({ fetch: opts.githubFetch });

  async function report(db, { siteId, exclude }) {
    const out = await Promise.all(
      apps.map(async (app) => {
        try {
          return { repo: app.repo, ...split(db, siteId, exclude || [], app, await get(app.repo)) };
        } catch (e) {
          console.error(`[meatlytics] github ${app.repo}:`, e.message);
          return { repo: app.repo, error: 'unavailable', releases: [], totals: null };
        }
      })
    );
    return { configured: apps.length > 0, apps: out };
  }

  return { apps, report };
}

module.exports = { createGithub, createReleases, normalize, split };
