#!/usr/bin/env python3
"""Render `tmux capture-pane -e -p` output as a PNG (needs Pillow and a mono font).

  python3 tools/screenshot/ansi-to-png.py capture.ansi docs/img/tui-dashboard.png [--cols 200 --rows 50]

Handles the SGR codes the mu dashboard emits: reset, bold, dim, inverse,
16 colours (30-37, 90-97, 40-47, 100-107), 256 and truecolour.
"""
import argparse
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.path.expanduser("~/.local/share/fonts/JetBrainsMonoNerd")
FONTS = {
    False: f"{FONT_DIR}/JetBrainsMonoNerdFontMono-Regular.ttf",
    True: f"{FONT_DIR}/JetBrainsMonoNerdFontMono-Bold.ttf",
}
BG, FG = (26, 27, 38), (192, 202, 245)
PALETTE = [  # tokyonight-ish: 0-7 normal, 8-15 bright
    (21, 22, 30), (247, 118, 142), (158, 206, 106), (224, 175, 104),
    (122, 162, 247), (187, 154, 247), (125, 207, 255), (169, 177, 214),
    (86, 95, 137), (247, 118, 142), (158, 206, 106), (224, 175, 104),
    (122, 162, 247), (187, 154, 247), (125, 207, 255), (192, 202, 245),
]


def xterm256(n):
    if n < 16:
        return PALETTE[n]
    if n < 232:
        n -= 16
        lv = [0, 95, 135, 175, 215, 255]
        return (lv[n // 36], lv[(n // 6) % 6], lv[n % 6])
    g = 8 + (n - 232) * 10
    return (g, g, g)


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def parse(text, cols, rows):
    grid = [[(" ", None) for _ in range(cols)] for _ in range(rows)]
    st = dict(fg=None, bg=None, bold=False, dim=False, inv=False)
    for y, line in enumerate(text.split("\n")[:rows]):
        x = 0
        for m in re.finditer(r"\x1b\[([0-9;:]*)m|(.)", line):
            if m.group(2) is None:
                p = [int(v or 0) for v in re.split(r"[;:]", m.group(1))] or [0]
                i = 0
                while i < len(p):
                    c = p[i]
                    if c == 0:
                        st.update(fg=None, bg=None, bold=False, dim=False, inv=False)
                    elif c == 1: st["bold"] = True
                    elif c == 2: st["dim"] = True
                    elif c == 22: st["bold"] = st["dim"] = False
                    elif c == 7: st["inv"] = True
                    elif c == 27: st["inv"] = False
                    elif 30 <= c <= 37: st["fg"] = PALETTE[c - 30]
                    elif 90 <= c <= 97: st["fg"] = PALETTE[c - 90 + 8]
                    elif c == 39: st["fg"] = None
                    elif 40 <= c <= 47: st["bg"] = PALETTE[c - 40]
                    elif 100 <= c <= 107: st["bg"] = PALETTE[c - 100 + 8]
                    elif c == 49: st["bg"] = None
                    elif c in (38, 48) and i + 1 < len(p):
                        if p[i + 1] == 5 and i + 2 < len(p):
                            col, i = xterm256(p[i + 2]), i + 2
                        elif p[i + 1] == 2 and i + 4 < len(p):
                            col, i = tuple(p[i + 2:i + 5]), i + 4
                        else:
                            col = None
                        if col is not None:
                            st["fg" if c == 38 else "bg"] = col
                    i += 1
            elif x < cols:
                grid[y][x] = (m.group(2), dict(st))
                x += 1
    return grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--cols", type=int, default=200)
    ap.add_argument("--rows", type=int, default=50)
    ap.add_argument("--size", type=int, default=16)
    a = ap.parse_args()
    fonts = {b: ImageFont.truetype(f, a.size) for b, f in FONTS.items()}
    cw = round(fonts[False].getlength("M"))
    ch = round(a.size * 1.3)
    pad = 16
    grid = parse(open(a.src, encoding="utf-8").read(), a.cols, a.rows)
    img = Image.new("RGB", (a.cols * cw + 2 * pad, a.rows * ch + 2 * pad), BG)
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, (c, st) in enumerate(row):
            if st is None:
                continue
            fg, bg = st["fg"] or FG, st["bg"] or BG
            if st["inv"]:
                fg, bg = bg if st["bg"] else BG, fg
            if st["dim"]:
                fg = mix(fg, bg, 0.45)
            px, py = pad + x * cw, pad + y * ch
            if bg != BG:
                d.rectangle([px, py, px + cw - 1, py + ch - 1], fill=bg)
            if c != " ":
                d.text((px, py + (ch - a.size) // 2 - 1), c, font=fonts[st["bold"]], fill=fg)
    img.save(a.dst, optimize=True)
    print(f"{a.dst}: {img.size[0]}x{img.size[1]}", file=sys.stderr)


main()
