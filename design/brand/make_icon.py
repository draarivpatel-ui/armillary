import math, sys
cx, cy, R = 512, 488, 236
RY = 72
TILT = -23.4

def ellipse(rx, ry, rot, stroke, sw, extra=""):
    t = f' transform="rotate({rot} {cx} {cy})"' if rot else ""
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx:.2f}" ry="{ry:.2f}"{t} fill="none" stroke="{stroke}" stroke-width="{sw}"{extra}/>'

def band(rx, ry, rot=0, clip=None, w=20, grad="gilt", opacity=1.0, hi=True):
    """A bevelled gilt band: dark base, gradient face, a light bevel on the outer edge, a dark inner edge."""
    k = ry / rx  # keep the band's thickness proportional on both axes
    c = f' clip-path="url(#{clip})"' if clip else ""
    out = [f'<g{c} opacity="{opacity}">',
           ellipse(rx, ry, rot, "#4A360C", w + 6),
           ellipse(rx, ry, rot, f"url(#{grad})", w)]
    if hi:
        e = w / 2 - 1.6
        out.append(ellipse(rx + e, ry + e * (1 if ry > 40 else k), rot, "#FBEFC4", 2.4, ' opacity="0.9"'))
        out.append(ellipse(rx - e, ry - e * (1 if ry > 40 else k), rot, "#3A2A08", 2.0, ' opacity="0.8"'))
    out.append("</g>")
    return "\n".join(out)

def ticks(r=300, major_len=22, mid_len=13, minor_len=8):
    t = []
    for k in range(72):
        a = math.radians(k * 5 - 90)
        major, mid = k % 6 == 0, k % 2 == 0
        l = major_len if major else mid_len if mid else minor_len
        w = 3.2 if major else 2.2
        op = 0.75 if major else 0.45 if mid else 0.3
        t.append(f'<line x1="{cx + r * math.cos(a):.1f}" y1="{cy + r * math.sin(a):.1f}" x2="{cx + (r - l) * math.cos(a):.1f}" y2="{cy + (r - l) * math.sin(a):.1f}" stroke="#C9A24A" stroke-width="{w}" opacity="{op}" stroke-linecap="round"/>')
    return "\n".join(t)

STARS = [(212, 232, 2.2, .55), (318, 176, 1.6, .4), (786, 214, 2.4, .6), (842, 328, 1.5, .35), (178, 612, 1.8, .4),
         (866, 640, 2.0, .45), (250, 820, 1.4, .3), (760, 846, 1.6, .35), (640, 168, 1.3, .3), (410, 860, 1.2, .25)]

DEFS = f'''<defs>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1C2846"/><stop offset="0.55" stop-color="#111A2E"/><stop offset="1" stop-color="#0A101C"/>
  </linearGradient>
  <radialGradient id="warmth" cx="0.5" cy="0.44" r="0.55">
    <stop offset="0" stop-color="#C9A24A" stop-opacity="0.16"/><stop offset="1" stop-color="#C9A24A" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.07"/><stop offset="0.4" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gilt" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
    <stop offset="0" stop-color="#F6E3A6"/><stop offset="0.28" stop-color="#E2C77E"/><stop offset="0.6" stop-color="#C9A24A"/><stop offset="1" stop-color="#8A6A22"/>
  </linearGradient>
  <linearGradient id="giltBack" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
    <stop offset="0" stop-color="#A88634"/><stop offset="1" stop-color="#5C4410"/>
  </linearGradient>
  <radialGradient id="earth" cx="0.38" cy="0.34" r="0.7">
    <stop offset="0" stop-color="#FBEFC4"/><stop offset="0.45" stop-color="#D9B862"/><stop offset="1" stop-color="#6E5417"/>
  </radialGradient>
  <radialGradient id="finial" cx="0.35" cy="0.3" r="0.75">
    <stop offset="0" stop-color="#FBEFC4"/><stop offset="1" stop-color="#8A6A22"/>
  </radialGradient>
  <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#000000" flood-opacity="0.38"/>
  </filter>
  <clipPath id="plateClip"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  <clipPath id="backEq"><rect x="0" y="0" width="1024" height="{cy}"/></clipPath>
  <clipPath id="frontEq"><rect x="0" y="{cy}" width="1024" height="{1024 - cy}"/></clipPath>
  <clipPath id="backEc"><rect x="-512" y="-512" width="2048" height="{cy + 512}" transform="rotate({TILT} {cx} {cy})"/></clipPath>
  <clipPath id="frontEc"><rect x="-512" y="{cy}" width="2048" height="1536" transform="rotate({TILT} {cx} {cy})"/></clipPath>
</defs>'''

