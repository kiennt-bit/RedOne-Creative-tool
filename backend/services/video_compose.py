"""Backward-compat shim — the real render engine now lives in services/render/.

Kept so existing imports (`from ..services.video_compose import render_timeline,
VIDEO_EXTS, IMAGE_EXTS`) keep working after the faithful multi-step rebuild.
"""
from __future__ import annotations

from .render.compose import render_timeline  # noqa: F401
from .render.ffcmd import VIDEO_EXTS, IMAGE_EXTS, AUDIO_EXTS  # noqa: F401
