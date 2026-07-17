'use strict';
// Hub mode: server-side fan-out to peer meatlytics instances for the dashboard's
// "All sites" view. Peer API keys are read from opts.peers and only ever used in
// outbound server-side requests here -- they never reach the browser.
const Q = require('./queries');

const TIMEOUT_MS = 5000;

async function fetchPeer(peer, qs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${peer.url}/gm/api/overview?${qs}`, {
      headers: { Authorization: `Bearer ${peer.apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return { name: peer.name, ok: false };
    const data = await res.json();
    return { name: peer.name, ok: true, data };
  } catch {
    return { name: peer.name, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ctx: { store, siteId, peers }. qs: raw query string ('from=...&to=...') forwarded to peers as-is.
async function overview(ctx, qs) {
  const sp = new URLSearchParams(qs);
  const local = {
    name: ctx.siteId,
    ok: true,
    data: Q.overview(ctx.store.db, { siteId: ctx.siteId, from: sp.get('from') || undefined, to: sp.get('to') || undefined }),
  };
  const peers = ctx.peers || [];
  const results = await Promise.all(peers.map((p) => fetchPeer(p, qs)));
  return { sites: [local, ...results] };
}

module.exports = { overview };