PLATE = f'''<g filter="url(#drop)"><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#plate)"/></g>
<g clip-path="url(#plateClip)">
  <rect x="100" y="100" width="824" height="824" fill="url(#warmth)"/>
  <rect x="100" y="100" width="824" height="420" fill="url(#sheen)"/>
  STARS
</g>
<rect x="122" y="122" width="780" height="780" rx="166" fill="none" stroke="#C9A24A" stroke-width="BEZEL" opacity="0.42"/>
<rect x="100.5" y="100.5" width="823" height="823" rx="185.5" fill="none" stroke="#FFFFFF" stroke-width="1" opacity="0.08"/>'''

def full():
    stars = "\n  ".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#F4F1E8" opacity="{o}"/>' for x, y, r, o in STARS)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<!-- Armillary app icon (macOS), drawn for 64 px and up; app-icon-small.svg is the 16 and 32 px drawing.
     An engraved gilt armillary sphere on an ink plate in the first run's language: bevelled gilt bands
     (dark base, gilt face, light outer bevel, dark inner edge), back halves dimmer and behind the earth,
     a graduated ring, a faint star field. Generated by design/brand/make_icon.py. -->
{DEFS}
{PLATE.replace("STARS", stars).replace("BEZEL", "2.5")}
<circle cx="{cx}" cy="{cy}" r="300" fill="none" stroke="#C9A24A" stroke-width="2.2" opacity="0.55"/>
{ticks()}
{band(R, RY, 0, "backEq", grad="giltBack", opacity=0.85, hi=False)}
{band(R, RY, TILT, "backEc", grad="giltBack", opacity=0.85, hi=False)}
{band(80, R, 0, None, w=11, grad="giltBack", opacity=0.75, hi=False)}
<line x1="{cx}" y1="{cy - R - 44}" x2="{cx}" y2="{cy + R + 40}" stroke="#4A360C" stroke-width="12" stroke-linecap="round"/>
<line x1="{cx}" y1="{cy - R - 44}" x2="{cx}" y2="{cy + R + 40}" stroke="url(#gilt)" stroke-width="7" stroke-linecap="round"/>
<circle cx="{cx}" cy="{cy}" r="56" fill="url(#earth)" stroke="#4A360C" stroke-width="3"/>
{band(R, R)}
{band(R, RY, 0, "frontEq")}
{band(R, RY, TILT, "frontEc")}
<circle cx="{cx}" cy="{cy - R - 50}" r="17" fill="url(#finial)" stroke="#4A360C" stroke-width="3"/>
<path d="M{cx - 18} {cy + R + 34} L{cx + 18} {cy + R + 34} L{cx + 11} {cy + R + 84} L{cx - 11} {cy + R + 84} Z" fill="url(#gilt)" stroke="#4A360C" stroke-width="3" stroke-linejoin="round"/>
<path d="M{cx - 118} {cy + R + 104} Q{cx} {cy + R + 70} {cx + 118} {cy + R + 104} L{cx + 132} {cy + R + 122} Q{cx} {cy + R + 98} {cx - 132} {cy + R + 122} Z" fill="url(#gilt)" stroke="#4A360C" stroke-width="3" stroke-linejoin="round"/>
</svg>
'''

def small():
    # 16 and 32 px: the plate, a heavy meridian ring, one tilted ecliptic band and the earth. No ticks, no stand.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<!-- Armillary app icon, small drawing (16 and 32 px): fewer, heavier parts so it stays legible. Generated by design/brand/make_icon.py. -->
{DEFS}
{PLATE.replace("STARS", "").replace("BEZEL", "0")}
<g opacity="1">
  {band(250, 82, TILT, "backEc", w=54, grad="giltBack", opacity=0.9, hi=False)}
</g>
<line x1="{cx}" y1="{cy - 330}" x2="{cx}" y2="{cy + 330}" stroke="#4A360C" stroke-width="44" stroke-linecap="round"/>
<line x1="{cx}" y1="{cy - 330}" x2="{cx}" y2="{cy + 330}" stroke="url(#gilt)" stroke-width="30" stroke-linecap="round"/>
<circle cx="{cx}" cy="{cy}" r="92" fill="url(#earth)" stroke="#4A360C" stroke-width="10"/>
{band(262, 262, 0, None, w=64, hi=False)}
{band(250, 82, TILT, "frontEc", w=54, hi=False)}
</svg>
'''

out = sys.argv[1]
open(f"{out}/app-icon.svg", "w").write(full())
open(f"{out}/app-icon-small.svg", "w").write(small())
print("ok")
