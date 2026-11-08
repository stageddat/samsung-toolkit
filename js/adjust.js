// Image adjustments on ImageData: tone curve (LUT), colour, noise reduction.
(function () {
  'use strict';

  const PRESETS = {
    none:    { label: 'None' },
    night:   { label: 'Dark party rescue', curve: 'night', saturation: 1.2, denoise: 2 },
    auto:    { label: 'Auto levels', autoLevels: true },
    vintage: { label: 'Vintage', fade: 28, warmth: 14, saturation: 0.85, contrast: -8 },
    punchy:  { label: 'Punchy', contrast: 18, saturation: 1.25 },
    bw:      { label: 'Black & white', saturation: 0, contrast: 12 },
  };

  const DEFAULTS = { exposure: 0, brightness: 0, contrast: 0, gamma: 1, curve: 'none', autoLevels: false,
    saturation: 1, warmth: 0, fade: 0, denoise: 0 };

  // control points (0..1) of named curves; 'night' is the curve used to rescue very dark party shots
  const CURVES = { none: null, night: [[0, 0], [0.06, 0.3], [0.2, 0.6], [1, 1]], lift: [[0, 0], [0.25, 0.4], [1, 1]] };

  // monotone cubic interpolation (no overshoot)
  function curveFn(pts) {
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (x) => {
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  function levels(data) {
    const hist = new Uint32Array(256);
    const step = Math.max(1, Math.floor(data.length / 4 / 400000)) * 4;
    let n = 0;
    for (let p = 0; p < data.length; p += step) { hist[(data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8]++; n++; }
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < n * 0.005) hi--;
    if (hi - lo < 10) return [0, 255];
    return [lo, hi];
  }

  function buildLut(o, data) {
    const lut = new Uint8ClampedArray(256);
    const curve = CURVES[o.curve] ? curveFn(CURVES[o.curve]) : null;
    const [lo, hi] = o.autoLevels ? levels(data) : [0, 255];
    const ev = Math.pow(2, o.exposure), c = (100 + o.contrast) / 100, cf = c * c;
    for (let v = 0; v < 256; v++) {
      let x = (v - lo) / (hi - lo);
      x = Math.min(1, Math.max(0, x));
      if (curve) x = curve(x);
      x = x * ev;
      x = Math.pow(Math.max(0, x), 1 / o.gamma);
      x = (x - 0.5) * cf + 0.5;
      x += o.brightness / 255;
      x = o.fade / 255 + x * (1 - o.fade / 255);
      lut[v] = Math.round(x * 255);
    }
    return lut;
  }

  // Edge-preserving smoothing (cheap bilateral-style). strength 1..3
  function denoise(img, strength) {
    const { width: W, height: H, data } = img;
    const src = new Uint8ClampedArray(data);
    const r = strength >= 3 ? 2 : 1;
    const sig = [0, 14, 22, 30][Math.min(3, strength)];
    const inv = 1 / (2 * sig * sig);
    const wt = new Float32Array(766);
    for (let d = 0; d < 766; d++) wt[d] = Math.exp(-(d * d) * inv / 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        const r0 = src[p], g0 = src[p + 1], b0 = src[p + 2];
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
            const q = (yy * W + xx) * 4;
            const d = Math.abs(src[q] - r0) + Math.abs(src[q + 1] - g0) + Math.abs(src[q + 2] - b0);
            const w = wt[d];
            sr += src[q] * w; sg += src[q + 1] * w; sb += src[q + 2] * w; sw += w;
          }
        }
        data[p] = sr / sw; data[p + 1] = sg / sw; data[p + 2] = sb / sw;
      }
    }
  }

  function isNeutral(o) {
    return o.exposure === 0 && o.brightness === 0 && o.contrast === 0 && o.gamma === 1 && o.curve === 'none' &&
      !o.autoLevels && o.saturation === 1 && o.warmth === 0 && o.fade === 0 && !o.denoise;
  }

  function apply(img, o) {
    if (isNeutral(o)) return;
    if (o.denoise) denoise(img, o.denoise);
    const data = img.data, lut = buildLut(o, data);
    const sat = o.saturation, warm = o.warmth;
    for (let p = 0; p < data.length; p += 4) {
      let r = lut[data[p]], g = lut[data[p + 1]], b = lut[data[p + 2]];
      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      if (warm) { r += warm; b -= warm; }
      data[p] = r; data[p + 1] = g; data[p + 2] = b;
    }
  }

  window.Adjust = { PRESETS, DEFAULTS, apply, isNeutral };
})();
