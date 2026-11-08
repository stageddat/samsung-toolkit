// ES70 Toolkit: UI, processing pipeline and export.
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---------------- state ----------------
  const photos = [];                 // {id, file, name, info, date, dateSrc, thumbUrl, hasStamp, selected, w, h}
  let current = null;
  let view = 'fit';
  let comparing = false;
  let cancelled = false;
  let dirHandle = null;

  const S = {
    date: { mode: 'keep', days: 0, hours: 0, minutes: 0, target: null, refId: null },
    stamp: { action: 'keep', format: 'DMY', content: 'datetime', clock: '12', position: 'camera', size: 100 },
    adjust: { ...Adjust.DEFAULTS },
    preset: 'none',
    out: { size: 'orig', rotate: 0, quality: 92, name: 'same' },
  };

  // remember tool settings between visits (best effort only)
  const STORE_KEY = 'es70-toolkit-settings';
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      Object.assign(S.stamp, saved.stamp || {});
      Object.assign(S.out, saved.out || {}, { rotate: 0 });
    }
  } catch (e) { /* storage unavailable */ }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ stamp: S.stamp, out: { ...S.out, rotate: 0 } })); } catch (e) { /* ignore */ }
  }

  // ---------------- date helpers ----------------
  function fmtDate(t, withSec) {
    if (t == null) return '—';
    const d = new Date(t);
    return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` +
      (withSec ? ':' + pad2(d.getUTCSeconds()) : '');
  }
  function toLocalInput(t) {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  }
  function fromLocalInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  }
  function fmtDelta(ms) {
    const sign = ms < 0 ? '−' : '+';
    let s = Math.round(Math.abs(ms) / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return `${sign}${d} d ${h} h ${m} min${s ? ` ${s} s` : ''}`;
  }
  function delta() {
    if (S.date.mode === 'shift') return (((+S.date.days || 0) * 24 + (+S.date.hours || 0)) * 60 + (+S.date.minutes || 0)) * 60000;
    if (S.date.mode === 'set') {
      const ref = photos.find((p) => p.id === S.date.refId);
      if (ref && ref.date != null && S.date.target != null) return S.date.target - ref.date;
    }
    return 0;
  }
  const newDate = (p) => (p.date == null ? null : p.date + delta());

  // ---------------- loading ----------------
  let nextId = 1;
  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg');
    if (!files.length) return;
    const known = new Set(photos.map((p) => p.name + ':' + p.file.size));
    for (const file of files) {
      if (known.has(file.name + ':' + file.size)) continue;
      const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      let info;
      try { info = Exif.read(head); } catch (e) { continue; }   // not a valid JPEG
      const p = { id: nextId++, file, name: file.name, info, selected: false, hasStamp: null,
        date: info.date, dateSrc: info.date != null ? 'exif' : 'file' };
      if (p.date == null) p.date = Exif.naiveFromLocal(file.lastModified);
      const tb = Exif.thumbnailBlob(head, info);
      p.thumbUrl = tb ? URL.createObjectURL(tb) : null;
      photos.push(p);
    }
    photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    renderGrid();
    if (!current && photos.length) setCurrent(photos[0]);
    updateButtons();
    scanQueue();
  }

  // Background work: thumbnails for files without one, and stamp detection.
  let scanning = false;
  async function scanQueue() {
    if (scanning) return;
    scanning = true;
    try {
      for (const p of photos) {
        if (p.hasStamp !== null && p.thumbUrl) continue;
        try {
          const bmp = await createImageBitmap(p.file);
          p.w = bmp.width; p.h = bmp.height;
          if (!p.thumbUrl) {
            const c = document.createElement('canvas');
            const k = 240 / Math.max(bmp.width, bmp.height);
            c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            p.thumbUrl = c.toDataURL('image/jpeg', 0.8);
          }
          if (p.hasStamp === null) {
            const R = Stamp.stampRegion(bmp.width, bmp.height);
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            // only the stamp band is needed; draw just that strip
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bmp, R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0, R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);
            p.hasStamp = Stamp.detect(ctx.getImageData(0, 0, bmp.width, bmp.height));
          }
          bmp.close && bmp.close();
        } catch (e) {
          p.hasStamp = false;
        }
        updateTile(p);
        if (p === current) updateMeta();
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      scanning = false;
    }
  }

  // ---------------- grid ----------------
  function renderGrid() {
    const grid = $('#grid');
    grid.textContent = '';
    for (const p of photos) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.dataset.id = p.id;
      t.innerHTML = `<img alt=""><span class="sel" title="Select"></span><div class="cap"><span class="n"></span><span class="d"></span></div>`;
      t.addEventListener('click', (e) => {
        if (e.target.classList.contains('sel') || e.ctrlKey || e.metaKey) { p.selected = !p.selected; updateTile(p); updateButtons(); }
        else if (e.shiftKey && current) {
          const a = photos.indexOf(current), b = photos.indexOf(p);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { photos[i].selected = true; updateTile(photos[i]); }
          updateButtons();
        } else setCurrent(p);
      });
      grid.appendChild(t);
      updateTile(p);
    }
    $('#dropHint').hidden = photos.length > 0;
  }

  function updateTile(p) {
    const t = document.querySelector(`.tile[data-id="${p.id}"]`);
    if (!t) return;
    const img = t.querySelector('img');
    if (p.thumbUrl && img.getAttribute('src') !== p.thumbUrl) img.src = p.thumbUrl;
    t.classList.toggle('selected', p.selected);
    t.classList.toggle('current', p === current);
    t.querySelector('.n').textContent = p.name.replace(/\.jpe?g$/i, '');
    t.querySelector('.d').textContent = fmtDate(newDate(p)).slice(0, 10);
    let b = t.querySelector('.badge');
    if (p.hasStamp && !b) { b = document.createElement('span'); b.className = 'badge'; b.textContent = 'stamp'; t.appendChild(b); }
    if (!p.hasStamp && b) b.remove();
  }

  function updateButtons() {
    const n = photos.filter((p) => p.selected).length;
    $('#libCount').textContent = photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''}` : 'No photos';
    $('#libSel').textContent = n ? `${n} selected` : '';
    $('#saveSel').textContent = n ? `Save selected (${n})` : 'Save selected';
    $('#saveSel').disabled = !n;
    $('#saveOne').disabled = !current;
    for (const id of ['#selAll', '#selNone', '#clearAll']) $(id).disabled = !photos.length;
  }

  function setCurrent(p) {
    const prev = current;
    current = p;
    if (prev) updateTile(prev);
    if (p) updateTile(p);
    if (S.date.mode === 'set') {
      // keep the offset that was set up, but show the value for the new photo
      $('#setDate').value = toLocalInput(newDate(p));
    }
    bitmapCache = null;
    updateButtons();
    updateMeta();
    schedulePreview();
  }

  // ---------------- pipeline ----------------
  let bitmapCache = null;   // {id, bmp}
  async function bitmapFor(p) {
    if (bitmapCache && bitmapCache.id === p.id) return bitmapCache.bmp;
    const bmp = await createImageBitmap(p.file);
    p.w = bmp.width; p.h = bmp.height;
    if (bitmapCache && bitmapCache.bmp.close) bitmapCache.bmp.close();
    bitmapCache = { id: p.id, bmp };
    return bmp;
  }

  function outputScale(w, h) {
    const L = S.out.size === 'orig' ? Infinity : +S.out.size;
    return Math.min(1, L / Math.max(w, h));
  }

  function needsPixels() {
    return S.stamp.action !== 'keep' || !Adjust.isNeutral(S.adjust) || S.out.rotate !== 0 ||
      (current && S.out.size !== 'orig' && current.w && outputScale(current.w, current.h) < 1);
  }
  function needsPixelsFor(p, bmpW, bmpH) {
    return S.stamp.action !== 'keep' || !Adjust.isNeutral(S.adjust) || S.out.rotate !== 0 ||
      (S.out.size !== 'orig' && outputScale(bmpW, bmpH) < 1);
  }

  // Render photo p with current settings. extraScale < 1 renders a smaller preview.
  // Returns {canvas, removed} where removed tells if a stamp was found and taken out.
  function renderBitmap(p, bmp, extraScale, opts = {}) {
    const k = outputScale(bmp.width, bmp.height) * extraScale;
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    let c = document.createElement('canvas');
    c.width = w; c.height = h;
    let ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    if (opts.original) return { canvas: c, removed: false };

    let removed = false;
    // 1) take out the old stamp (in camera orientation, where its position is known)
    if (S.stamp.action === 'replace' || S.stamp.action === 'remove') {
      const img = ctx.getImageData(0, 0, w, h);
      removed = Stamp.remove(img);
      if (removed) ctx.putImageData(img, 0, 0);
    }
    // 2) rotate
    const rot = ((S.out.rotate % 360) + 360) % 360;
    if (rot) {
      const r = document.createElement('canvas');
      r.width = rot === 180 ? w : h; r.height = rot === 180 ? h : w;
      const rc = r.getContext('2d', { willReadFrequently: true });
      rc.translate(r.width / 2, r.height / 2);
      rc.rotate((rot * Math.PI) / 180);
      rc.drawImage(c, -w / 2, -h / 2);
      c = r; ctx = rc;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // 3) adjustments
    if (!Adjust.isNeutral(S.adjust)) {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      Adjust.apply(img, S.adjust);
      ctx.putImageData(img, 0, 0);
    }
    // 4) new stamp
    const d = newDate(p);
    if ((S.stamp.action === 'add' || (S.stamp.action === 'replace' && removed)) && d != null) {
      Stamp.draw(ctx, c.width, c.height, d, S.stamp);
    }
    return { canvas: c, removed };
  }

  // ---------------- preview ----------------
  let previewTimer = null, previewToken = 0;
  function schedulePreview(delay = 120) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, delay);
  }

  async function drawPreview() {
    const canvas = $('#preview');
    $('#stageEmpty').hidden = !!current;
    canvas.hidden = !current;
    if (!current) return;
    const token = ++previewToken;
    $('#busy').hidden = false;
    try {
      const p = current;
      const bmp = await bitmapFor(p);
      if (token !== previewToken) return;
      const stage = $('#stage').getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      let out;
      if (view === 'stamp') {
        // full resolution, then show the stamp area as large as fits (never above 1:1)
        const full = renderBitmap(p, bmp, 1, { original: comparing }).canvas;
        const W = full.width, H = full.height;
        const R = Stamp.stampRegion(W, H), m = Math.round(60 * R.s);
        let x = R.x0 - m, y = R.y0 - m, cw = R.x1 - R.x0 + 2 * m, ch = R.y1 - R.y0 + 2 * m;
        if (S.stamp.action === 'add' && S.stamp.position !== 'camera') {
          cw = Math.round(W * 0.45); ch = Math.round(H * 0.2);
          x = S.stamp.position.endsWith('r') ? W - cw : 0;
          y = S.stamp.position.startsWith('b') ? H - ch : 0;
        }
        cw = Math.min(W, cw); ch = Math.min(H, ch);
        x = Math.max(0, Math.min(W - cw, x)); y = Math.max(0, Math.min(H - ch, y));
        const k = Math.min(1, ((stage.width - 28) * dpr) / cw, ((stage.height - 28) * dpr) / ch);
        out = document.createElement('canvas');
        out.width = Math.round(cw * k); out.height = Math.round(ch * k);
        const octx = out.getContext('2d');
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(full, x, y, cw, ch, 0, 0, out.width, out.height);
        canvas.style.width = out.width / dpr + 'px';
        canvas.style.height = out.height / dpr + 'px';
      } else {
        const fit = Math.min((stage.width - 28) * dpr / bmp.width, (stage.height - 28) * dpr / bmp.height, 1);
        const k = Math.min(1, fit / outputScale(bmp.width, bmp.height));
        out = renderBitmap(p, bmp, k, { original: comparing }).canvas;
        canvas.style.width = ''; canvas.style.height = '';
      }
      if (token !== previewToken) return;
      canvas.width = out.width; canvas.height = out.height;
      canvas.getContext('2d').drawImage(out, 0, 0);
      updateMeta();
    } catch (e) {
      console.error(e);
    } finally {
      if (token === previewToken) $('#busy').hidden = true;
    }
  }

  function updateMeta() {
    const p = current;
    if (!p) { $('#meta').textContent = ''; return; }
    const d0 = p.date, d1 = newDate(p);
    const src = p.dateSrc === 'exif' ? '' : ' <span title="No EXIF date: using the file date">(file date)</span>';
    let html = `<b>${p.name}</b>${p.w ? ` · ${p.w}×${p.h}` : ''} · ${fmtDate(d0, true)}${src}`;
    if (d1 !== d0) html += ` → <span class="new">${fmtDate(d1, true)}</span>`;
    $('#meta').innerHTML = html;
    // contextual hints
    const st = $('#stHint');
    st.classList.remove('warn');
    if ((S.stamp.action === 'replace' || S.stamp.action === 'remove') && p.hasStamp === false) {
      st.textContent = 'No camera stamp found on this photo, so there is nothing to replace or remove.';
      st.classList.add('warn');
    } else if (S.stamp.action === 'add' && p.hasStamp) {
      st.textContent = 'This photo already has a stamp. Use “Replace existing stamp” to avoid two dates.';
      st.classList.add('warn');
    } else {
      st.textContent = 'Uses the camera’s own digits, taken from real ES70 photos. Removing a stamp rebuilds the background from its surroundings: it looks best on plain areas.';
    }
    const oh = $('#outHint');
    oh.textContent = !needsPixels() && S.date.mode !== 'keep'
      ? 'Only the date changes: photos are saved losslessly (image data untouched).'
      : needsPixels() ? 'Photos are re-encoded as JPEG. EXIF data (with the new date) is kept.' : '';
    if (S.date.mode === 'set') {
      const ref = photos.find((x) => x.id === S.date.refId);
      $('#setHint').textContent = ref ? `Offset ${fmtDelta(delta())} (from ${ref.name}), applied to all selected photos.` : '';
    }
  }

  // ---------------- export ----------------
  function canvasBytes(canvas, q) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a))) : rej(new Error('encode failed'))), 'image/jpeg', q));
  }

  function outName(p) {
    if (S.out.name === 'suffix') return p.name.replace(/(\.[^.]+)$/, '_edit$1');
    return p.name;
  }

  async function processForExport(p) {
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const info = Exif.read(bytes);
    const d = newDate(p);
    const dateChanged = d !== p.date || (info.date == null && S.date.mode !== 'keep');
    const bmp = await createImageBitmap(p.file);
    try {
      if (!needsPixelsFor(p, bmp.width, bmp.height)) {
        return { data: dateChanged ? Exif.rewriteDatesOnly(bytes, info, d) : bytes, date: d, lossless: true };
      }
      const { canvas } = renderBitmap(p, bmp, 1);
      const jpeg = await canvasBytes(canvas, S.out.quality / 100);
      // fresh 160x120-ish EXIF thumbnail so viewers don't show the old picture
      const t = document.createElement('canvas');
      const k = 160 / Math.max(canvas.width, canvas.height);
      t.width = Math.round(canvas.width * k); t.height = Math.round(canvas.height * k);
      t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
      const thumb = await canvasBytes(t, 0.85);
      const data = Exif.transplant(jpeg, bytes, info, {
        date: dateChanged || info.date == null ? d : null, width: canvas.width, height: canvas.height, resetOrientation: true, thumb,
      });
      return { data, date: d, lossless: false };
    } finally {
      bmp.close && bmp.close();
    }
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  function progress(show, text, frac) {
    $('#progress').hidden = !show;
    if (text != null) $('#progText').textContent = text;
    if (frac != null) $('#progBar').style.width = Math.round(frac * 100) + '%';
  }

  const zipDate = (t) => { const d = new Date(t); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()); };

  async function saveOne() {
    if (!current) return;
    progress(true, `Processing ${current.name}…`, 0.3);
    try {
      const r = await processForExport(current);
      download(new Blob([r.data], { type: 'image/jpeg' }), outName(current));
    } catch (e) {
      alert('Could not process this photo: ' + e.message);
    } finally {
      progress(false);
    }
  }

  async function saveSelected() {
    const list = photos.filter((p) => p.selected);
    if (!list.length) return;
    cancelled = false;
    const toDir = $('#useDir').checked && window.showDirectoryPicker;
    if (toDir) {
      try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; }
    }
    const zip = toDir ? null : new JSZip();
    const failed = [];
    let done = 0;
    for (const p of list) {
      if (cancelled) break;
      progress(true, `Processing ${p.name} (${done + 1}/${list.length})…`, done / list.length);
      try {
        const r = await processForExport(p);
        if (toDir) {
          const fh = await dirHandle.getFileHandle(outName(p), { create: true });
          const w = await fh.createWritable();
          await w.write(r.data);
          await w.close();
        } else {
          zip.file(outName(p), r.data, { date: r.date != null ? zipDate(r.date) : new Date(), binary: true });
        }
      } catch (e) {
        failed.push(p.name);
      }
      done++;
    }
    if (!toDir && !cancelled && done) {
      progress(true, 'Packing ZIP…', 1);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      download(blob, `es70-photos-${new Date().toISOString().slice(0, 10)}.zip`);
    }
    progress(false);
    if (failed.length) alert(`These photos could not be processed:\n${failed.join('\n')}`);
  }

  // ---------------- controls ----------------
  function bindControls() {
    // date
    $$('input[name=dateMode]').forEach((r) => r.addEventListener('change', () => {
      S.date.mode = r.value;
      $('#shiftBox').hidden = S.date.mode !== 'shift';
      $('#setBox').hidden = S.date.mode !== 'set';
      if (S.date.mode === 'set' && current) {
        S.date.refId = current.id;
        S.date.target = current.date;
        $('#setDate').value = toLocalInput(current.date);
      }
      changed();
    }));
    for (const [id, key] of [['#shDays', 'days'], ['#shHours', 'hours'], ['#shMin', 'minutes']]) {
      $(id).addEventListener('input', (e) => { S.date[key] = parseInt(e.target.value, 10) || 0; changed(); });
    }
    $('#setDate').addEventListener('input', (e) => {
      const t = fromLocalInput(e.target.value);
      if (t == null || !current) return;
      S.date.refId = current.id;
      S.date.target = t;
      changed();
    });

    // stamp
    const stMap = { '#stAction': 'action', '#stFormat': 'format', '#stContent': 'content', '#stClock': 'clock', '#stPos': 'position' };
    for (const [id, key] of Object.entries(stMap)) {
      $(id).value = S.stamp[key];
      $(id).addEventListener('change', (e) => { S.stamp[key] = e.target.value; syncStampUi(); changed(); });
    }
    $('#stSize').value = S.stamp.size;
    $('#stSize').addEventListener('input', (e) => { S.stamp.size = +e.target.value; syncStampUi(); changed(); });
    syncStampUi();

    // adjustments
    const chips = $('#presets');
    for (const [key, p] of Object.entries(Adjust.PRESETS)) {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = p.label; b.dataset.preset = key;
      b.addEventListener('click', () => applyPreset(key));
      chips.appendChild(b);
    }
    $$('[data-adj]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const k = el.dataset.adj;
      S.adjust[k] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : +el.value;
      S.preset = null;
      syncAdjustUi();
      changed();
    }));
    $('#adjReset').addEventListener('click', () => applyPreset('none'));
    syncAdjustUi();

    // output
    $('#outSize').value = S.out.size;
    $('#outSize').addEventListener('change', (e) => { S.out.size = e.target.value; changed(); });
    $('#outQ').value = S.out.quality; $('#qOut').textContent = S.out.quality;
    $('#outQ').addEventListener('input', (e) => { S.out.quality = +e.target.value; $('#qOut').textContent = S.out.quality; persist(); });
    $('#outName').value = S.out.name;
    $('#outName').addEventListener('change', (e) => { S.out.name = e.target.value; persist(); });
    $('#rotL').addEventListener('click', () => { S.out.rotate = (S.out.rotate + 270) % 360; $('#rotOut').textContent = S.out.rotate + '°'; changed(); });
    $('#rotR').addEventListener('click', () => { S.out.rotate = (S.out.rotate + 90) % 360; $('#rotOut').textContent = S.out.rotate + '°'; changed(); });
    if (window.showDirectoryPicker) $('#dirWrap').hidden = false;

    // library
    $('#pickFiles').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('#pickFolder').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('#selAll').addEventListener('click', () => { photos.forEach((p) => { p.selected = true; updateTile(p); }); updateButtons(); });
    $('#selNone').addEventListener('click', () => { photos.forEach((p) => { p.selected = false; updateTile(p); }); updateButtons(); });
    $('#clearAll').addEventListener('click', () => {
      photos.forEach((p) => p.thumbUrl && p.thumbUrl.startsWith('blob:') && URL.revokeObjectURL(p.thumbUrl));
      photos.length = 0; current = null; bitmapCache = null;
      renderGrid(); updateButtons(); updateMeta(); drawPreview();
    });

    // drag & drop (files and folders)
    document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      const items = Array.from(e.dataTransfer.items || []);
      const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) addFiles(await filesFromEntries(entries));
      else addFiles(e.dataTransfer.files);
    });

    // viewer
    $$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      view = b.dataset.view;
      $$('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      $('#preview').classList.toggle('pixel', view === 'stamp');
      schedulePreview(0);
    }));
    const cmp = $('#compare');
    const startCmp = () => { if (!comparing) { comparing = true; schedulePreview(0); } };
    const endCmp = () => { if (comparing) { comparing = false; schedulePreview(0); } };
    cmp.addEventListener('pointerdown', startCmp);
    cmp.addEventListener('pointerup', endCmp);
    cmp.addEventListener('pointerleave', endCmp);
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === 'c' || e.key === 'C') startCmp();
      if (!current) return;
      const i = photos.indexOf(current);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); if (photos[i + 1]) setCurrent(photos[i + 1]); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); if (photos[i - 1]) setCurrent(photos[i - 1]); }
      if (e.key === ' ') { e.preventDefault(); current.selected = !current.selected; updateTile(current); updateButtons(); }
    });
    document.addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') endCmp(); });
    window.addEventListener('resize', () => schedulePreview(200));

    // export
    $('#saveOne').addEventListener('click', saveOne);
    $('#saveSel').addEventListener('click', saveSelected);
    $('#progCancel').addEventListener('click', () => { cancelled = true; $('#progText').textContent = 'Cancelling…'; });
  }

  async function filesFromEntries(entries) {
    const out = [];
    async function walk(entry) {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  function syncStampUi() {
    const a = S.stamp.action;
    const drawing = a === 'add' || a === 'replace';
    $('#stOpts').hidden = !drawing;
    $('#stClock').disabled = S.stamp.content === 'date';
    $('#stPos').disabled = a === 'replace';
    if (a === 'replace') $('#stPos').value = 'camera';
    else $('#stPos').value = S.stamp.position;
    $('#stSizeOut').textContent = S.stamp.size + '%';
  }
  // 'replace' always redraws where the camera had it
  const origDraw = Stamp.draw;
  Stamp.draw = (ctx, W, H, t, o) => origDraw(ctx, W, H, t, S.stamp.action === 'replace' ? { ...o, position: 'camera', size: 100 } : o);

  function applyPreset(key) {
    S.preset = key;
    S.adjust = { ...Adjust.DEFAULTS, ...Adjust.PRESETS[key] };
    delete S.adjust.label;
    syncAdjustUi();
    changed();
  }

  function syncAdjustUi() {
    $$('[data-adj]').forEach((el) => {
      const v = S.adjust[el.dataset.adj];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    const fmt = { exposure: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' EV', gamma: (v) => v.toFixed(2), saturation: (v) => Math.round(v * 100) + '%',
      denoise: (v) => ['Off', 'Low', 'Medium', 'High'][v] };
    $$('output[data-for]').forEach((o) => {
      const k = o.dataset.for, v = S.adjust[k];
      o.textContent = fmt[k] ? fmt[k](v) : (v > 0 ? '+' : '') + v;
    });
    $$('.chip').forEach((c) => c.classList.toggle('on', c.dataset.preset === S.preset));
  }

  function changed() {
    persist();
    photos.forEach(updateTile);
    updateMeta();
    schedulePreview();
  }

  bindControls();
  updateButtons();
  drawPreview();

  // exposed for automated tests
  window.__es70 = { photos, S, addFiles, processForExport, setCurrent, applyPreset, renderBitmap, bitmapFor, changed };
})();
