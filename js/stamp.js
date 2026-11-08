// Samsung-style date stamp: draw, detect and remove.
// All geometry is defined on the camera's 4000x3000 frame and scaled to the actual image.
(function () {
  'use strict';

  const F = window.STAMP_FONT;
  const REF_W = F.ref_width;                 // 4000
  const [ORIGIN_X, ORIGIN_Y] = F.origin;     // pen start of the first glyph, top of glyph window
  const GH = F.height;                       // glyph window height (108)
  const PAD = F.pad;                         // glyph window starts PAD px left of the pen
  const BOTTOM_GAP = 3000 - ORIGIN_Y;        // distance from glyph window top to image bottom
  const INK_TOP = 7, INK_BOTTOM = 100;       // visible rows inside the glyph window

  // ---------- glyph bitmaps ----------
  const glyphCanvas = {};
  function unpack(b64, n) {
    const raw = atob(b64), out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
    return out;
  }
  function glyph(ch) {
    if (glyphCanvas[ch] !== undefined) return glyphCanvas[ch];
    const g = F.glyphs[ch];
    if (!g || !g.w) return (glyphCanvas[ch] = null);
    const n = g.w * GH, core = unpack(g.core, n), outl = unpack(g.outline, n);
    const c = document.createElement('canvas');
    c.width = g.w; c.height = GH;
    const ctx = c.getContext('2d'), img = ctx.createImageData(g.w, GH);
    const [fr, fg, fb] = F.colors.fill, [or, og, ob] = F.colors.outline;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (core[i]) { img.data[p] = fr; img.data[p + 1] = fg; img.data[p + 2] = fb; img.data[p + 3] = 255; }
      else if (outl[i]) { img.data[p] = or; img.data[p + 1] = og; img.data[p + 2] = ob; img.data[p + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
    return (glyphCanvas[ch] = c);
  }

  // ---------- text ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  function stampText(t, o) {
    const d = new Date(t);
    const Y = String(d.getUTCFullYear()), M = pad2(d.getUTCMonth() + 1), D = pad2(d.getUTCDate());
    const date = o.format === 'YMD' ? `${Y}/${M}/${D}` : o.format === 'MDY' ? `${M}/${D}/${Y}` : `${D}/${M}/${Y}`;
    if (o.content === 'date') return date;
    const h = d.getUTCHours(), mi = pad2(d.getUTCMinutes());
    if (o.clock === '24') return `${date} ${pad2(h)}:${mi}`;
    return `${date} ${pad2(h % 12 || 12)}:${mi} ${h < 12 ? 'AM' : 'PM'}`;
  }

  function textAdvance(text) {
    let w = 0;
    for (const ch of text) w += (F.glyphs[ch] || F.glyphs[' ']).adv;
    return w;
  }

  // Render the text at reference scale (1 unit = 1 px on a 4000-wide photo).
  function textCanvas(text) {
    const adv = textAdvance(text);
    const c = document.createElement('canvas');
    c.width = adv + PAD * 2 + 16; c.height = GH;
    const ctx = c.getContext('2d');
    let x = 0;
    for (const ch of text) {
      const g = glyph(ch);
      if (g) ctx.drawImage(g, x, 0);
      x += (F.glyphs[ch] || F.glyphs[' ']).adv;
    }
    return { canvas: c, adv };
  }

  // Where the glyph window's top-left goes, in image pixels.
  function placement(W, H, adv, o) {
    const s = (Math.max(W, H) / REF_W) * (o.size / 100);
    const inkW = adv * s, m = Math.round(Math.min(W, H) * 0.05);
    let x, y;   // pen start & window top
    switch (o.position) {
      case 'br': x = W - m - inkW; y = H - m - INK_BOTTOM * s; break;
      case 'bl': x = m; y = H - m - INK_BOTTOM * s; break;
      case 'tr': x = W - m - inkW; y = m - INK_TOP * s; break;
      case 'tl': x = m; y = m - INK_TOP * s; break;
      default:   // exactly where this camera puts it
        x = ORIGIN_X * s; y = H - BOTTOM_GAP * s;
    }
    return { s, x, y };
  }

  function draw(ctx, W, H, t, o) {
    const text = stampText(t, o);
    const { canvas, adv } = textCanvas(text);
    const { s, x, y } = placement(W, H, adv, o);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // a touch of softness, like the camera's JPEG encoder gives the real stamp
    if (s >= 0.5 && 'filter' in ctx) ctx.filter = `blur(${(0.9 * s).toFixed(2)}px)`;
    ctx.drawImage(canvas, x - PAD * s, y, canvas.width * s, GH * s);
    ctx.restore();
    return text;
  }

  // ---------- detection / removal (camera position only) ----------
  function stampRegion(W, H) {
    const s = Math.max(W, H) / REF_W;
    const x0 = Math.max(0, Math.floor((ORIGIN_X - 20) * s)), x1 = Math.min(W, Math.ceil(3880 * s));
    const y0 = Math.max(0, Math.floor((H - BOTTOM_GAP * s) - 4 * s)), y1 = Math.min(H, Math.ceil(H - BOTTOM_GAP * s + (GH + 4) * s));
    return { s, x0, x1, y0, y1 };
  }

  // Returns a hole mask over the region (1 = stamp pixel to replace) or null if no stamp is there.
  function findStamp(data, W, H) {
    const R = stampRegion(W, H), rw = R.x1 - R.x0, rh = R.y1 - R.y0;
    if (rw <= 0 || rh <= 0) return null;
    const core = new Uint8Array(rw * rh), dark = new Uint8Array(rw * rh);
    let n = 0, minX = rw, maxX = -1;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const p = ((R.y0 + y) * W + R.x0 + x) * 4, r = data[p], g = data[p + 1], b = data[p + 2];
      const i = y * rw + x;
      if (r > 170 && g > 170 && b < 150) { core[i] = 1; n++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
      else if (b < 90 && r < 170 && g < 170) dark[i] = 1;
    }
    // a real stamp has lots of yellow ink spread over most of the stamp width
    if (n < 2500 * R.s * R.s || maxX - minX < 600 * R.s) return null;
    const rad = Math.max(2, Math.round(8 * R.s));
    const near = dilate(core, rw, rh, rad);
    const hole = new Uint8Array(rw * rh);
    let rim = 0;
    for (let i = 0; i < hole.length; i++) {
      const o = near[i] && dark[i] && !core[i];
      if (o) rim++;
      hole[i] = core[i] || o ? 1 : 0;
    }
    // the stamp's yellow is always wrapped in a dark outline; yellow objects in the scene are not
    if (rim < 0.4 * n) return null;
    const grown = dilate(hole, rw, rh, Math.max(1, Math.round(4 * R.s)));
    // plus the full band behind the text, so no ink fragments survive
    const by0 = Math.max(0, Math.round(3 * R.s)), by1 = Math.min(rh, Math.round((GH - 3) * R.s + 8 * R.s));
    const bx0 = Math.max(0, minX - Math.round(10 * R.s)), bx1 = Math.min(rw, maxX + Math.round(10 * R.s));
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) grown[y * rw + x] = 1;
    return { R, rw, rh, mask: grown };
  }

  function dilate(m, w, h, r) {
    // separable square dilation
    const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) {
      let run = -1e9;
      for (let x = 0; x < w; x++) { if (m[y * w + x]) run = x; if (x - run <= r) tmp[y * w + x] = 1; }
      run = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      let run = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (y - run <= r) out[y * w + x] = 1; }
      run = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }

  // Fill masked pixels from the surrounding background, outside-in (a simplified Telea inpaint).
  function inpaint(data, W, H, found) {
    const { R, rw, mask } = found, rh = found.rh;
    const M = 6;   // margin of real pixels around the region
    const ox = Math.max(0, R.x0 - M), oy = Math.max(0, R.y0 - M);
    const bw = Math.min(W, R.x1 + M) - ox, bh = Math.min(H, R.y1 + M) - oy;
    const hole = new Uint8Array(bw * bh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      if (mask[y * rw + x]) hole[(y + R.y0 - oy) * bw + (x + R.x0 - ox)] = 1;
    }
    // BFS order from the known border inwards
    const order = [], dist = new Int32Array(bw * bh).fill(-1);
    let q = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (!hole[i]) continue;
      for (let dy = -1; dy <= 1 && dist[i] < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && !hole[yy * bw + xx]) { dist[i] = 1; q.push(i); break; }
      }
    }
    while (q.length) {
      const next = [];
      for (const i of q) {
        order.push(i);
        const x = i % bw, y = (i / bw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const j = yy * bw + xx;
          if (hole[j] && dist[j] < 0) { dist[j] = dist[i] + 1; next.push(j); }
        }
      }
      q = next;
    }
    const known = new Uint8Array(bw * bh);
    for (let i = 0; i < known.length; i++) known[i] = hole[i] ? 0 : 1;
    const r = 4;
    for (const i of order) {
      const x = i % bw, y = (i / bw) | 0;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const j = yy * bw + xx;
        if (!known[j]) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        // prefer pixels that were filled earlier (closer to real background)
        const w = 1 / (d2 * (1 + (hole[j] ? dist[j] : 0) * 0.15));
        const p = ((yy + oy) * W + xx + ox) * 4;
        sr += data[p] * w; sg += data[p + 1] * w; sb += data[p + 2] * w; sw += w;
      }
      const p = ((y + oy) * W + x + ox) * 4;
      if (sw) { data[p] = sr / sw; data[p + 1] = sg / sw; data[p + 2] = sb / sw; }
      known[i] = 1;
    }
    // two light smoothing passes inside the hole to hide streaks
    for (let pass = 0; pass < 2; pass++) {
      for (const i of order) {
        const x = i % bw, y = (i / bw) | 0;
        if (x < 1 || y < 1 || x >= bw - 1 || y >= bh - 1) continue;
        const p = ((y + oy) * W + x + ox) * 4;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += data[p + (dy * W + dx) * 4 + c];
          data[p + c] = s / 9;
        }
      }
    }
  }

  // Remove the camera stamp from an ImageData in place. Returns true if one was found.
  function remove(img) {
    const found = findStamp(img.data, img.width, img.height);
    if (!found) return false;
    inpaint(img.data, img.width, img.height, found);
    return true;
  }

  function detect(img) { return !!findStamp(img.data, img.width, img.height); }

  window.Stamp = { draw, remove, detect, stampText, stampRegion };
})();
