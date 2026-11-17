# Generates the NSIS wizard art (MUI sidebar + header BMPs) from build/icon.png.
# electron-builder's assisted installer renders these on its pages.
#   python scripts/make-installer-art.py
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "build" / "icon.png"
OUT = ROOT / "build"

BG = (20, 22, 24)        # dark surface
BG_TOP = (26, 28, 32)
BG_BOT = (16, 17, 19)
TEXT = (236, 238, 242)
MUTED = (150, 157, 170)
ACCENT = (255, 61, 76)


def paste_glyph(bg, icon_path, cx, cy, size):
    """Center the transparent app glyph at (cx, cy) at `size` px."""
    icon = Image.open(icon_path).convert("RGBA")
    g = icon.resize((size, size), Image.LANCZOS)
    x, y = int(cx - size / 2), int(cy - size / 2)
    layer = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    layer.paste(g, (x, y), g)
    out = bg.convert("RGBA")
    out.alpha_composite(layer)
    return out


def vgrad(w, h):
    img = Image.new("RGBA", (w, h), BG + (255,))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        d.line([(0, y), (w, y)], fill=(r, g, b, 255))
    return img


def sidebars():
    """MUI_WELCOMEFINISHPAGE_BITMAP: 164x314, left rail, dark Berno-like."""
    w, h = 164, 314
    img = vgrad(w, h)
    # glyph block, centered horizontally
    img = paste_glyph(img, ICON, w / 2, 92, 84)
    d = ImageDraw.Draw(img)
    d.text((w // 2, 152), "Streamify", anchor="mm", fill=TEXT + (255,))
    d.text((w // 2, 170), "Desktop", anchor="mm", fill=MUTED + (255,))
    d.line((w // 2 - 26, 186, w // 2 + 26, 186), fill=ACCENT + (220,))
    d.text((w // 2, 206), "v" + version(), anchor="mm", fill=MUTED + (255,))
    img.convert("RGB").save(OUT / "installerSidebar.bmp", "BMP")
    print("wrote build/installerSidebar.bmp", (w, h))


def header():
    """MUI_HEADERIMAGE: 150x57 strip shown on later wizard pages."""
    w, h = 150, 57
    img = vgrad(w, h)
    img = paste_glyph(img, ICON, 32, h / 2, 40)
    d = ImageDraw.Draw(img)
    d.text((62, h / 2 - 7), "Streamify", anchor="lm", fill=TEXT + (255,))
    d.text((62, h / 2 + 9), "Desktop", anchor="lm", fill=MUTED + (255,))
    img.convert("RGB").save(OUT / "installerHeader.bmp", "BMP")
    print("wrote build/installerHeader.bmp", (w, h))


def version():
    import json
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


if __name__ == "__main__":
    if not ICON.exists():
        raise SystemExit(f"missing {ICON} — run `npm run icon` first")
    sidebars()
    header()
