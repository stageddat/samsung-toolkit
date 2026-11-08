// Minimal JPEG/EXIF reader-writer.
// Edits are done in place on the original APP1 segment, so camera-specific data
// (Samsung MakerNote etc.) survives untouched.
(function () {
  'use strict';

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const DATE_TAGS = { 0x0132: 'DateTime', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized' };

  // ---- naive date helpers: dates are wall-clock times stored as UTC so no DST/timezone shifts ----
  function parseExifDate(s) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(t) ? null : t;
  }
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function formatExifDate(t) {
    const d = new Date(t);
    return `${pad(d.getUTCFullYear(), 4)}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  function naiveFromLocal(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }

  // ---- JPEG segments ----
  function segments(bytes) {
    const out = [];
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('Not a JPEG file');
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xFF) {
      const marker = bytes[i + 1];
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
      if (marker === 0xFF) { i += 1; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      out.push({ marker, start: i, end: i + 2 + len });
      if (marker === 0xDA) break;   // start of scan: rest is image data
      i += 2 + len;
    }
    return out;
  }

  function isExifSeg(bytes, s) {
    return s.marker === 0xE1 && bytes[s.start + 4] === 0x45 && bytes[s.start + 5] === 0x78 &&
      bytes[s.start + 6] === 0x69 && bytes[s.start + 7] === 0x66 && bytes[s.start + 8] === 0 && bytes[s.start + 9] === 0;
  }

  // ---- TIFF/IFD reader ----
  function makeReader(bytes, t, tiffLen) {
    const le = bytes[t] === 0x49;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + t, tiffLen);
    return {
      le,
      u16: (o) => dv.getUint16(o, le),
      u32: (o) => dv.getUint32(o, le),
      set16: (o, v) => dv.setUint16(o, v, le),
      set32: (o, v) => dv.setUint32(o, v, le),
      ok: (o, n) => o >= 0 && o + n <= tiffLen,
    };
  }

  function readIfd(r, bytes, t, off, tiffLen) {
    const entries = {};
    if (!r.ok(off, 2)) return { entries, next: 0 };
    const n = r.u16(off);
    if (n > 1000 || !r.ok(off + 2, n * 12 + 4)) return { entries, next: 0 };
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const valOff = size <= 4 ? e + 8 : r.u32(e + 8);
      entries[tag] = { tag, type, count, entry: e, valOff, size };
    }
    return { entries, next: r.u32(off + 2 + n * 12) };
  }

  function readAscii(bytes, t, ent) {
    let s = '';
    for (let k = 0; k < ent.count; k++) {
      const c = bytes[t + ent.valOff + k];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  function readInt(r, ent) {
    if (ent.type === 3) return r.u16(ent.valOff);
    if (ent.type === 4) return r.u32(ent.valOff);
    return null;
  }

  // Parse everything we care about. Offsets are relative to the TIFF header.
  function read(bytes) {
    const info = { hasExif: false, dates: {}, date: null, model: '', orientation: 1, thumb: null, fields: {} };
    const segs = segments(bytes);
    info.segments = segs;
    const app1 = segs.find((s) => isExifSeg(bytes, s));
    if (!app1) return info;
    const t = app1.start + 10, tiffLen = app1.end - t;
    if (tiffLen < 8) return info;
    const r = makeReader(bytes, t, tiffLen);
    info.hasExif = true;
    info.app1 = app1;
    const ifd0 = readIfd(r, bytes, t, r.u32(4), tiffLen);
    const all = [ifd0.entries];
    if (ifd0.entries[0x8769]) all.push(readIfd(r, bytes, t, r.u32(ifd0.entries[0x8769].valOff), tiffLen).entries);
    for (const ents of all) {
      for (const tag in DATE_TAGS) {
        const e = ents[tag];
        if (e && e.type === 2 && e.count >= 19 && r.ok(e.valOff, 19)) {
          info.dates[DATE_TAGS[tag]] = { off: e.valOff, value: readAscii(bytes, t, e) };
        }
      }
      for (const tag of [0x0112, 0xA002, 0xA003, 0x0100, 0x0101]) {
        if (ents[tag] && (ents[tag].type === 3 || ents[tag].type === 4)) info.fields[tag] = ents[tag];
      }
      if (ents[0x0110] && ents[0x0110].type === 2) info.model = readAscii(bytes, t, ents[0x0110]);
    }
    if (info.fields[0x0112]) info.orientation = readInt(r, info.fields[0x0112]) || 1;
    const d = info.dates.DateTimeOriginal || info.dates.DateTimeDigitized || info.dates.DateTime;
    info.date = d ? parseExifDate(d.value) : null;
    // IFD1 = thumbnail
    if (ifd0.next) {
      const ifd1 = readIfd(r, bytes, t, ifd0.next, tiffLen).entries;
      const o = ifd1[0x0201], l = ifd1[0x0202];
      if (o && l) {
        const off = r.u32(o.valOff), len = r.u32(l.valOff);
        if (r.ok(off, len)) info.thumb = { off, len, lenEntry: l.valOff };
      }
    }
    return info;
  }

  function thumbnailBlob(bytes, info) {
    if (!info.thumb) return null;
    const t = info.app1.start + 10;
    return new Blob([bytes.subarray(t + info.thumb.off, t + info.thumb.off + info.thumb.len)], { type: 'image/jpeg' });
  }

  // Build a fresh APP1 (with only date tags) for files that had no EXIF at all.
  function minimalApp1(dateStr) {
    const enc = new TextEncoder();
    const ascii = enc.encode(dateStr + '\0');            // 20 bytes
    // layout (little endian): header(8) IFD0(2+2*12+4=30) -> 38: ExifIFD(2+2*12+4=30) -> 68: 3 date strings
    const ifd0 = 8, exif = 38, data = 68;
    const tiff = new Uint8Array(data + 20 * 3);
    const dv = new DataView(tiff.buffer);
    tiff.set([0x49, 0x49, 0x2A, 0x00]); dv.setUint32(4, ifd0, true);
    const entry = (at, tag, type, count, val) => {
      dv.setUint16(at, tag, true); dv.setUint16(at + 2, type, true);
      dv.setUint32(at + 4, count, true); dv.setUint32(at + 8, val, true);
    };
    dv.setUint16(ifd0, 2, true);
    entry(ifd0 + 2, 0x0132, 2, 20, data);
    entry(ifd0 + 14, 0x8769, 4, 1, exif);
    dv.setUint32(ifd0 + 26, 0, true);
    dv.setUint16(exif, 2, true);
    entry(exif + 2, 0x9003, 2, 20, data + 20);
    entry(exif + 14, 0x9004, 2, 20, data + 40);
    dv.setUint32(exif + 26, 0, true);
    tiff.set(ascii, data); tiff.set(ascii, data + 20); tiff.set(ascii, data + 40);
    return wrapApp1(tiff);
  }

  function wrapApp1(tiff) {
    const len = 2 + 6 + tiff.length;
    if (len > 0xFFFF) throw new Error('EXIF block too large');
    const seg = new Uint8Array(2 + len);
    seg.set([0xFF, 0xE1, len >> 8, len & 0xFF, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    seg.set(tiff, 10);
    return seg;
  }

  // Return a patched copy of the original TIFF block.
  // opts: { date (naive ms), width, height, resetOrientation, thumb (Uint8Array jpeg) }
  function patchedTiff(bytes, info, opts) {
    const t = info.app1.start + 10;
    let tiff = bytes.slice(t, info.app1.end);
    let r = makeReader(tiff, 0, tiff.length);
    if (opts.date != null) {
      const s = new TextEncoder().encode(formatExifDate(opts.date));
      for (const k in info.dates) tiff.set(s, info.dates[k].off);
    }
    const setInt = (ent, v) => {
      if (!ent) return;
      if (ent.type === 3 && v <= 0xFFFF) r.set16(ent.valOff, v);
      else if (ent.type === 4) r.set32(ent.valOff, v);
    };
    if (opts.resetOrientation) setInt(info.fields[0x0112], 1);
    if (opts.width) { setInt(info.fields[0xA002], opts.width); setInt(info.fields[0x0100], opts.width); }
    if (opts.height) { setInt(info.fields[0xA003], opts.height); setInt(info.fields[0x0101], opts.height); }
    // Replace the embedded thumbnail when it is the last thing in the block (true for this camera).
    if (opts.thumb && info.thumb && info.thumb.off + info.thumb.len >= tiff.length - 64) {
      const nt = new Uint8Array(info.thumb.off + opts.thumb.length);
      nt.set(tiff.subarray(0, info.thumb.off));
      nt.set(opts.thumb, info.thumb.off);
      if (nt.length + 8 <= 0xFFFF) {
        tiff = nt; r = makeReader(tiff, 0, tiff.length);
        r.set32(info.thumb.lenEntry, opts.thumb.length);
      }
    }
    return tiff;
  }

  function concat(parts) {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Lossless: only the metadata changes, the image data is copied byte for byte.
  function rewriteDatesOnly(bytes, info, date) {
    if (!info.hasExif) {
      return concat([bytes.subarray(0, 2), minimalApp1(formatExifDate(date)), bytes.subarray(2)]);
    }
    const out = bytes.slice();
    const t = info.app1.start + 10;
    const s = new TextEncoder().encode(formatExifDate(date));
    for (const k in info.dates) out.set(s, t + info.dates[k].off);
    return out;
  }

  // Put the original (patched) metadata into a freshly encoded JPEG from a canvas.
  // The new JPEG's own APP0/APP1 are dropped; MPF previews of the old picture are not carried over.
  function transplant(newJpeg, origBytes, info, opts) {
    const segs = segments(newJpeg);
    const firstKeep = segs.find((s) => !(s.marker === 0xE0 || s.marker === 0xE1));
    const body = newJpeg.subarray(firstKeep ? firstKeep.start : 2);
    let app1;
    if (info.hasExif) app1 = wrapApp1(patchedTiff(origBytes, info, opts));
    else if (opts.date != null) app1 = minimalApp1(formatExifDate(opts.date));
    else app1 = new Uint8Array(0);
    return concat([new Uint8Array([0xFF, 0xD8]), app1, body]);
  }

  window.Exif = { read, thumbnailBlob, rewriteDatesOnly, transplant, parseExifDate, formatExifDate, naiveFromLocal };
})();
