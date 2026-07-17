# meatlytics

Self-hosted website analytics that weighs nothing and shares nothing.

One npm package, mounted as middleware on the Node server you already run.
Tracker, collector, storage, and dashboard all ship inside it. Every byte of
analytics data stays on your server — no third-party requests, ever, from the
client or the backend. That's a build gate, not a promise.

```
tracker         1.6 KB gzipped   (hard-gated at 3 KB — GA is ~50 KB, Plausible ~1 KB with fewer features)
dashboard       6.3 KB gzipped   single self-contained HTML file, no framework
dependencies    1                (better-sqlite3)
collect
throughput      ~139,000 req/s   measured on a laptop, sub-ms latency
```

## What it captures — automatically

Add one script tag. No configuration, no event wiring:

- **Pageviews** — including SPA route changes (History API)
- **Sessions, flows** — entry → path → exit chains with drop-off counts
- **Funnels** — built ad-hoc in the dashboard from pages or custom events, computed retroactively — no pre-registration
- **Click + mouse heatmaps** — rendered as an overlay on your live page, per viewport class (mobile/tablet/desktop)
- **Outbound links, file downloads, form submits** (form id only — never field values)
- **Scroll depth, time on page** (visible time, not wall-clock)
- **Traffic sources** — referrer classification (search/social/direct) + UTM campaigns
- **Realtime** — who's on the site right now

Custom events when you need precision:

```html
<script>window.gm=window.gm||function(){(gm.q=gm.q||[]).push(arguments)}</script>
```
```js
gm('pricing-viewed', { plan: 'pro' });
```

(The stub queues calls made before the tracker loads; drop it if you only call
`gm()` from user interactions.)

## Install

```
npm install meatlytics                          # once published to npm
npm install github:GraphicMeat/meatlytics       # straight from GitHub, no publish needed
```

The GitHub install works as soon as the repo is pushed — npm's `prepare`
lifecycle script builds `dist/` automatically after cloning.

For local development against a checkout on disk:

```json
{ "dependencies": { "meatlytics": "file:../analytics" } }
```

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

Mount it **before** body parsers, static handlers, and catch-alls — it reads
`/gm/e`'s raw body itself and claims its own paths (`/gm.js`, `/gm/e`,
`/_analytics`, `/gm/api/*`), passing everything else through untouched.

Add one tag to every page you want tracked:

```html
<script defer src="/gm.js" data-site="mysite"></script>
```

`data-site` is optional — the tracker falls back to `location.hostname` — but
set it when the hostname doesn't match your `siteId` (local dev, staging,
multiple domains).

Visit `/_analytics`, log in with `dashboardPassword`. Done.

There's no Express dependency: the middleware is a plain `(req, res, next)`
handler over `node:http`, so it composes with Express, or any router with the
same middleware shape, or a bare `http.createServer`.

## Options

```js
analytics({
  siteId,             // required. identifies this site's rows in the DB
  dbPath,             // required. SQLite file path (directory created if missing)
  dashboardPassword,  // required for the dashboard. compared in constant time; login throttled (10 fails / 15 min / IP)
  apiKey,             // required for /gm/api/* from outside the dashboard (hub pulls, scripts)
  peers,              // optional. [{ name, url, apiKey }] — see Hub mode
  respectDNT,         // optional, default false. if true, tracker no-ops when the browser signals Do Not Track
})
```

Returns middleware with two extras for tests/ops: `middleware.store` (the
SQLite-backed store) and `middleware.stop()` (stops flush + nightly timers).

### Routes it mounts

| Route | Purpose | Auth |
|---|---|---|
| `GET /gm.js` | Tracker script | public |
| `POST /gm/e` | Collect endpoint | public, rate-limited, always 204 |
| `GET /_analytics` | Dashboard | password login, HttpOnly session cookie |
| `POST /_analytics/login` | Dashboard login | throttled |
| `GET /gm-overlay.js` | Heatmap overlay module (lazy-loaded, dashboard preview only) | public |
| `GET /gm/api/overview` | Totals + timeseries | Bearer `apiKey` or dashboard session |
| `GET /gm/api/pages` | Top pages | " |
| `GET /gm/api/sources` | Referrer classes, domains, campaigns | " |
| `GET /gm/api/flows` | Session path chains | " |
| `GET /gm/api/funnel` | Ad-hoc funnel: `?steps=/,/pricing,signup` | " |
| `GET /gm/api/heatmap` | Click/mouse density per page + viewport | " (or short-lived overlay token) |
| `GET /gm/api/realtime` | Active visitors, last 5 min | " |
| `GET /gm/api/events` | Custom event counts | " |
| `GET /gm/api/hub/overview` | All sites (local + peers) | " |

