"""Pillow-based image utilities: batch resize, bg fill."""
from __future__ import annotations
from io import BytesIO
from pathlib import Path
from typing import Optional

try:
    from PIL import Image, ImageOps
    HAS_PIL = True
except Exception:
    HAS_PIL = False


PRESETS = {
    "instagram_square": (1080, 1080),
    "instagram_portrait": (1080, 1350),
    "instagram_landscape": (1080, 566),
    "instagram_story": (1080, 1920),
    "tiktok_vertical": (1080, 1920),
    "youtube_thumbnail": (1280, 720),
    "youtube_shorts": (1080, 1920),
    "facebook_post": (1200, 630),
    "twitter_post": (1600, 900),
    "4k_landscape": (3840, 2160),
    "1080p_landscape": (1920, 1080),
    "720p_landscape": (1280, 720),
}


def resize_image(
    src: str | Path,
    dst: str | Path,
    *,
    width: int,
    height: int,
    mode: str = "fit",
    bg_color: str = "#000000",
    fmt: Optional[str] = None,
) -> str:
    """Resize image. mode: 'stretch' | 'fit' (letterbox) | 'cover' (crop)."""
    if not HAS_PIL:
        raise RuntimeError("Pillow not installed. Run: pip install Pillow")
    img = Image.open(src).convert("RGBA")
    if mode == "stretch":
        out = img.resize((width, height), Image.LANCZOS)
    elif mode == "fit":
        img.thumbnail((width, height), Image.LANCZOS)
        canvas = Image.new("RGBA", (width, height), bg_color)
        x = (width - img.width) // 2
        y = (height - img.height) // 2
        canvas.paste(img, (x, y), img if img.mode == "RGBA" else None)
        out = canvas
    elif mode == "cover":
        out = ImageOps.fit(img, (width, height), Image.LANCZOS, centering=(0.5, 0.5))
    else:
        raise ValueError(f"Unknown mode: {mode}")

    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    fmt = (fmt or dst.suffix.lstrip(".")).lower()
    save_fmt = "JPEG" if fmt in ("jpg", "jpeg") else fmt.upper()
    if save_fmt == "JPEG":
        out = out.convert("RGB")
        out.save(dst, "JPEG", quality=92)
    else:
        out.save(dst, save_fmt)
    return str(dst)


def crop_cover_inplace(path: str | Path, *, width: int, height: int) -> bool:
    """Center-crop + resize an image to exactly width×height (cover mode),
    overwriting the file in place. Reuses the same resize_image(mode="cover")
    that the batch-resize feature uses (ImageOps.fit = crop 2 sides + resize).

    Skips work (returns False) if the image is already the target size, so a
    correctly-sized image is never needlessly re-encoded. Returns True if a
    crop was applied. Raises if Pillow is missing only via resize_image; the
    no-PIL guard here returns False so callers degrade gracefully.
    """
    if not HAS_PIL:
        return False
    with Image.open(path) as im:
        if im.size == (width, height):
            return False
    resize_image(path, path, width=width, height=height, mode="cover")
    return True


def fill_background(src: str | Path, dst: str | Path, color: str = "#FFFFFF") -> str:
    """Replace transparent background with solid color."""
    if not HAS_PIL:
        raise RuntimeError("Pillow not installed.")
    img = Image.open(src).convert("RGBA")
    canvas = Image.new("RGB", img.size, color)
    canvas.paste(img, mask=img.split()[3] if img.mode == "RGBA" else None)
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dst, "PNG")
    return str(dst)
