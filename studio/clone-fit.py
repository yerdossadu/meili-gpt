"""Fit a page clone to its scan by measurement instead of by model opinion.

For every text block of library/<book>/pages/<NNN>/index.html it sweeps
  1. the font scale (--k) and then
  2. the horizontal and vertical offset,
renders the whole page after each step, and keeps the value that gives the best
SSIM inside that block's region of the scan. Blocks are independent, so one render
tests one candidate for all blocks at once.

The original index.html is never modified. The result is written next to it as
index.fitted.html, with a before/after table in metrics/page-NNN/fit-report.json.

Usage: ocr-runtime\\Scripts\\python.exe clone-fit.py --page 16 [--apply]
  --apply   copy index.html to index.before-fit.html and replace index.html
"""
import argparse, importlib.util, json, re, shutil
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('clone_metrics', ROOT / 'clone-metrics.py')
cm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cm)

K_SCALES = [0.80, 0.86, 0.92, 0.96, 1.0, 1.04, 1.08, 1.14, 1.22]
SHIFTS = [-0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6]      # percent of page width / height
SKIP = ('hsk-photo', 'hsk-background', 'hsk-deco')     # different media in the clone - not comparable
TAG = re.compile(r'<(\w+)\s([^>]*?data-block="(\d+)"[^>]*)>')


def num(style, name):
    m = re.search(rf'(?:^|;){name}:\s*(-?[\d.]+)', style)
    return float(m.group(1)) if m else None


def parse_blocks(html):
    blocks = {}
    for m in TAG.finditer(html):
        attrs = m.group(2)
        style_m = re.search(r'style="([^"]*)"', attrs)
        cls_m = re.search(r'class="([^"]*)"', attrs)
        if not style_m or not cls_m or any(s in cls_m.group(1) for s in SKIP):
            continue
        style = style_m.group(1)
        left, top, width = num(style, 'left'), num(style, 'top'), num(style, 'width')
        if None in (left, top, width):
            continue
        bottom_m = re.search(r'data-hsk-bottom="([\d.]+)"', attrs)
        height = num(style, 'height') or num(style, 'min-height')
        bottom = float(bottom_m.group(1)) * 100 if bottom_m else top + (height or 3)
        blocks[int(m.group(3))] = {'left': left, 'top': top, 'width': width,
                                   'bottom': max(bottom, top + (height or 0), top + 1),
                                   'k': num(style, '--k'), 'name': cls_m.group(1).split()[-1]}
    return blocks


def apply_params(html, params):
    """params: {block: {'k': float|None, 'dx': float, 'dy': float}} -> new html."""
    def repl(m):
        n = int(m.group(3))
        p = params.get(n)
        if not p:
            return m.group(0)
        tag = m.group(0)
        style_m = re.search(r'style="([^"]*)"', tag)
        if not style_m:
            return tag
        style = style_m.group(1)
        if p.get('k') is not None:
            style = re.sub(r'(--k:)[\d.]+', lambda s: f"{s.group(1)}{p['k']:.4f}", style, count=1)
        for prop, key in (('left', 'dx'), ('top', 'dy')):
            base = p['base'][prop]
            style = re.sub(rf'((?:^|;){prop}:)-?[\d.]+%', lambda s: f"{s.group(1)}{base + p.get(key, 0):.3f}%", style, count=1)
        return tag[:style_m.start(1)] + style + tag[style_m.end(1):]
    return TAG.sub(repl, html)


