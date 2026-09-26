# The exe bundles a *snapshot* of web/, so a front-end change only reaches the packaged app after
# a rebuild — and a stale snapshot looks exactly like a working app. This compares the archive
# against the working tree byte for byte and asserts the Mode B chain is the new one.
#
# Skips (exit 0) when dist/ has no exe, so the suite still runs on a clean checkout.
import os
import re
import sys

from PyInstaller.archive.readers import CArchiveReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'bridge', 'dist', '手机推子.exe')
WEB = os.path.join(ROOT, 'web')

results = []


def check(name, ok, detail=''):
    results.append(ok)
    print('%s  %-58s %s' % ('PASS' if ok else 'FAIL', name, detail))


def main():
    if not os.path.exists(EXE):
        print('SKIP  bridge/dist/手机推子.exe not built (nothing to compare)')
        return 0

    ar = CArchiveReader(EXE)
    toc = {k.replace('\\', '/'): k for k in ar.toc}

    local = []
    for root, _dirs, files in os.walk(WEB):
        for f in files:
            local.append(os.path.relpath(os.path.join(root, f), ROOT).replace('\\', '/'))
    local.sort()

    packed = sorted(n for n in toc if n.startswith('web/'))
    check('archive file list matches web/ (no file added or dropped)',
          set(packed) == set(local),
          '%d packed / %d on disk%s' % (len(packed), len(local),
                                        '' if set(packed) == set(local)
                                        else ' diff=%s' % sorted(set(packed) ^ set(local))))

    stale = []
    for p in local:
        if p not in toc:
            continue
        with open(os.path.join(ROOT, p), 'rb') as fh:
            if ar.extract(toc[p]) != fh.read():
                stale.append(p)
    check('every bundled web file is byte-identical to the working tree',
          not stale, 'stale: %s' % ', '.join(stale) if stale else 'exe is up to date')

    if 'web/fusion.js' in toc:
        fj = ar.extract(toc['web/fusion.js']).decode('utf-8', 'ignore')
        check('packaged fusion.js has the attitude Mode B chain',
              'function gravityFromOrientation' in fj and 'function feedFlipOrientation' in fj,
              'gravityFromOrientation + feedFlipOrientation present')
        check('packaged fusion.js has no Mode B filter left',
              'FLIP_STABILIZER' not in fj and 'feedFlipMotion' not in fj and 'tuning/flip' not in fj,
              'no FLIP_STABILIZER / feedFlipMotion / tuning storage')
    if 'web/index.html' in toc:
        ih = ar.extract(toc['web/index.html']).decode('utf-8', 'ignore')
        # Derive the expected cache-buster from the source rather than hardcoding it: a literal
        # here fails on every version bump while telling us nothing the byte comparison does not.
        src = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()
        pattern = r'(?:fusion|app|vibrato|latency|pad|calibrate-wizard)\.js\?v=\d+'
        want, have = set(re.findall(pattern, src)), set(re.findall(pattern, ih))
        check('packaged cache-busters match the source page',
              bool(want) and want == have,
              'source %s, packaged %s' % (sorted(want), sorted(have)))

    print('\n%d/%d checks passed' % (len([r for r in results if r]), len(results)))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
