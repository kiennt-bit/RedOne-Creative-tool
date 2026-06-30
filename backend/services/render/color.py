"""Color-adjustment → FFmpeg filter chain.

Mirrors the original `FFmpegService.ColorAdjustmentFfmpegCommand`. Editor sliders
are -100..100; the original works in -1..1, so we divide by 100. Returns a
comma-joined filter string (no leading/trailing comma) to splice into a per-clip
video chain, or '' when nothing is set.
"""
from __future__ import annotations
from .ffcmd import fmt


def _v(color: dict, key: str) -> float:
    try:
        return float(color.get(key) or 0) / 100.0
    except (TypeError, ValueError):
        return 0.0


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def color_filter(color: dict) -> str:
    if not color:
        return ""
    parts: list[str] = []

    # Temperature + tint → channel mixer (warm = +red/-blue; tint = green axis)
    t = _v(color, "temperature")
    ti = _v(color, "tint")
    if t or ti:
        parts.append(
            f"colorchannelmixer=rr={fmt(1 + t * 0.4)}:gg={fmt(1 + ti * 0.4)}:bb={fmt(1 - t * 0.4)}"
        )

    # Exposure → per-channel multiply by 2^exposure (computed in Python; no
    # commas/pow() inside the filtergraph to avoid escaping pitfalls).
    e = _v(color, "exposure")
    if e:
        m = fmt(2.0 ** e)
        parts.append(f"lutrgb=r=val*{m}:g=val*{m}:b=val*{m}")

    # Brightness / contrast / saturation → eq
    b = _v(color, "brightness")
    c = _v(color, "contrast")
    s = _v(color, "saturation")
    eqp = []
    if b:
        eqp.append(f"brightness={fmt(b)}")
    if c:
        eqp.append(f"contrast={fmt(1 + c)}")
    if s:
        eqp.append(f"saturation={fmt(1 + s)}")
    if eqp:
        parts.append("eq=" + ":".join(eqp))

    # Highlights / shadows / whites / blacks → tone curve (clamped to [0,1])
    hl = _v(color, "highlights")
    sh = _v(color, "shadows")
    wh = _v(color, "whites")
    bl = _v(color, "blacks")
    if hl or sh or wh or bl:
        y0 = _clamp(0.0 + bl * 0.25)
        y25 = _clamp(0.25 + sh * 0.25)
        y75 = _clamp(0.75 + hl * 0.25)
        y1 = _clamp(1.0 + wh * 0.25)
        parts.append(f"curves=all='0/{fmt(y0)} 0.25/{fmt(y25)} 0.75/{fmt(y75)} 1/{fmt(y1)}'")

    # Vibrance (smart saturation, stronger when pulling down)
    vib = _v(color, "vibrance")
    if vib:
        parts.append(f"vibrance=intensity={fmt(vib * (0.5 if vib > 0 else 0.75))}")

    # Sharpen
    shp = _v(color, "sharpen")
    if shp:
        parts.append(f"unsharp=5:5:{fmt(shp * 5)}:5:5:0")

    # Blur (UI-only in the original; we keep it for preview parity)
    blur = color.get("blur") or 0
    if blur:
        parts.append(f"gblur=sigma={fmt(float(blur) / 8.0)}")

    return ",".join(parts)
