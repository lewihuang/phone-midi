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
WEB = os.path.join(ROOT, 'web')


def _find_exe():
    """按"dist 里最新的 .exe"找打包产物。

    文件名**不能写死**：产品改过名（`phone-midi-bridge.exe` → `手机推子.exe` → `MIDI Deck.exe`），
    写死一次就在改名时静默失效——而这条检查存在的意义正是"别让过期快照看起来像好的"。
    """
    dist = os.path.join(ROOT, 'bridge', 'dist')
    if not os.path.isdir(dist):
        return None
    exes = [os.path.join(dist, f) for f in os.listdir(dist) if f.lower().endswith('.exe')]
    return max(exes, key=os.path.getmtime) if exes else None


EXE = _find_exe()

results = []


def check(name, ok, detail=''):
    results.append(ok)
    print('%s  %-58s %s' % ('PASS' if ok else 'FAIL', name, detail))


def main():
    if not EXE or not os.path.exists(EXE):
        print('SKIP  bridge/dist/*.exe not built (nothing to compare)')
        return 0
    print('      打包产物：%s' % os.path.basename(EXE))

    ar = CArchiveReader(EXE)
    toc = {k.replace('\\', '/'): k for k in ar.toc}

    # "Changed the source but forgot to rebuild" has bitten this project repeatedly, and the
    # byte comparison below only covers web/ — server.py is compiled into the archive, so a
    # timestamp comparison is the cheap guard that catches it.
    exe_mtime = os.path.getmtime(EXE)
    sources = [os.path.join(ROOT, 'bridge', 'server.py')]
    for root, _dirs, files in os.walk(WEB):
        sources += [os.path.join(root, f) for f in files]
    newer = [os.path.relpath(p, ROOT).replace('\\', '/') for p in sources
             if os.path.getmtime(p) > exe_mtime]
    check('exe is newer than every source it bundles',
          not newer,
          'stale: rebuild needed (%s)' % ', '.join(newer[:4]) if newer else 'up to date')

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
    if 'web/fader.html' in toc:
        ih = ar.extract(toc['web/fader.html']).decode('utf-8', 'ignore')
        # Derive the expected cache-buster from the source rather than hardcoding it: a literal
        # here fails on every version bump while telling us nothing the byte comparison does not.
        # 注意：带脚本的页面现在是 fader.html（首页 index.html 只是模块列表，没有任何脚本）。
        src = open(os.path.join(WEB, 'fader.html'), encoding='utf-8').read()
        pattern = r'(?:fusion|app|vibrato|latency|pad|calibrate-wizard)\.js\?v=\d+'
        want, have = set(re.findall(pattern, src)), set(re.findall(pattern, ih))
        check('packaged cache-busters match the source page',
              bool(want) and want == have,
              'source %s, packaged %s' % (sorted(want), sorted(have)))

    print('\n%d/%d checks passed' % (len([r for r in results if r]), len(results)))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
