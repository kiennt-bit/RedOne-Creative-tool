"""Trình dựng video — render engine (multi-step FFmpeg pipeline).

Rebuilt to follow the ORIGINAL .NET render backend's approach (pure FFmpeg
filter graphs) but in a single process: format each clip → compose multi-track
overlay → mix audio → encode with quality preset → thumbnail. See the approved
plan and the original sources under render.service/* for the exact recipes.
"""
from .compose import render_timeline  # noqa: F401
