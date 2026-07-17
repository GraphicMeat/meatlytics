# meatlytics

The quickest, lightest self-hosted website analytics available. One npm package,
mounted as framework-light middleware (no Express dependency — it's plain
`node:http` under the hood, so it works with `app.use()` in Express or any
router that composes `(req, res, next)` handlers the same way). Everything —
tracker, collector, storage, dashboard — ships in this one package. All data
stays on the server that runs it. No third-party requests, ever, in either the
tracker or the backend.

## Install

Not published to npm yet. Point at the repo directly:

```json
{
  "dependencies": {
    "meatlytics": "file:../analytics"
  }
}
```

(swap the relative path for wherever you've checked this repo out, or replace
with a git/npm reference once published).

Only runtime dependency: `better-sqlite3`.

## Quickstart

```js
const express = require('express');
const analytics = require('meatlytics');

const app = express();

app.use(analytics({
  siteId: 'mysite',
  dbPath: '/var/lib/meatlytics/mysite.db',
  dashboardPassword: process.env.ANALYTICS_PASS,
  apiKey: process.env.ANALYTICS_API_KEY,
}));

// ... your other routes ...
app.listen(3000);
```

Mount it **before** your static file / catch-all routes so it can claim its
own paths (`/gm.js`, `/gm/e`, `/_analytics`, `/gm/api/*`).

Add one script tag to every page you want tracked:

```html
<script defer src="/gm.js" data-site="mysite"></script>
```

`data-site` is optional — the tracker falls back to `location.hostname` if
omitted — but set it explicitly when a hostname doesn't match your `siteId`
(local dev, staging, multiple domains for one site, etc).

Visit `/_analytics` and log in with `dashboardPassword` to see data.

## Options reference

```js
analytics({
  siteId,             // required. identifies rows in the (shared or per-site) DB
  dbPath,             // required. path to the SQLite file (directory is created if missing)
  dashboardPassword,  // required to use the dashboard. plain string, compared in constant time
  apiKey,             // required to use /gm/api/* from outside the dashboard (hub pulls, scripts)
  peers,              // optional. [{ name, url, apiKey }] — see "Hub mode" below
  respectDNT,          // optional, default false. if true, tracker sends nothing when navigator.doNotTrack === '1'
})
```

Returns Express-style middleware `(req, res, next)`. Two extra properties for
tests/ops:

- `middleware.store` — the underlying `Store` (SQLite handle + query helpers)
- `middleware.stop()` — stops the flush timer and nightly rollup timer (call in tests/shutdown)

### Routes it mounts

| Route | Purpose | Auth |
|---|---|---|
| `GET /gm.js` | Tracker script (~1.6KB gzipped) | public |
| `POST /gm/e` | Collect endpoint | public, rate-limited, always 204 |
| `GET /_analytics` | Dashboard | password login, session cookie |
| `POST /_analytics/login` | Dashboard login | — |
| `GET /gm/api/*` | JSON stats used by the dashboard/hub | `Authorization: Bearer <apiKey>` or dashboard session |

## Privacy

- **No cookies for visitors.** The only cookie set is the dashboard owner's
  own login session, scoped to `/_analytics` — it has no consent implications
  because it isn't set for site visitors.
- **No localStorage, no fingerprinting.**
- **Cookieless visitor identity:** `visitor = SHA256(dailySalt + ip + userAgent + siteId)`,
  truncated to 16 bytes. The salt rotates at UTC midnight and the previous
  day's salt is discarded — after 24 hours nobody, including the site owner,
  can re-derive who was who from stored data.
- **Raw IP and user-agent are never written to disk.** Only the derived hash is stored.
  A session is the same visitor hash with less than a 30 minute gap between events.
- **Zero third-party requests**, client or server — this is a build-gate
  (`scripts/build.js` fails if `http(s)://` appears in the tracker or dashboard
  bundle) as well as a design constraint.
- **Retention:** raw events are kept 90 days, then deleted. Daily rollup
  aggregates (`daily_stats`, `daily_sources`, `daily_events`) are kept forever
  and are what long-range dashboard views fall back to.
- **Bot traffic** is filtered by user-agent at collect time and never stored.

## Hub mode (multi-site dashboard)

If you run meatlytics on more than one site, any one of them can act as a
**hub**: its dashboard gets a site switcher (Local / each peer / All sites)
that pulls the peers' overview stats server-side, so a peer's API key is
only ever held by the hub's Node process — it's never sent to the browser.

```js
app.use(analytics({
  siteId: 'graphicmeat',
  dbPath: '/var/lib/meatlytics/graphicmeat.db',
  dashboardPassword: process.env.ANALYTICS_PASS,
  apiKey: process.env.ANALYTICS_API_KEY,
  peers: [
    { name: 'mailvault', url: 'https://mailvaultapp.com', apiKey: process.env.MAILVAULT_ANALYTICS_KEY },
  ],
}));
```

`peer.url` must be the origin the peer's own middleware is mounted on (it
calls the peer's `GET /gm/api/overview` with `Authorization: Bearer <peer.apiKey>`).
An unreachable or erroring peer shows up as `{ name, ok: false }` in the hub
response — it never fails the whole request, and every other site's data is
unaffected. Requests to peers time out after 5 seconds.

The site switcher, peer, and "All sites" views are **overview-only** (totals +
timeseries). Flows/funnels/heatmaps/realtime stay per-site — switch to
"Local" (or open that peer's own `/_analytics` directly) for the deep views.

Peer setup is symmetric: to make graphicmeat show up in mailvault's hub, add a
`peers` entry for graphicmeat over on the mailvault side (and vice versa) —
each side just needs the other's public URL + the API key it issued.

## Serving behind nginx (static-page sites)

If your site's pages are served as static HTML by nginx rather than by the
Node process itself (common for a marketing site with a small Node API
alongside it), meatlytics still needs to be same-origin — the tracker posts to
`/gm/e` with no CORS support by design (adding CORS would mean accepting
cross-origin analytics writes, which this project deliberately does not do).
Proxy meatlytics' paths straight through to the Node app in your existing
server block:

```nginx
location = /gm.js       { proxy_pass http://127.0.0.1:3000; }
location = /gm/e        { proxy_pass http://127.0.0.1:3000; }
location = /gm-overlay.js { proxy_pass http://127.0.0.1:3000; }
location = /_analytics  { proxy_pass http://127.0.0.1:3000; }
location /_analytics/   { proxy_pass http://127.0.0.1:3000; }
location /gm/api/       { proxy_pass http://127.0.0.1:3000; }
```

Put this block above your static `location / { root ...; }` block (nginx
matches the most specific `location` first for exact matches like these, but
keep it above any catch-all regex locations to be safe). Then the `<script>`
tag on every static page stays a plain relative path:

```html
<script defer src="/gm.js" data-site="yoursite"></script>
```

## Testing

```
npm test          # node:test — unit + integration, no external services
npm run build     # builds dist/gm.js and dist/dashboard.html, enforces size gates
```
