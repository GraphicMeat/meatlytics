#!/usr/bin/env node
/*
 * Builds src/tracker/gm.js -> dist/gm.js.
 * Minify strategy: strip comments, trim indentation, drop blank lines.
 * No tokenizer / renaming -- safe by construction, and gzip eats the rest
 * (repeated whitespace/indentation compresses to ~nothing anyway).
 * node stdlib only (fs, path, zlib). No npm deps.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SRC = path.join(__dirname, "..", "src", "tracker", "gm.js");
const OUT = path.join(__dirname, "..", "dist", "gm.js");
const LIMIT = 3072;

const DASH_SRC = path.join(__dirname, "..", "src", "dashboard", "index.html");
const DASH_OUT = path.join(__dirname, "..", "dist", "dashboard.html");
const DASH_LIMIT = 60 * 1024;

function minify(src) {
  // Strip /* ... */ block comments. Source is written so no comment marker
  // ever appears inside a string or regex literal.
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length && !l.startsWith("//"))
    .join("\n");
}

function build() {
  const src = fs.readFileSync(SRC, "utf8");
  const min = minify(src);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, min);
  const gz = zlib.gzipSync(min, { level: 9 });
  console.log(
    `gm.js: ${src.length} -> ${min.length} bytes minified, ${gz.length} bytes gzipped (limit ${LIMIT})`
  );
  if (gz.length > LIMIT) {
    console.error(
      `FAIL: gm.js gzipped size ${gz.length} exceeds ${LIMIT} byte budget`
    );
    process.exitCode = 1;
  }
  return { min, gzipSize: gz.length };
}

// Dashboard is authored as one self-contained HTML file (inline CSS/JS, no CDN).
// "Build" = copy to dist + enforce the 60 KB budget. No inlining step needed.
function buildDashboard() {
  const html = fs.readFileSync(DASH_SRC, "utf8");
  fs.mkdirSync(path.dirname(DASH_OUT), { recursive: true });
  fs.writeFileSync(DASH_OUT, html);
  const bytes = Buffer.byteLength(html, "utf8");
  const gz = zlib.gzipSync(html, { level: 9 }).length;
  console.log(
    `dashboard.html: ${bytes} bytes raw, ${gz} bytes gzipped (limit ${DASH_LIMIT})`
  );
  if (/https?:\/\//.test(html)) {
    console.error("FAIL: dashboard references an external http(s) host");
    process.exitCode = 1;
  }
  if (bytes > DASH_LIMIT) {
    console.error(`FAIL: dashboard.html ${bytes} exceeds ${DASH_LIMIT} byte budget`);
    process.exitCode = 1;
  }
  return { bytes, gzipSize: gz };
}

if (require.main === module) {
  build();
  buildDashboard();
}

module.exports = { minify, build, buildDashboard, SRC, OUT, LIMIT, DASH_OUT, DASH_LIMIT };
