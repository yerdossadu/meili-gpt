"""Measure how close an HTML page clone is to the original scan.

Replaces the "Vision model says it looks fine" check with numbers:
  pixel_match_pct  share of pixels whose colour is within TOLERANCE of the scan
  ssim             structural similarity of the full-size images (grayscale)
  ssim_blur        SSIM after blurring - ignores scan grain, keeps layout
  edge_f1          overlap of text/shape edges (tolerates a 2 px shift)
  mae              mean absolute colour error, 0-255

Usage:
  ocr-runtime\\Scripts\\python.exe clone-metrics.py --page 16
  ocr-runtime\\Scripts\\python.exe clone-metrics.py --original a.png --clone b.png
Outputs go to metrics/page-<n>/ (report.json, diff.png, side-by-side.png).
"""
import argparse, functools, http.server, json, subprocess, sys, tempfile, threading
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
BOOK = '25d1aad102e4'
TOLERANCE = 24          # per-channel difference still counted as "the same pixel"
GRID = (8, 6)           # rows, cols for the per-region report
EDGES = [Path(p) for p in (
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe')]


def ssim(a, b, sigma=1.5):
    """Gaussian-window SSIM on float grayscale images; returns (mean, map)."""
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (0, 0), sigma)
    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a ** 2
    var_b = blur(b * b) - mu_b ** 2
    cov = blur(a * b) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2))
    return float(m.mean()), m


def edge_f1(gray_a, gray_b, shift=2):
    ea = cv2.Canny(gray_a, 60, 160) > 0
    eb = cv2.Canny(gray_b, 60, 160) > 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * shift + 1, 2 * shift + 1))
    near_a = cv2.dilate(ea.astype(np.uint8), k) > 0
    near_b = cv2.dilate(eb.astype(np.uint8), k) > 0
    precision = (eb & near_a).sum() / max(1, eb.sum())
    recall = (ea & near_b).sum() / max(1, ea.sum())
    return float(2 * precision * recall / max(1e-9, precision + recall))


def measure(original, clone):
    h, w = original.shape[:2]
    if clone.shape[:2] != (h, w):
        clone = cv2.resize(clone, (w, h), interpolation=cv2.INTER_AREA)
    delta = np.abs(original.astype(np.int16) - clone.astype(np.int16))
    same = (delta.max(axis=2) <= TOLERANCE)
    ga = cv2.cvtColor(original, cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(clone, cv2.COLOR_BGR2GRAY)
    s_full, s_map = ssim(ga.astype(np.float32), gb.astype(np.float32))
    ba, bb = cv2.GaussianBlur(ga, (0, 0), 3), cv2.GaussianBlur(gb, (0, 0), 3)
    s_blur, _ = ssim(ba.astype(np.float32), bb.astype(np.float32), sigma=4)
    rows, cols = GRID
    cells = []
    for r in range(rows):
        for c in range(cols):
            ys, ye = r * h // rows, (r + 1) * h // rows
            xs, xe = c * w // cols, (c + 1) * w // cols
            cells.append({'row': r, 'col': c,
                          'pixel_match_pct': round(float(same[ys:ye, xs:xe].mean() * 100), 1),
                          'ssim': round(float(s_map[ys:ye, xs:xe].mean()), 3)})
    report = {
        'size': [w, h],
        'pixel_match_pct': round(float(same.mean() * 100), 2),
        'ssim': round(s_full, 4),
        'ssim_blur': round(s_blur, 4),
        'edge_f1': round(edge_f1(ga, gb), 4),
        'mae': round(float(delta.mean()), 2),
        'worst_regions': sorted(cells, key=lambda x: x['ssim'])[:6],
        'cells': cells,
    }
    heat = cv2.applyColorMap(np.clip(delta.max(axis=2) * 3, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    return report, clone, heat


def render_page(page, out_png, w, h, src=None, extra=''):
    """Screenshot pages/render-frame.html for library page <page> with headless Edge/Chrome.
    `src` is an optional site-relative path of an alternative index.html to render."""
    browser = next((p for p in EDGES if p.exists()), None)
    if not browser:
        sys.exit('Edge/Chrome not found - pass --clone with a PNG instead.')
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/pages/render-frame.html?n={page:03d}&book={BOOK}&w={w}&h={h}' + (f'&src={src}' if src else '') + extra
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run([str(browser), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        f'--user-data-dir={profile}', f'--window-size={w},{h}',
                        '--force-device-scale-factor=1', '--virtual-time-budget=20000',
                        f'--screenshot={out_png}', url],
                       check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server.shutdown()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--page', type=int, help='library page number, e.g. 16')
    ap.add_argument('--original')
    ap.add_argument('--clone')
    ap.add_argument('--out')
    args = ap.parse_args()

    if args.page:
        original_path = ROOT / 'library' / BOOK / 'pages' / f'{args.page:03d}' / 'scan.png'
        out = Path(args.out or ROOT / 'metrics' / f'page-{args.page:03d}')
    elif args.original and args.clone:
        original_path, out = Path(args.original), Path(args.out or ROOT / 'metrics' / 'custom')
    else:
        ap.error('use --page N, or --original and --clone')
    out.mkdir(parents=True, exist_ok=True)

    original = cv2.imdecode(np.fromfile(str(original_path), np.uint8), cv2.IMREAD_COLOR)
    if original is None:
        sys.exit(f'Cannot read {original_path}')
    h, w = original.shape[:2]
    if args.page:
        clone_path = out / 'clone.png'
        render_page(args.page, clone_path, w, h)
    else:
        clone_path = Path(args.clone)
    clone = cv2.imdecode(np.fromfile(str(clone_path), np.uint8), cv2.IMREAD_COLOR)
    if clone is None:
        sys.exit(f'Cannot read {clone_path}')

    report, clone, heat = measure(original, clone)
    (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    cv2.imencode('.png', heat)[1].tofile(str(out / 'diff.png'))
    pair = np.hstack([original, clone, heat])
    scale = 1800 / pair.shape[1]
    small = cv2.resize(pair, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    cv2.imencode('.png', small)[1].tofile(str(out / 'side-by-side.png'))

    print(f"pixel match {report['pixel_match_pct']}%  SSIM {report['ssim']}  "
          f"SSIM(blur) {report['ssim_blur']}  edges F1 {report['edge_f1']}  MAE {report['mae']}")
    print('worst regions (row,col -> ssim):',
          ', '.join(f"({c['row']},{c['col']}) {c['ssim']}" for c in report['worst_regions']))
    print('report ->', out)


if __name__ == '__main__':
    main()
