"""Fit a film-stock LUT from an original iPhone clip and the same clip rendered through Dehancer
(grain/halation/bloom/vignette/border OFF). The render may be a trimmed section of the original.

usage: python3 fit_stock.py ORIGINAL RENDER OUT.cube "Name" [--vignette]
"""
import sys, subprocess, json, numpy as np, cv2
sys.path.insert(0, __file__.rsplit('/', 1)[0]); import lutlib as L

def probe(p):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', p], capture_output=True, check=True).stdout)['streams'][0]
    return int(j['width']), int(j['height'])
def decode(p, w, h, fmt='gray', sel=None):
    vf = (f"select='{sel}'," if sel else '') + f"scale=w={w}:h={h}:flags=area:in_color_matrix=bt709:in_range=tv:out_range=full,format={fmt}"
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-vf', vf, '-vsync', '0', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    if fmt == 'gray': return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32) / 255
    return np.frombuffer(raw, '<u2').reshape(-1, h, w, 3).astype(np.float32) / 65535
def edges(g): g = cv2.GaussianBlur(g, (0, 0), 1); e = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)); e -= e.mean(); return e / (np.linalg.norm(e) + 1e-9)

def main():
    orig, rend, out, name = sys.argv[1:5]; vig = '--vignette' in sys.argv
    # 1. time alignment on small greyscale frames
    so, sr = decode(orig, 192, 108), decode(rend, 192, 108)
    eo, er = np.stack([edges(f) for f in so]), np.stack([edges(f) for f in sr])
    best = max(range(-5, len(eo) - len(er) // 2), key=lambda off: np.mean([(eo[i + off] * er[i]).sum() for i in range(0, len(er), 5) if 0 <= i + off < len(eo)]))
    print('render starts at original frame', best)
    N = 30; ridx = np.linspace(3, len(er) - 4, N).round().astype(int); pairs = []
    for i in ridx:  # local ±2 frame refinement (renders sometimes drop frames)
        j = max(range(i + best - 2, i + best + 3), key=lambda j: (eo[j] * er[i]).sum() if 0 <= j < len(eo) else -1); pairs.append((int(j), int(i)))
    W, H = 1920, 1080
    uj = sorted({j for j, _ in pairs}); ui = sorted({i for _, i in pairs})
    Ou = decode(orig, W, H, 'rgb48le', '+'.join(f'eq(n\\,{j})' for j in uj)); Ru = decode(rend, W, H, 'rgb48le', '+'.join(f'eq(n\\,{i})' for i in ui))
    O = [Ou[uj.index(j)] for j, _ in pairs]; R = [Ru[ui.index(i)] for _, i in pairs]
    # 2. spatial alignment (similarity transform via SIFT)
    sift = cv2.SIFT_create(4000); X = []; Y = []; F = []; RR = []
    for k in range(N):
        g1 = (O[k].mean(-1) * 255).astype(np.uint8); g2 = (R[k].mean(-1) * 255).astype(np.uint8)
        k1, d1 = sift.detectAndCompute(cv2.createCLAHE(2, (8, 8)).apply(g1), None); k2, d2 = sift.detectAndCompute(cv2.createCLAHE(2, (8, 8)).apply(g2), None)
        m = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
        M, _ = cv2.estimateAffinePartial2D(np.float32([k1[a.queryIdx].pt for a in m]), np.float32([k2[a.trainIdx].pt for a in m]), method=cv2.RANSAC, ransacReprojThreshold=2)
        o = cv2.GaussianBlur(cv2.warpAffine(O[k], M, (W, H)), (0, 0), 2); r = cv2.GaussianBlur(R[k], (0, 0), 2)
        gm = np.hypot(*np.gradient(o.mean(-1))); m = np.zeros((H, W), bool); m[40:H - 40:4, 40:W - 40:4] = True; m &= gm < 0.01
        X.append(o[m]); Y.append(r[m]); F.append(np.full(m.sum(), k)); yy, xx = np.nonzero(m); RR.append(np.hypot(xx - W / 2, yy - H / 2) / np.hypot(W / 2, H / 2))
        if k == 0: print('alignment: scale %.4f shift %.1f,%.1f px' % (np.hypot(M[0, 0], M[1, 0]), M[0, 2], M[1, 2]))
    x, y, f, rad = map(np.concatenate, (X, Y, F, RR)); val = f % 5 == 2
    dec = lambda v: np.clip(v, 0, 1) ** 2.4; enc = lambda v: np.clip(v, 0, 1) ** (1 / 2.4)
    vc = np.ones(20); RB = np.linspace(0, 1, 21); vev = lambda r: np.interp(r, (RB[:-1] + RB[1:]) / 2, vc)
    keep = np.ones(len(x), bool)
    for it in range(3 if vig else 2):
        tgt = enc(dec(y) / vev(rad)[:, None]) if vig else y
        Sx, Sy, cnt = L.aggregate(x[keep & ~val], tgt[keep & ~val]); w = np.minimum(cnt, 200).astype(float)
        base = L.fit(Sx, Sy, w, lam=300, mu=1e-3)              # smooth global curve (anchor for unseen colours)
        lut = L.fit(Sx, Sy, w, lam=3, mu=3e-2, base=base)
        p = L.apply(lut, x)
        if vig:
            pl, yl = dec(p).mean(-1), dec(y).mean(-1); bi = np.clip(np.digitize(rad, RB) - 1, 0, 19)
            for b in range(20):
                mm = keep & (bi == b) & (pl > 0.02)
                if mm.sum() > 500: vc[b] = (yl[mm] * pl[mm]).sum() / (pl[mm] ** 2).sum()
            vc /= vc[0]; p = enc(dec(p) * vev(rad)[:, None])
        res = np.abs(p - y).max(-1); keep = res < max(6 * np.median(res), 4 / 255)
    e = (L.apply(lut, x[val]) if not vig else enc(dec(L.apply(lut, x[val])) * vev(rad[val])[:, None])) - y[val]
    print(f'held-out RMSE {np.sqrt((e ** 2).mean()) * 255:.2f}/255 (identity {np.sqrt(((x[val] - y[val]) ** 2).mean()) * 255:.2f})')
    rp = [(np.abs(e[(rad[val] >= a) & (rad[val] < a + .25)]).mean() * 255).round(2) for a in (0, .25, .5, .75)]
    print('mean abs error by radius (centre→corner):', rp, '(rising = vignette left on in Dehancer; rerun with --vignette)')
    L.write_cube(lut, out, name); print('wrote', out)

if __name__ == '__main__': main()
