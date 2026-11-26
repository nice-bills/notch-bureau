"""Snap every demo's CSS to one type scale, an 8pt spacing grid and one radius set.
Run from demos-opus: python3 src/normalize.py  (idempotent; prints what it changed)."""
import re, sys, collections

TYPE = [12, 14, 16, 20, 24, 32, 40, 56, 72]          # the only font sizes allowed
RADII = [8, 12, 16, 24, 32]                          # plus 50% and 99px pills; <=4px kept for hairline bars

def snap_type(v):
    return min(TYPE, key=lambda t: (abs(t - v), -t))

def snap_space(v):
    a = abs(v)
    if a == 0: return 0
    if a <= 5: s = 4
    else: s = int(a / 8.0 + 0.5) * 8 or 8
    return s if v > 0 else -s

def snap_radius(v):
    if v <= 4 or v >= 99: return v
    return min(RADII, key=lambda r: (abs(r - v), -r))

def fmt(n):
    return ('%g' % n)

SPACE_PROPS = r'(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block))?|gap|row-gap|column-gap'
log = collections.Counter()

def fix_decls(css):
    def px_sub(fn, kind):
        def inner(m):
            prop, val = m.group(1), m.group(2)
            def num(mm):
                old = float(mm.group(1)); new = fn(old)
                if new != old: log[(kind, fmt(old), fmt(new))] += 1
                return fmt(new) + 'px'
            return prop + ':' + re.sub(r'(-?\d*\.?\d+)px', num, val)
        return inner
    css = re.sub(r'(font-size)\s*:\s*([^;}"]+)', px_sub(snap_type, 'type'), css)
    css = re.sub(r'(border-radius)\s*:\s*([^;}"]+)', px_sub(snap_radius, 'radius'), css)
    css = re.sub(r'((?<![-\w])(?:' + SPACE_PROPS + r'))\s*:\s*([^;}"]+)', px_sub(snap_space, 'space'), css)
    css = re.sub(r'((?<![-\w])(?:width|height|min-height))\s*:\s*(\d+(?:\.\d+)?px)(?=[;}"])', px_sub(snap_size, 'size'), css)
    return css

def snap_size(v):
    # component sizes: icons 16/20/24, controls on the 8pt grid; hairlines and illustrations untouched
    if v < 14 or v > 64: return v
    if v < 18: return 16
    if v < 22: return 20
    return int(v / 8.0 + 0.5) * 8
    return css

def run(path):
    s = open(path).read()
    s2 = re.sub(r'(<style>)(.*?)(</style>)', lambda m: m.group(1) + fix_decls(m.group(2)) + m.group(3), s, flags=re.S)
    s2 = re.sub(r'(style=")([^"]*)(")', lambda m: m.group(1) + fix_decls(m.group(2)) + m.group(3), s2)
    if s2 != s: open(path, 'w').write(s2)

for p in sys.argv[1:]:
    log.clear(); run(p)
    by = collections.defaultdict(list)
    for (k, a, b), n in sorted(log.items()): by[k].append(f'{a}->{b} x{n}')
    print(p); [print('  ', k, ', '.join(v)) for k, v in by.items()]
