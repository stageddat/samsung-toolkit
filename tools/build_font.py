# Build the Samsung ES70 date-stamp font (as rendered on 4000x3000 photos) from original stamped photos.
# Output: JSON with per-glyph advance + bit-packed core/outline masks, for the web app.
import cv2, numpy as np, subprocess, sys, os, json, base64
BK, OUT = sys.argv[1:3]
Y0, Y1 = 2660, 2768
PAD = 8
ADV = {**{d: 68 for d in "0123456789"}, "/": 50, ":": 37, " ": 37, "A": 81, "P": 62, "M": 80}


def exif(p):
    v = subprocess.run(["exiv2", "-g", "Exif.Photo.DateTimeOriginal", "-Pv", p], capture_output=True, text=True).stdout.strip()
    Y, M, D, h, m = v[0:4], v[5:7], v[8:10], int(v[11:13]), v[14:16]
    ap = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return Y, M, D, "%02d" % h12, m, ap


def layout(f):
    return "YMD" if int(f[4:8]) <= 1101 else "DMY"


def masks(img):
    roi = img[Y0:Y1].astype(int)
    b, g, r = roi[..., 0], roi[..., 1], roi[..., 2]
    core = (r > 170) & (g > 170) & (b < 150)
    near = cv2.dilate(core.astype(np.uint8), np.ones((15, 15))) > 0
    return core, near & ~core & (b < 70) & (r < 150) & (g < 150)


def runs_from(core, x0):
    cols = core.any(0)
    out, s = [], None
    for x, v in enumerate(list(cols) + [False]):
        if v and s is None:
            s = x
        if not v and s is not None:
            if x - s > 3 and s >= x0:
                out.append(s)
            s = None
    return out


acc = {}
used = 0
for f in sorted(x for x in os.listdir(BK) if x.endswith(".JPG")):
    p = os.path.join(BK, f)
    img = cv2.imread(p, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    core, outl = masks(img)
    Y, M, D, hh, mm, ap = exif(p)
    date = D + "/" + M + "/" + Y if layout(f) == "DMY" else Y + "/" + M + "/" + D
    text = date + " " + hh + ":" + mm + " " + ap
    # only photos whose time part sits at the standard position (':' run starts at 3471)
    std_time = 3471 in runs_from(core, 3460)[:1]
    x = 2648
    for i, ch in enumerate(text):
        in_time = i >= 11
        if ch != " " and (not in_time or std_time):
            a = acc.setdefault(ch, [0., 0., 0])
            a[0] = a[0] + core[:, x - PAD:x + ADV[ch] + PAD]
            a[1] = a[1] + outl[:, x - PAD:x + ADV[ch] + PAD]
            a[2] += 1
        x += ADV[ch]
    used += 1

font = {"ref_width": 4000, "origin": [2648, Y0], "height": Y1 - Y0, "pad": PAD,
        "colors": {"fill": [255, 255, 83], "outline": [82, 84, 0]}, "glyphs": {}}
for ch, (c_, o_, n) in sorted(acc.items()):
    c = (c_ / n > .5).astype(np.uint8)
    k, lbl, st, cen = cv2.connectedComponentsWithStats(c, connectivity=8)
    big = st[1:, cv2.CC_STAT_AREA].max()
    keep = [i for i in range(1, k) if st[i, cv2.CC_STAT_AREA] > .3 * big and PAD <= cen[i][0] <= PAD + ADV[ch] - 4]
    c = np.isin(lbl, keep).astype(np.uint8)
    o = ((o_ / n > .5) & (cv2.dilate(c, np.ones((11, 11))) > 0)).astype(np.uint8)
    o = np.maximum(o, cv2.dilate(c, np.ones((7, 7))) - c)
    h, w = c.shape
    font["glyphs"][ch] = {"adv": ADV[ch], "w": int(w), "n": int(n),
                          "core": base64.b64encode(np.packbits(c.ravel())).decode(),
                          "outline": base64.b64encode(np.packbits(o.ravel())).decode()}
    cv2.imwrite(os.path.join(os.path.dirname(OUT), "glyph_%s.png" % {"/": "slash", ":": "colon"}.get(ch, ch)),
                (c * 255 + o * 100).astype(np.uint8))
font["glyphs"][" "] = {"adv": ADV[" "], "w": 0, "n": 0, "core": "", "outline": ""}
json.dump(font, open(OUT, "w"))
print("photos", used, {k: v["n"] for k, v in font["glyphs"].items()})
