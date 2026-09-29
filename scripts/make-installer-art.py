# Generates the NSIS wizard art (MUI sidebar + header BMPs) from build/icon.png.
# electron-builder's assisted installer renders these on its pages; without them
# the wizard is the bare default Windows grey. Run after any icon change.
#   python scripts/make-installer-art.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "build" / "icon.png"
OUT = ROOT / "build"

BG = (17, 19, 24)        # app surface, matches the shell
PANEL = (24, 27, 34)     # slightly lifted panel
ACCENT = (255, 61, 76)   # streamify red
TEXT = (236, 238, 242)
MUTED = (150, 157, 170)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m


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


def sidebars():
    """MUI_SIDEBAR_IMAGE: 164x314, left rail, top-aligned branding."""
    w, h = 164, 314
    img = Image.new("RGBA", (w, h), BG + (255,))
    d = ImageDraw.Draw(img)

    # soft vertical gradient so the rail doesn't read as flat black
    for y in range(h):
        t = y / h
        d.line(
            [(0, y), (w, y)],
            fill=(int(BG[0] + 10 * t), int(BG[1] + 11 * t), int(BG[2] + 13 * t), 255),
        )

    # accent hairline down the right edge
    d.rectangle((w - 3, 0, w - 1, h), fill=ACCENT + (255,))

    # glyph block, centered horizontally
    img = paste_glyph(img, ICON, w / 2, 92, 84)

    d = ImageDraw.Draw(img)
    d.text((w // 2, 152), "Streamify", anchor="mm", fill=TEXT + (255,))
    d.text((w // 2, 170), "Desktop", anchor="mm", fill=MUTED + (255,))
    d.line((w // 2 - 26, 186, w // 2 + 26, 186), fill=ACCENT + (255,))
    d.text((w // 2, 206), "v" + version(), anchor="mm", fill=MUTED + (255,))

    img.convert("RGB").save(OUT / "installerSidebar.bmp", "BMP")
    print("wrote build/installerSidebar.bmp", (w, h))


def header():
    """MUI_HEADERIMAGE: 150x57 strip shown on later wizard pages."""
    w, h = 150, 57
    img = Image.new("RGBA", (w, h), BG + (255,))
    d = ImageDraw.Draw(img)
    for x in range(w):
        t = x / w
        d.line(
            [(x, 0), (x, h)],
            fill=(int(BG[0] + 12 * t), int(BG[1] + 13 * t), int(BG[2] + 16 * t), 255),
        )
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