def region_scores(scan_gray, clone_gray, blocks):
    h, w = scan_gray.shape
    out = {}
    for n, b in blocks.items():
        x0, x1 = int((b['left'] - .5) / 100 * w), int((b['left'] + b['width'] + .5) / 100 * w)
        y0, y1 = int((b['top'] - .5) / 100 * h), int((b['bottom'] + .5) / 100 * h)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        a = cv2.GaussianBlur(scan_gray[y0:y1, x0:x1], (0, 0), 2).astype(np.float32)
        c = cv2.GaussianBlur(clone_gray[y0:y1, x0:x1], (0, 0), 2).astype(np.float32)
        out[n] = cm.ssim(a, c, sigma=2.0)[0]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--page', type=int, required=True)
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    page_dir = ROOT / 'library' / cm.BOOK / 'pages' / f'{args.page:03d}'
    html = (page_dir / 'index.html').read_text(encoding='utf-8')
    scan = cv2.imdecode(np.fromfile(str(page_dir / 'scan.png'), np.uint8), cv2.IMREAD_COLOR)
    h, w = scan.shape[:2]
    scan_gray = cv2.cvtColor(scan, cv2.COLOR_BGR2GRAY)
    blocks = parse_blocks(html)
    work = ROOT / 'metrics' / 'fit'
    work.mkdir(parents=True, exist_ok=True)
    shot = work / 'shot.png'
    variant = work / 'variant.html'

    def score(params):
        variant.write_text(apply_params(html, params), encoding='utf-8')
        cm.render_page(args.page, shot, w, h, src='/metrics/fit/variant.html')
        img = cv2.imdecode(np.fromfile(str(shot), np.uint8), cv2.IMREAD_GRAYSCALE)
        if img.shape != scan_gray.shape:
            img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
        return region_scores(scan_gray, img, blocks)

    best = {n: {'k': b['k'], 'dx': 0.0, 'dy': 0.0, 'base': {'left': b['left'], 'top': b['top']}} for n, b in blocks.items()}
    before = score(best)
    top = dict(before)
    print(f'{len(blocks)} blocks, {len(K_SCALES) + 2 * len(SHIFTS)} renders')

    def sweep(label, candidates, setter):
        nonlocal top
        for c in candidates:
            trial = {n: dict(p) for n, p in best.items()}
            for n, p in trial.items():
                setter(p, blocks[n], c)
            s = score(trial)
            for n, v in s.items():
                if v > top.get(n, -1) + 1e-4:
                    top[n] = v
                    setter(best[n], blocks[n], c)
            print(f'  {label} {c}: mean block SSIM {np.mean(list(top.values())):.4f}')

    sweep('k x', K_SCALES, lambda p, b, c: p.__setitem__('k', round(b['k'] * c, 4)) if b['k'] else None)
    sweep('dx %', SHIFTS, lambda p, b, c: p.__setitem__('dx', c))
    sweep('dy %', SHIFTS, lambda p, b, c: p.__setitem__('dy', c))

    # Blocks reflow each other, so combined optima can regress a block. Revert those.
    after = score(best)
    for _ in range(2):
        worse = [n for n in after if after[n] < before[n] - 1e-3]
        if not worse:
            break
        for n in worse:
            b = blocks[n]
            best[n].update({'k': b['k'], 'dx': 0.0, 'dy': 0.0})
        print(f'  reverted blocks {worse}')
        after = score(best)
    (page_dir / 'index.fitted.html').write_text(apply_params(html, best), encoding='utf-8')
    report = {'blocks': [{'block': n, 'type': blocks[n]['name'], 'ssim_before': round(before[n], 3),
                          'ssim_after': round(after.get(n, before[n]), 3), 'k': best[n]['k'],
                          'dx_pct': best[n]['dx'], 'dy_pct': best[n]['dy']} for n in sorted(before)],
              'mean_before': round(float(np.mean(list(before.values()))), 4),
              'mean_after': round(float(np.mean(list(after.values()))), 4)}
    out = ROOT / 'metrics' / f'page-{args.page:03d}'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'fit-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    for r in report['blocks']:
        print(f"  block {r['block']:>2} {r['type']:<12} {r['ssim_before']:.3f} -> {r['ssim_after']:.3f}  k={r['k']} dx={r['dx_pct']} dy={r['dy_pct']}")
    print(f"mean block SSIM {report['mean_before']} -> {report['mean_after']}")
    if args.apply:
        shutil.copyfile(page_dir / 'index.html', page_dir / 'index.before-fit.html')
        shutil.copyfile(page_dir / 'index.fitted.html', page_dir / 'index.html')
        print('applied; backup: index.before-fit.html')
    else:
        print('written index.fitted.html (index.html untouched)')


if __name__ == '__main__':
    main()
