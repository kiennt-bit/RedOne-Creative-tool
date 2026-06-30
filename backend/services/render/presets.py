"""Output quality presets — bitrate/buffer/gop per tier (from RenderConst.cs).

The editor sets the canvas resolution via the aspect-ratio picker, so width/
height come from the project spec; the quality tier here picks the encode
bitrate ceiling + GOP (and an optional resolution cap). Default = HD.
"""
from __future__ import annotations

PRESETS = {
    "HD": {"bitrate": "15M", "maxrate": "18M", "bufsize": "18M", "gop": 48, "max_dim": 1920},
    "2K": {"bitrate": "30M", "maxrate": "35M", "bufsize": "35M", "gop": 48, "max_dim": 2560},
    "4K": {"bitrate": "50M", "maxrate": "60M", "bufsize": "60M", "gop": 48, "max_dim": 3840},
}
DEFAULT = "HD"


def get(quality: str) -> dict:
    return PRESETS.get((quality or "").upper(), PRESETS[DEFAULT])