All stats endpoints take `?from=YYYY-MM-DD&to=YYYY-MM-DD`.

## Privacy

Built to the Plausible/Fathom standard — stricter in places:

- **No cookies, no localStorage, no fingerprinting** for visitors. The only
  cookie is the dashboard owner's own login session, scoped to `/_analytics`.
- **Cookieless identity:** `visitor = SHA256(dailySalt + ip + userAgent + siteId)`,
  truncated to 16 bytes. The salt rotates at UTC midnight and the old salt is
  discarded — after 24 hours nobody, including you, can re-derive who was who.
- **Raw IP and user-agent never touch disk.** Used in memory for the hash and
  rate limiting, then gone. A session = same hash, <30 min gap.
- **Zero third-party requests**, enforced at build time: `scripts/build.js`
  fails if an external URL appears in the tracker or dashboard bundle.
- **Retention:** raw events 90 days, then pruned. Daily aggregates kept forever.
- **Bots** filtered by user-agent at collect time, never stored.
- **Form tracking records the form's id — never its values.**

Because there are no cookies and no persistent identifiers, no cookie-consent
banner is required. A short disclosure in your privacy policy is still good
practice (not legal advice) — here's one you can paste:

> **Analytics.** This site uses self-hosted, first-party analytics. All
> analytics data is processed and stored on our own server and is never shared
> with, or sent to, any third party. We do not use analytics cookies and we do
> not store personal information. Visits are counted using an anonymous
> identifier derived from your IP address and browser signature, hashed with a
> secret key that is automatically deleted every 24 hours — after that,
> re-identifying any visitor is impossible, even for us. Raw IP addresses and
> browser signatures are never written to disk. What we record: pages viewed,
> referring site, clicks, scrolling, and approximate time on page — in
> aggregate, to understand which content works and to improve the site.

## Hub mode (multi-site dashboard)

Run meatlytics on several sites; make any one of them the hub. Its dashboard
gains a site switcher (Local / each peer / All sites) and pulls peer stats
**server-side** — peer API keys never reach the browser.

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

`peer.url` is the origin the peer's middleware is mounted on. A dead peer
returns `{ name, ok: false }` and never breaks the rest; peer requests time
out after 5 s. Peer and "All sites" views are overview-only — flows, funnels,
heatmaps, and realtime stay on each site's own dashboard. Setup is symmetric:
add a mirror `peers` entry on the other side to hub from there too.

## Serving behind nginx (static-page sites)

Pages served as static HTML by nginx, Node only running an API? meatlytics
must stay same-origin — the tracker posts to `/gm/e` with no CORS by design
(cross-origin analytics writes are deliberately not a feature). Proxy its
paths to the Node process in your existing server block:

```nginx
location = /gm.js         { proxy_pass http://127.0.0.1:3000; }
location = /gm/e          { proxy_pass http://127.0.0.1:3000; }
location = /gm-overlay.js { proxy_pass http://127.0.0.1:3000; }
location = /_analytics    { proxy_pass http://127.0.0.1:3000; }
location /_analytics/     { proxy_pass http://127.0.0.1:3000; }
location /gm/api/         { proxy_pass http://127.0.0.1:3000; }
```

Keep this above any catch-all regex locations. The script tag on the static
pages stays a plain relative `/gm.js`.

## How it stays fast

- The tracker batches events in memory and flushes with `navigator.sendBeacon`
  on tab-hide/close and every 15 s — near-zero network chatter, nothing lost
  when the tab closes.
- The collect endpoint does ~no synchronous work: validate, stamp, queue,
  respond 204. A background flusher writes batches to SQLite (WAL mode) in
  single transactions every 2 s.
- Every dashboard asset is pre-built, gzipped, cached; the whole dashboard is
  one HTML file with hand-drawn canvas charts.
- Rollups + pruning run in-process nightly. No cron, no workers, no queue —
  nothing to operate besides your existing Node process.

## Development

```
npm test          # node:test — unit + integration, no external services
npm run build     # builds dist/gm.js + dist/dashboard.html, enforces size gates
```

Size budgets are enforced by the build: tracker ≤ 3072 bytes gzipped,
dashboard ≤ 60 KB raw. Design spec and implementation plan live in
`docs/superpowers/`.

## License

AGPL-3.0. Free to use, self-host, and modify. If you distribute a modified
version or offer it to others as a service, the AGPL requires you to publish
your modifications under the same license.

Need to embed meatlytics in a closed product without AGPL obligations?
Commercial licenses are available - open an issue or contact GraphicMeat.
