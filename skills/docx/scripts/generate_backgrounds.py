#!/usr/bin/env python3
"""Tech Protocol — Geometric hex pattern with circuit-like lines.
Cool slate blue-gray on near-white. Clean, technical, professional."""
import os, sys

PAGE_W, PAGE_H = 794, 1123
C = {'bg':'#f5f6f8','primary':'#3d5a80','secondary':'#5c7a99','accent':'#98b4c6','rule':'#dce2e8','light':'#e8ecf0'}
M = 45

HEX_PATTERN = '''<pattern id="hex" width="28" height="48" patternUnits="userSpaceOnUse">
<path d="M14 0 L28 8 L28 24 L14 32 L0 24 L0 8 Z" fill="none" stroke="#dce2e8" stroke-width="0.4" opacity="0.5"/>
</pattern>'''

def _hex_bg():
    return f'<rect width="100%" height="100%" fill="{C["bg"]}"/><rect width="100%" height="100%" fill="url(#hex)" opacity="0.35"/>'

def _left_accent_bar(y, h, op=0.15):
    return f'<rect x="0" y="{y}" width="6" height="{h}" fill="{C["primary"]}" opacity="{op}"/>'

def _top_line(op=0.25):
    return f'<line x1="{M}" y1="{M+20}" x2="{PAGE_W-M}" y2="{PAGE_W-M+20}" stroke="{C["primary"]}" stroke-width="0.8" opacity="{op}"/>'

SVG = lambda body: (f'<!DOCTYPE html><html><head><meta charset="utf-8">'
 f'<style>*{{margin:0;padding:0}}body{{width:{PAGE_W}px;height:{PAGE_H}px;background:{C["bg"]}}}</style></head><body>'
 f'<svg width="{PAGE_W}" height="{PAGE_H}" xmlns="http://www.w3.org/2000/svg">'
 f'<defs>{HEX_PATTERN}</defs>'
 f'{body}'
 f'</svg></body></html>')

W, H = PAGE_W, PAGE_H
cx = W // 2

# Cover: hex pattern + left accent bar + geometric corner elements
COVER = SVG(f'''
{_hex_bg()}
<!-- Left accent bar -->
<rect x="0" y="180" width="8" height="380" fill="{C['primary']}" opacity="0.18"/>
<rect x="0" y="200" width="4" height="120" fill="{C['secondary']}" opacity="0.25"/>
<!-- Top thin line -->
<line x1="{M}" y1="{M}" x2="{W-M}" y2="{M}" stroke="{C['primary']}" stroke-width="1.2" opacity="0.3"/>
<!-- Bottom decorative line -->
<line x1="{M}" y1="{H-M-60}" x2="{W-M}" y2="{H-M-60}" stroke="{C['accent']}" stroke-width="0.6" opacity="0.25"/>
<!-- Small corner squares -->
<rect x="{M}" y="{M}" width="12" height="12" fill="{C['primary']}" opacity="0.15"/>
<rect x="{W-M-12}" y="{H-M-72}" width="10" height="10" fill="{C['primary']}" opacity="0.12"/>
<!-- Subtle dot pattern bottom -->
<circle cx="{M+20}" cy="{H-M-30}" r="2" fill="{C['accent']}" opacity="0.2"/>
<circle cx="{M+35}" cy="{H-M-30}" r="1.5" fill="{C['accent']}" opacity="0.15"/>
<circle cx="{M+48}" cy="{H-M-30}" r="1" fill="{C['accent']}" opacity="0.1"/>
''')

# Body: minimal, just a subtle left bar and top line
BODY = SVG(f'''
<rect width="100%" height="100%" fill="{C['bg']}" opacity="0.5"/>
<!-- Very subtle left edge -->
<rect x="0" y="0" width="3" height="100%" fill="{C['primary']}" opacity="0.06"/>
''')

# Backcover: hex pattern + centered element
BACK = SVG(f'''
{_hex_bg()}
<!-- Top line -->
<line x1="{M}" y1="{M}" x2="{W-M}" y2="{M}" stroke="{C['primary']}" stroke-width="1.0" opacity="0.25"/>
<!-- Center accent bar -->
<rect x="{cx-3}" y="{H//2-80}" width="6" height="160" fill="{C['primary']}" opacity="0.12"/>
<!-- Bottom line -->
<line x1="{M}" y1="{H-M}" x2="{W-M}" y2="{H-M}" stroke="{C['accent']}" stroke-width="0.6" opacity="0.25"/>
<!-- Corner accents -->
<rect x="{M}" y="{M}" width="10" height="10" fill="{C['primary']}" opacity="0.12"/>
<rect x="{W-M-10}" y="{H-M-10}" width="10" height="10" fill="{C['primary']}" opacity="0.12"/>
''')

def _render(tpl, out):
    from playwright.sync_api import sync_playwright
    os.makedirs(out, exist_ok=True)
    pairs = list(tpl.items())
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': PAGE_W, 'height': PAGE_H}, device_scale_factor=2)
        for n, h in pairs:
            pg.set_content(h)
            pg.screenshot(path=os.path.join(out, n), type='png')
            print(n)
        b.close()

if __name__=='__main__':
    out=sys.argv[1] if len(sys.argv)>1 else os.path.dirname(os.path.abspath(__file__))
    _render({'cover_bg.png':COVER,'backcover_bg.png':BACK,'body_bg.png':BODY},out)
    print("Done - Tech Protocol")
