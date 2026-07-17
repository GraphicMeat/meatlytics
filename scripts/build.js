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

if (require.main === module) {
  build();
}

module.exports = { minify, build, SRC, OUT, LIMIT };
