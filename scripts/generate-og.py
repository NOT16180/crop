#!/usr/bin/env python3
"""
Generate the 1200x630 Open Graph card for crop.notgalerie.com.

Shared art direction with notgalerie.com:
- Pure white paper (#ffffff), charcoal ink (#212121), muted ink (#6e6e6e)
- Crisp 2px outer frame, square corners, 1px internal rules
- Local Inconsolata monospace font (decompressed from woff2 in memory)
- 4:5 framed artwork on the right with authentic Crop tag boxes

Edit the CARD dict below, then run:
    python3 scripts/generate-og.py
"""

from __future__ import annotations

import io
from pathlib import Path
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
FONT_WOFF2 = ROOT / "src" / "assets" / "fonts" / "inconsolata-latin.woff2"
OUTPUT_PATH = ROOT / "public" / "og-crop.jpg"

# --- Edit these fields to customize the Crop Open Graph card ---
CARD = {
    "domain": "CROP.NOTGALERIE.COM",
    "section": "REFERENCE LIBRARY",
    "title": "CROP",
    "subtitle": "TAG & CROP YOUR\nDRAWING REFERENCES",
    "description": "Tag whole drawings or specific details,\nthen find every crop in one search.",
    "footer": "LOCAL-FIRST · OFFLINE · NO AI · NO ADS",
    "artwork": ROOT / "public" / "samples" / "machina.webp",
    "show_square_mark": True,
    # Optional crop boxes in source artwork pixels: (label, [x, y, w, h])
    "crop_boxes": [
        ("FACE", (360, 261, 405, 315)),
        ("HATCHING", (333, 702, 495, 414)),
    ],
}

BG = (255, 255, 255)
INK = (33, 33, 33)       # #212121
MUTED = (110, 110, 110)  # ~62% ink on white
WHITE = (255, 255, 255)

W, H = 1200, 630
MARGIN = 32
SPLIT_X = 696
BAR_H = 62


def load_inconsolata_bytes(woff2_path: Path) -> bytes:
    font = TTFont(str(woff2_path))
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def make_font(ttf_bytes: bytes, size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(io.BytesIO(ttf_bytes), size=size)
    try:
        f.set_variation_by_axes([weight, 100])
    except Exception:
        pass
    return f


def draw_tracked_text(
    draw: ImageDraw.ImageDraw,
    pos: tuple[float, float],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int],
    tracking: float = 0.0,
    anchor: str = "la",
) -> float:
    """Draw single-line text with custom letter-spacing."""
    if not text:
        return 0.0
    widths = [draw.textlength(ch, font=font) for ch in text]
    total_w = sum(widths) + tracking * max(0, len(text) - 1)
    x, y = pos
    if anchor.startswith("r"):
        x -= total_w
    elif anchor.startswith("m"):
        x -= total_w / 2
    cur_x = x
    for idx, ch in enumerate(text):
        draw.text((cur_x, y), ch, font=font, fill=fill, anchor="l" + anchor[1])
        cur_x += widths[idx] + tracking
    return total_w


