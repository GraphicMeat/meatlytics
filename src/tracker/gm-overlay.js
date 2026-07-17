// gm-overlay.js -- heatmap overlay for the dashboard's live-page preview iframe.
// Loaded lazily by gm.js only when the URL carries ?gm-overlay=<token>. Not shipped
// to real visitors and not size-gated. Draws a translucent canvas over the page:
// click density (radial blobs) or mouse density (40px grid), toggled by a small
// control. Data comes from same-origin /gm/api/heatmap authorised by the heat token.
'use strict';

export function init(token) {
  var W = window, D = document, L = location;

  function bucket() {
    var w = W.innerWidth;
    return w < 768 ? 'mobile' : w < 1200 ? 'tablet' : 'desktop';
  }
  function docW() { return D.documentElement.scrollWidth; }
  function docH() { return D.documentElement.scrollHeight; }

  var canvas = D.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;top:0;left:0;z-index:2147483646;pointer-events:none;';
  var ctx;

  function size() {
    canvas.width = docW();
    canvas.height = docH();
    canvas.style.width = docW() + 'px';
    canvas.style.height = docH() + 'px';
    ctx = canvas.getContext('2d');
  }

  function drawClicks(points) {
    var cw = docW(), ch = docH();
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var x = (p.x / 100) * cw, y = (p.y / 100) * ch;
      var r = 24;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      var a = Math.min(0.7, 0.15 + p.n * 0.12);
      g.addColorStop(0, 'rgba(255,60,0,' + a + ')');
      g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
    }
  }

  function drawMouse(cells) {
    var max = 1;
    for (var i = 0; i < cells.length; i++) if (cells[i].n > max) max = cells[i].n;
    for (i = 0; i < cells.length; i++) {
      var c = cells[i];
      var a = Math.min(0.65, 0.1 + (c.n / max) * 0.55);
      ctx.fillStyle = 'rgba(0,140,255,' + a + ')';
      ctx.fillRect(c.col * 40, c.row * 40, 40, 40);
    }
  }

  function render(kind) {
    size();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var url = '/gm/api/heatmap?path=' + encodeURIComponent(L.pathname) +
      '&vw=' + bucket() + '&type=' + kind + '&t=' + encodeURIComponent(token);
    fetch(url, { headers: {} })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (kind === 'mouse') drawMouse(data); else drawClicks(data);
      })
      .catch(function () {});
  }

  function control() {
    var box = D.createElement('div');
    box.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:2147483647;font:13px system-ui,sans-serif;' +
      'background:#111;color:#eee;border:1px solid #333;border-radius:8px;padding:6px;display:flex;gap:6px;';
    var kind = 'click';
    function mk(label, k) {
      var b = D.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'cursor:pointer;border:0;border-radius:6px;padding:5px 10px;font:inherit;' +
        (k === kind ? 'background:#e8451f;color:#fff;' : 'background:#222;color:#ccc;');
      b.onclick = function () {
        kind = k;
        [].forEach.call(box.children, function (c) {
          c.style.background = c === b ? '#e8451f' : '#222';
          c.style.color = c === b ? '#fff' : '#ccc';
        });
        render(kind);
      };
      return b;
    }
    box.appendChild(mk('Clicks', 'click'));
    box.appendChild(mk('Mouse', 'mouse'));
    D.body.appendChild(box);
  }

  D.body.appendChild(canvas);
  control();
  render('click');
  W.addEventListener('resize', function () { render('click'); });
}
