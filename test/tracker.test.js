/*
 * Standalone via: node --test test/tracker.test.js
 * (works even before package.json / node_modules exist -- node stdlib only)
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "scripts", "build.js");
const SRC = path.join(ROOT, "src", "tracker", "gm.js");
const DIST = path.join(ROOT, "dist", "gm.js");
const LIMIT = 3072;

test("build.js produces dist/gm.js under the gzip budget", () => {
  execFileSync(process.execPath, [BUILD], { stdio: "inherit" });
  assert.ok(fs.existsSync(DIST), "dist/gm.js should exist after build");

  const built = fs.readFileSync(DIST);
  assert.ok(built.length > 0, "dist/gm.js should not be empty");

  const gz = zlib.gzipSync(built, { level: 9 });
  assert.ok(
    gz.length <= LIMIT,
    `gzipped size ${gz.length} exceeds ${LIMIT} byte budget`
  );
});

test("tracker never hardcodes a third-party URL", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const dist = fs.readFileSync(DIST, "utf8");
  assert.ok(
    !/https?:\/\//.test(src),
    "src/tracker/gm.js must not contain http:// or https:// literals"
  );
  assert.ok(
    !/https?:\/\//.test(dist),
    "dist/gm.js must not contain http:// or https:// literals"
  );
});

test("tracker wires up sendBeacon flushing and History API pageview hooks", () => {
  const dist = fs.readFileSync(DIST, "utf8");
  assert.ok(dist.includes("sendBeacon"), "expected navigator.sendBeacon usage");
  assert.ok(dist.includes("pushState"), "expected history.pushState hook for SPA pageviews");
  assert.ok(dist.includes("replaceState"), "expected history.replaceState hook");
  assert.ok(dist.includes("popstate"), "expected popstate listener");
});

test("tracker exposes the documented event payload field names", () => {
  const dist = fs.readFileSync(DIST, "utf8");
  // Verbatim from the spec's Event Payload Contract: s, v, e, then per-event
  // t, p, r, u, w, x, y, dh, g, d, ms, h, f, n, pr.
  for (const field of ["s:", "v:1", "t:\"pageview\"", "t:\"click\"", "t:\"mouse\"", "t:\"scroll\"", "t:\"duration\"", "t:\"outbound\"", "t:\"download\"", "t:\"submit\"", "t:\"custom\""]) {
    assert.ok(dist.includes(field), `expected dist/gm.js to include ${field}`);
  }
});