def render_card(card: dict, ttf_bytes: bytes, output: Path) -> None:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    x0, y0 = MARGIN, MARGIN
    x1, y1 = W - MARGIN, H - MARGIN

    # Outer crisp 2px #212121 frame (drawn as 4 exact rects to avoid anti-aliasing)
    draw.rectangle([x0, y0, x1, y0 + 1], fill=INK)
    draw.rectangle([x0, y1 - 1, x1, y1], fill=INK)
    draw.rectangle([x0, y0, x0 + 1, y1], fill=INK)
    draw.rectangle([x1 - 1, y0, x1, y1], fill=INK)

    # Vertical divider between typography placard (left) and artwork frame (right)
    draw.rectangle([SPLIT_X, y0, SPLIT_X + 1, y1], fill=INK)

    # Top and bottom 1px rules on left panel
    top_bar_y = y0 + BAR_H
    bot_bar_y = y1 - BAR_H
    draw.line([(x0, top_bar_y), (SPLIT_X, top_bar_y)], fill=INK, width=1)
    draw.line([(x0, bot_bar_y), (SPLIT_X, bot_bar_y)], fill=INK, width=1)

    font_meta = make_font(ttf_bytes, 18, 500)
    font_title = make_font(ttf_bytes, 96, 400)
    font_sub = make_font(ttf_bytes, 27, 500)
    font_desc = make_font(ttf_bytes, 22, 400)
    font_footer = make_font(ttf_bytes, 17, 500)
    font_tag = make_font(ttf_bytes, 15, 600)

    pad_x = 38
    left_x = x0 + pad_x
    right_x = SPLIT_X - pad_x

    # Top header bar
    header_mid_y = (y0 + top_bar_y) / 2
    domain_x = left_x
    if card.get("show_square_mark"):
        sq = 18
        sy0 = int(header_mid_y - sq / 2)
        sx0 = left_x
        draw.rectangle([sx0, sy0, sx0 + sq, sy0 + 1], fill=INK)
        draw.rectangle([sx0, sy0 + sq - 1, sx0 + sq, sy0 + sq], fill=INK)
        draw.rectangle([sx0, sy0, sx0 + 1, sy0 + sq], fill=INK)
        draw.rectangle([sx0 + sq - 1, sy0, sx0 + sq, sy0 + sq], fill=INK)
        domain_x = left_x + sq + 12

    draw_tracked_text(draw, (domain_x, header_mid_y), card["domain"], font_meta, INK, tracking=2.2, anchor="lm")
    draw_tracked_text(draw, (right_x, header_mid_y), card["section"], font_meta, MUTED, tracking=2.0, anchor="rm")

    # Hero block in left panel
    cur_y = top_bar_y + 58
    draw_tracked_text(draw, (left_x, cur_y), card["title"], font_title, INK, tracking=8.0, anchor="la")
    cur_y += 112

    # Short editorial rule
    draw.rectangle([left_x, cur_y, left_x + 54, cur_y + 1], fill=INK)
    cur_y += 28

    for line in card["subtitle"].split("\n"):
        draw_tracked_text(draw, (left_x, cur_y), line, font_sub, INK, tracking=2.0, anchor="la")
        cur_y += 38

    cur_y += 16
    for line in card["description"].split("\n"):
        draw.text((left_x, cur_y), line, font=font_desc, fill=MUTED, anchor="la")
        cur_y += 32

    # Footer bar
    footer_mid_y = (bot_bar_y + y1) / 2
    draw_tracked_text(draw, (left_x, footer_mid_y), card["footer"], font_footer, MUTED, tracking=1.8, anchor="lm")

    # Right artwork panel (4:5 framed artwork inside white gallery mat)
    mat = 28
    art_area_x0 = SPLIT_X + 2 + mat
    art_area_y0 = y0 + mat
    art_area_x1 = x1 - mat
    art_area_y1 = y1 - mat
    frame_w = art_area_x1 - art_area_x0
    frame_h = art_area_y1 - art_area_y0

    src = Image.open(card["artwork"]).convert("RGB")
    src_w, src_h = src.size
    fitted = ImageOps.fit(src, (frame_w, frame_h), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    img.paste(fitted, (art_area_x0, art_area_y0))

    # Optional Crop tag boxes mapped accurately onto the fitted artwork
    crop_boxes = card.get("crop_boxes") or []
    if crop_boxes:
        scale = max(frame_w / src_w, frame_h / src_h)
        scaled_w = src_w * scale
        scaled_h = src_h * scale
        crop_left = (scaled_w - frame_w) / 2
        crop_top = (scaled_h - frame_h) / 2

        for label, (bx, by, bw, bh) in crop_boxes:
            rx0 = int(round(art_area_x0 + bx * scale - crop_left))
            ry0 = int(round(art_area_y0 + by * scale - crop_top))
            rx1 = int(round(art_area_x0 + (bx + bw) * scale - crop_left))
            ry1 = int(round(art_area_y0 + (by + bh) * scale - crop_top))
            # Clamp inside artwork frame
            rx0 = max(art_area_x0 + 4, rx0)
            ry0 = max(art_area_y0 + 4, ry0)
            rx1 = min(art_area_x1 - 4, rx1)
            ry1 = min(art_area_y1 - 4, ry1)

            # Outer #212121 outline + inner crisp white border (exact Crop viewer style)
            draw.rectangle([rx0 - 1, ry0 - 1, rx1 + 1, ry1 + 1], outline=INK, width=2)
            draw.rectangle([rx0 + 1, ry0 + 1, rx1 - 1, ry1 - 1], outline=WHITE, width=2)

            # Label pill at top-left of box
            label_w = int(draw.textlength(label, font=font_tag) + 1.5 * max(0, len(label) - 1))
            pill_w = label_w + 14
            pill_h = 22
            draw.rectangle([rx0, ry0, rx0 + pill_w, ry0 + pill_h], fill=INK)
            draw_tracked_text(draw, (rx0 + 7, ry0 + pill_h / 2), label, font_tag, WHITE, tracking=1.5, anchor="lm")

    # Crisp 1px #212121 frame around the artwork
    draw.rectangle([art_area_x0, art_area_y0, art_area_x1, art_area_y1], outline=INK, width=1)

    output.parent.mkdir(parents=True, exist_ok=True)
    img.save(output, format="JPEG", quality=92, optimize=True, progressive=True)
    print(f"Generated {output} ({W}x{H}, {output.stat().st_size // 1024} KB)")


def main() -> None:
    ttf_bytes = load_inconsolata_bytes(FONT_WOFF2)
    render_card(CARD, ttf_bytes, OUTPUT_PATH)


if __name__ == "__main__":
    main()
