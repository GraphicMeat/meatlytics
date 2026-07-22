/*
 * Executes src/tracker/gm.js inside a node:vm context against a hand-rolled
 * DOM/BOM stub -- no browser, no jsdom. sendBeacon is stubbed to record what
 * would have gone over the wire; a fake Blob keeps the raw string so the
 * test can inspect it. Date.now() is replaced by a controllable fake clock
 * since the tracker never calls `new Date()`, only Date.now().
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'tracker', 'gm.js');
const SRC_TEXT = fs.readFileSync(SRC, 'utf8');

// Build a fresh sandbox. Nothing runs the tracker yet -- call .load() once
// all pre-load state (dataset attrs, DNT, a gm() queue stub) is set up.
function makeSandbox(opts = {}) {
  const clock = { t: opts.now || 1700000000000 };
  const beacons = [];

  function eventTarget() {
    const listeners = {};
    return {
      _listeners: listeners,
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
    };
  }

  const doc = Object.assign(eventTarget(), {
    currentScript: {
      dataset: { site: opts.site || 'site.test', respectDnt: opts.respectDnt },
    },
    documentElement: { scrollHeight: opts.scrollHeight || 1000 },
    referrer: opts.referrer || '',
    hidden: false,
  });

  const win = Object.assign(eventTarget(), {
    innerWidth: opts.innerWidth || 1000,
    innerHeight: opts.innerHeight || 100,
    scrollY: 0,
    gm: opts.gmStub,
  });

  const nav = {
    doNotTrack: opts.doNotTrack,
    sendBeacon(url, blob) {
      beacons.push({ url, body: JSON.parse(blob._data) });
      return true;
    },
  };

  const loc = {
    hostname: opts.hostname || 'site.test',
    pathname: opts.pathname || '/',
    search: opts.search || '',
    href: opts.href || 'http://site.test/',
    origin: opts.origin || 'http://site.test',
  };

  const hist = {
    pushState(state, title, url) {
      if (url) loc.pathname = url;
    },
    replaceState(state, title, url) {
      if (url) loc.pathname = url;
    },
  };

  function Blob(parts) {
    this._data = parts.join('');
  }

  // Minimal localStorage: property access + removeItem is all the tracker uses.
  win.localStorage = Object.assign(
    { removeItem(k) { delete this[k]; } },
    opts.localStorage,
  );

  const sandbox = {
    document: doc,
    window: win,
    navigator: nav,
    location: loc,
    history: hist,
    URL,
    URLSearchParams,
    Blob,
    Date: { now: () => clock.t },
    fetch: () => beacons.push({ url: undefined, body: undefined, viaFetch: true }),
    setInterval: () => 0,
    console,
  };
  vm.createContext(sandbox);

  return {
    sandbox,
    doc,
    win,
    nav,
    loc,
    hist,
    clock,
    beacons,
    advance(ms) {
      clock.t += ms;
    },
    fire(targetName, type, payload = {}) {
      const t = targetName === 'window' ? win : doc;
      (t._listeners[type] || []).forEach((fn) => fn(payload));
    },
    load() {
      vm.runInContext(SRC_TEXT, sandbox, { filename: 'gm.js' });
    },
    // Flush the buffer: hide the doc, fire visibilitychange, return the
    // most recent sendBeacon payload's events array.
    flush() {
      doc.hidden = true;
      this.fire('document', 'visibilitychange');
      const last = beacons[beacons.length - 1];
      return last ? last.body.e : [];
    },
  };
}

function anchor(href) {
  return {
    closest(sel) {
      return sel === 'a[href]' ? { href } : null;
    },
  };
}

const plainTarget = { closest: () => null };

// 1. pageview on load ------------------------------------------------------
test('tracker: pageview emitted on load with t/p/w/r/u fields', () => {
  const s = makeSandbox({
    pathname: '/start',
    referrer: 'http://ref.example/',
    search: '?utm_source=google&utm_medium=cpc&utm_campaign=summer',
    innerWidth: 1234,
  });
  s.load();
  const e = s.flush();
  const pv = e.find((ev) => ev.t === 'pageview');
  assert.ok(pv, 'pageview event present');
  assert.equal(pv.p, '/start');
  assert.equal(pv.r, 'http://ref.example/');
  assert.equal(pv.w, 1234);
  assert.deepEqual(pv.u, { s: 'google', m: 'cpc', c: 'summer' });
});

// 2. pushState / popstate trigger new pageviews ----------------------------
test('tracker: pushState and popstate each trigger a new pageview', () => {
  const s = makeSandbox({ pathname: '/a' });
  s.load();

  s.sandbox.history.pushState({}, '', '/b');
  s.loc.pathname = '/c';
  s.fire('window', 'popstate');

  const e = s.flush();
  const paths = e.filter((ev) => ev.t === 'pageview').map((ev) => ev.p);
  assert.deepEqual(paths, ['/a', '/b', '/c']);
});

// 3. scroll thresholds ------------------------------------------------------
test('tracker: scroll emits each of 25/50/75/100 once, no dupes', () => {
  const s = makeSandbox({ scrollHeight: 1000, innerHeight: 100 });
  s.load();
  [150, 400, 650, 900].forEach((y) => {
    s.win.scrollY = y;
    s.fire('document', 'scroll');
  });
  // repeat the same position -- must not duplicate
  s.fire('document', 'scroll');

  const e = s.flush();
  const hits = e.filter((ev) => ev.t === 'scroll').map((ev) => ev.d);
  assert.deepEqual(hits, [25, 50, 75, 100]);
});

// 4. click: coordinates, outbound, download --------------------------------
test('tracker: click emits x/y percentages', () => {
  const s = makeSandbox({ innerWidth: 1000, scrollHeight: 2000 });
  s.load();
  s.fire('document', 'click', { pageX: 500, pageY: 1000, target: plainTarget });
  const e = s.flush();
  const click = e.find((ev) => ev.t === 'click');
  assert.equal(click.x, 50);
  assert.equal(click.y, 50);
});

test('tracker: click on cross-origin anchor also emits outbound', () => {
  const s = makeSandbox({ href: 'http://site.test/', origin: 'http://site.test' });
  s.load();
  s.fire('document', 'click', {
    pageX: 1,
    pageY: 1,
    target: anchor('http://other.test/page'),
  });
  const e = s.flush();
  const out = e.find((ev) => ev.t === 'outbound');
  assert.ok(out, 'outbound event present');
  assert.equal(out.h, 'other.test');
  assert.ok(!e.find((ev) => ev.t === 'download'), 'no spurious download event');
});

test('tracker: click on /file.dmg link emits download with filename', () => {
  const s = makeSandbox({ href: 'http://site.test/', origin: 'http://site.test' });
  s.load();
  s.fire('document', 'click', {
    pageX: 1,
    pageY: 1,
    target: anchor('/downloads/file.dmg'),
  });
  const e = s.flush();
  const dl = e.find((ev) => ev.t === 'download');
  assert.ok(dl, 'download event present');
  assert.equal(dl.f, 'file.dmg');
  assert.ok(!e.find((ev) => ev.t === 'outbound'), 'no spurious outbound event (same origin)');
});

// 5. form submit never leaks field values -----------------------------------
test('tracker: submit emits form id, payload never contains planted field value', () => {
  const s = makeSandbox();
  s.load();
  s.fire('document', 'submit', {
    target: { id: 'signupForm', name: '', password: 'PlantedSecretValue123' },
  });
  const e = s.flush();
  const sub = e.find((ev) => ev.t === 'submit');
  assert.ok(sub);
  assert.equal(sub.f, 'signupForm');
  assert.ok(!JSON.stringify(e).includes('PlantedSecretValue123'), 'planted secret never sent');
});

// 6. mousemove sampling + grid accumulation ----------------------------------
test('tracker: mousemove sampling throttles within 500ms, accumulates per cell, flushed on hidden', () => {
  const s = makeSandbox();
  s.load();
  s.clock.t = 1000;
  s.fire('document', 'mousemove', { pageX: 10, pageY: 10 }); // grid[0:0] = 1

  s.advance(300); // < 500ms -- ignored
  s.fire('document', 'mousemove', { pageX: 15, pageY: 15 });

  s.advance(600); // >= 500ms since lastM -- counted, same 40px cell
  s.fire('document', 'mousemove', { pageX: 20, pageY: 20 }); // grid[0:0] = 2

  const e = s.flush();
  const mouse = e.find((ev) => ev.t === 'mouse');
  assert.ok(mouse, 'mouse event present');
  assert.deepEqual(mouse.g, { '0:0': 2 });
});

// 7. buffer cap: oldest dropped past 50 --------------------------------------
test('tracker: buffer caps at 50 events, drops oldest', () => {
  const s = makeSandbox({ innerWidth: 100000 });
  s.load(); // 1 pageview already queued
  for (let i = 1; i <= 60; i++) {
    s.fire('document', 'click', { pageX: i * 100, pageY: 1, target: plainTarget });
  }
  const e = s.flush();
  assert.equal(e.length, 50);
  assert.ok(!e.some((ev) => ev.t === 'pageview'), 'pageview (oldest) was dropped');
  const xs = e.filter((ev) => ev.t === 'click').map((ev) => ev.x);
  assert.ok(!xs.includes(1), 'click #10 (x=1.0) was dropped');
  assert.ok(xs.includes(1.1), 'click #11 (x=1.1) survived');
  assert.ok(xs.includes(6), 'click #60 (x=6.0) survived');
});

// 8. visibilitychange batches + duration -------------------------------------
test('tracker: visibilitychange hidden sends batched {s,v,e} with a duration event', () => {
  const s = makeSandbox({ site: 'site.test', now: 5000 });
  s.load();
  s.advance(4000);
  s.doc.hidden = true;
  s.fire('document', 'visibilitychange');

  assert.equal(s.beacons.length, 1);
  const { url, body } = s.beacons[0];
  assert.equal(url, '/gm/e');
  assert.equal(body.s, 'site.test');
  assert.equal(body.v, 1);
  assert.ok(Array.isArray(body.e));
  const dur = body.e.find((ev) => ev.t === 'duration');
  assert.ok(dur, 'duration event present');
  assert.ok(dur.ms > 0, 'duration ms > 0');
  assert.equal(dur.ms, 4000);
});

// 9. custom events: pre-load queue drained + post-load gm() -----------------
test('tracker: pre-load gm.q queue drained after load, gm() after load emits custom events', () => {
  function gmStub() {
    (gmStub.q = gmStub.q || []).push(arguments);
  }
  const s = makeSandbox({ gmStub });
  s.sandbox.window.gm('pre1', { a: 1 });
  s.sandbox.window.gm('pre2', { b: 2 });
  s.load();
  s.sandbox.window.gm('post1', { c: 3 });

  const e = s.flush();
  const custom = e.filter((ev) => ev.t === 'custom');
  const names = custom.map((ev) => ev.n);
  assert.ok(names.includes('pre1') && names.includes('pre2') && names.includes('post1'));
  const post1 = custom.find((ev) => ev.n === 'post1');
  assert.deepEqual(post1.pr, { c: 3 });
});

// 10. Do Not Track opt-in ----------------------------------------------------
test('tracker: data-respect-dnt + DNT=1 -> no listeners, window.gm is a no-op', () => {
  const s = makeSandbox({ respectDnt: 'true', doNotTrack: '1' });
  s.load();

  assert.equal(typeof s.sandbox.window.gm, 'function');
  assert.doesNotThrow(() => s.sandbox.window.gm('x', { y: 1 }));

  assert.equal(Object.keys(s.doc._listeners).length, 0, 'no document listeners registered');
  assert.equal(Object.keys(s.win._listeners).length, 0, 'no window listeners registered');

  s.fire('document', 'click', { pageX: 1, pageY: 1, target: plainTarget });
  s.fire('document', 'scroll');
  s.doc.hidden = true;
  s.fire('document', 'visibilitychange');
  assert.equal(s.beacons.length, 0, 'nothing ever sent');
});

// 11. ?gm-ignore self-exclusion ---------------------------------------------
test('tracker: ?gm-ignore=1 sets flag, no listeners, nothing sent', () => {
  const s = makeSandbox({ search: '?gm-ignore=1' });
  s.load();

  assert.equal(s.win.localStorage.gm_ignore, 'true');
  assert.equal(typeof s.sandbox.window.gm, 'function');
  assert.doesNotThrow(() => s.sandbox.window.gm('x', { y: 1 }));
  assert.equal(Object.keys(s.doc._listeners).length, 0, 'no document listeners');
  assert.equal(Object.keys(s.win._listeners).length, 0, 'no window listeners');

  s.doc.hidden = true;
  s.fire('document', 'visibilitychange');
  assert.equal(s.beacons.length, 0, 'nothing ever sent');
});

test('tracker: pre-existing gm_ignore flag -> tracker is a no-op', () => {
  const s = makeSandbox({ localStorage: { gm_ignore: 'true' } });
  s.load();

  assert.equal(Object.keys(s.doc._listeners).length, 0, 'no document listeners');
  s.doc.hidden = true;
  s.fire('document', 'visibilitychange');
  assert.equal(s.beacons.length, 0, 'nothing ever sent');
});

test('tracker: ?gm-ignore=0 clears flag and tracking resumes', () => {
  const s = makeSandbox({ search: '?gm-ignore=0', localStorage: { gm_ignore: 'true' } });
  s.load();

  assert.equal(s.win.localStorage.gm_ignore, undefined, 'flag cleared');
  const e = s.flush();
  assert.ok(e.some((ev) => ev.t === 'pageview'), 'pageview tracked again');
});

test('tracker: broken localStorage -> tracking still works', () => {
  const s = makeSandbox();
  Object.defineProperty(s.win, 'localStorage', {
    get() { throw new Error('denied'); },
  });
  s.load();

  const e = s.flush();
  assert.ok(e.some((ev) => ev.t === 'pageview'), 'pageview tracked');
});
