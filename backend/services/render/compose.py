"""Render orchestrator — multi-track timeline → MP4 (single process).

Phase 1 of the faithful rebuild: format each visual clip (trim/scale/color/
opacity) and overlay all tracks by z-order onto a black canvas, mix audio
(per-clip volume + fade), encode with the quality preset, then make a thumbnail.
Transitions (xfade) and ASS text land in later phases. Same public signature as
before so the router is unchanged.
"""
from __future__ import annotations
import logging
import math
import shutil
import tempfile
from pathlib import Path

from .ffcmd import run, probe, fmt, kind_of
from .color import color_filter
from .ass import build_ass
from . import presets
from ..ffmpeg_utils import extract_thumbnail

log = logging.getLogger("redone.render")

_DEFAULT_IMAGE_DUR = 5.0
_MIN_DUR = 0.1


def _font_file() -> str:
    for p in (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\segoeui.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return str(Path(p)).replace("\\", "/")
    return ""


def _hex_to_0x(color: str, default: str = "white") -> str:
    c = (color or "").strip()
    if c.startswith("#") and len(c) >= 7:
        return "0x" + c[1:7]
    return c or default


def _ffpath(p) -> str:
    """Escape a path for use INSIDE a drawtext option in a filtergraph. The
    Windows drive colon must survive TWO parse levels (filtergraph + filter
    options), so it needs DOUBLE escaping → `C\\\\:/...`. Backslashes are
    forward-slashed first."""
    return str(p).replace("\\", "/").replace(":", "\\\\:")


# ffmpeg xfade transition names (== VideoTransitionType.ToString().ToLower() in
# the original .NET backend). The frontend sends the chosen name in `xf`.
_XFADE = {
    "fade", "wipeleft", "wiperight", "wipeup", "wipedown",
    "slideleft", "slideright", "slideup", "slidedown",
    "circlecrop", "rectcrop", "distance", "fadeblack", "fadewhite", "radial",
    "smoothleft", "smoothright", "smoothup", "smoothdown",
    "circleopen", "circleclose", "vertopen", "vertclose", "horzopen", "horzclose",
    "dissolve", "pixelize", "diagtl", "diagtr", "diagbl", "diagbr",
    "hlslice", "hrslice", "vuslice", "vdslice",
}


def _xfade_name(tr: dict) -> str:
    xf = (tr.get("xf") or "").strip().lower()
    if xf in _XFADE:
        return xf
    # legacy projects stored only a Vietnamese label — map the common ones
    name = (tr.get("name") or "").lower()
    legacy = {"gạt trái": "wipeleft", "gạt phải": "wiperight",
              "trượt lên": "slideup", "trượt xuống": "slidedown",
              "tan biến": "dissolve", "phóng to": "circleopen", "xoay": "radial"}
    for k, v in legacy.items():
        if k in name:
            return v
    return "fade"


async def render_timeline(spec, output_path, on_progress=None, should_cancel=None):
    """Compose the multi-track `spec` into one MP4. Returns True on success;
    raises asyncio.CancelledError if cancelled, RuntimeError on ffmpeg failure."""
    W = int(spec.get("width") or 1920)
    H = int(spec.get("height") or 1080)
    fps = int(spec.get("fps") or 30)
    tracks = spec.get("tracks") or []
    preset = presets.get(spec.get("quality"))

    probe_cache: dict[str, dict] = {}

    async def _probe(path):
        if path not in probe_cache:
            probe_cache[path] = await probe(path)
        return probe_cache[path]

    visual = []   # video/image clips, bottom→top
    texts = []    # text clips
    audios = []   # audio-bearing clips

    for tr in reversed(tracks):
        muted = bool(tr.get("muted"))
        tvol = (tr.get("volume") if tr.get("volume") is not None else 100) / 100.0
        for c in (tr.get("clips") or []):
            kind = kind_of(c.get("path", ""), c.get("kind"))
            start = float(c.get("start") or 0)
            if kind in ("video", "audio"):
                p = c.get("path")
                if not p or not Path(p).exists():
                    continue
                pr = await _probe(p)
                cin = max(0.0, float(c.get("in") or 0))
                cout = float(c.get("out") or (pr["duration"] or cin + _DEFAULT_IMAGE_DUR))
                if pr["duration"] > 0:
                    cout = min(cout, pr["duration"])
                cout = max(cin + _MIN_DUR, cout)
                rec = {"clip": c, "path": p, "in": cin, "out": cout, "start": start,
                       "dur": cout - cin, "has_audio": pr["has_audio"], "track": tr}
                if kind == "video":
                    visual.append({**rec, "kind": "video"})
                    if pr["has_audio"] and not muted:
                        audios.append({**rec, "tvol": tvol})
                elif not muted:
                    audios.append({**rec, "tvol": tvol})
            elif kind == "image":
                p = c.get("path")
                if not p or not Path(p).exists():
                    continue
                dur = max(_MIN_DUR, float(c.get("duration") or _DEFAULT_IMAGE_DUR))
                visual.append({"clip": c, "path": p, "in": 0, "out": dur, "start": start,
                               "dur": dur, "kind": "image", "track": tr})
            elif kind == "text":
                dur = max(_MIN_DUR, float(c.get("duration") or _DEFAULT_IMAGE_DUR))
                texts.append({"clip": c, "start": start, "dur": dur})

    total = float(spec.get("duration") or 0)
    for r in visual + audios + texts:
        total = max(total, r["start"] + r["dur"])
    if total <= 0:
        raise RuntimeError("Timeline trống — chưa có nội dung để xuất.")

    # ── transitions ────────────────────────────────────────────────────
    # A clip's transition runs a real ffmpeg `xfade` of the chosen type against
    # the PREVIOUS adjacent clip on the same track (mirrors VideoService.
    # CreateTransitionVideoFromVideos). We freeze the predecessor's last frame
    # for `dd`s, xfade it with the incoming clip's first `dd`s, and overlay that
    # transition clip over the boundary — so absolute timing / audio / other
    # tracks stay intact (no xfade time-compression).
    transitions = []
    by_track = {}
    for v in visual:
        by_track.setdefault(id(v.get("track")), []).append(v)
    for recs in by_track.values():
        recs.sort(key=lambda r: r["start"])
        for i, v in enumerate(recs):
            tr = v["clip"].get("transition") or {}
            d = float(tr.get("duration") or 0)
            if d <= 0:
                continue
            # predecessor = the clip right before on this track, if adjacent.
            # If there's none (first clip / gap), the clip transitions IN from
            # transparent — mirrors the original's PrevFileUrl=null (from black).
            a = recs[i - 1] if i > 0 else None
            if a is not None and (v["start"] - (a["start"] + a["dur"])) > 0.12:
                a = None
            dd = min(d, v["dur"])
            if a is not None:
                dd = min(dd, a["dur"])
            if dd < 0.05:
                continue
            v["xfade_d"] = dd
            transitions.append({"a": a, "b": v, "dd": dd, "xf": _xfade_name(tr)})
            if a is not None:
                a["is_a"] = True
            v["is_b"] = True

    inputs = ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={fps}:d={fmt(total)}"]
    idx = 1
    for v in visual:
        if v["kind"] == "image":
            inputs += ["-framerate", str(fps), "-loop", "1", "-t", fmt(v["dur"]), "-i", v["path"]]
        else:
            inputs += ["-i", v["path"]]
        v["idx"] = idx; idx += 1
    for a in audios:
        existing = next((v for v in visual if v["kind"] == "video" and v["clip"] is a["clip"]), None)
        if existing is not None:
            a["idx"] = existing["idx"]
        else:
            inputs += ["-i", a["path"]]
            a["idx"] = idx; idx += 1

    # ── video graph ────────────────────────────────────────────────────
    chains = []

    def _geo(c):
        natW = int(c.get("natW") or W); natH = int(c.get("natH") or H)
        cw = max(2, round(natW * float(c.get("scaleX") or 1)))
        ch = max(2, round(natH * float(c.get("scaleY") or 1)))
        return cw, ch, round(float(c.get("left") or 0)), round(float(c.get("top") or 0))

    def _rot(parts, cw, ch, left, top, angle):
        """Rotate the layer around its TOP-LEFT (fabric originX/Y=left/top) and
        return the overlay x/y that keeps that pivot at (left, top)."""
        if abs(angle) <= 0.01:
            return left, top
        a = math.radians(angle)              # fabric angle is clockwise (y-down)
        ca, sa = math.cos(a), math.sin(a)
        rw = abs(cw * ca) + abs(ch * sa)
        rh = abs(cw * sa) + abs(ch * ca)
        parts.append(f"rotate={fmt(a)}:ow={int(math.ceil(rw))}:oh={int(math.ceil(rh))}:c=black@0")
        rx = (-cw / 2.0) * ca - (-ch / 2.0) * sa     # top-left corner after rotation,
        ry = (-cw / 2.0) * sa + (-ch / 2.0) * ca     # relative to the rotated frame's center
        return round(left - (rw / 2.0 + rx)), round(top - (rh / 2.0 + ry))

    # An input is consumed once for its plain layer, plus once for each xfade
    # segment it feeds (as a predecessor `a` and/or as an incoming `b`). Split
    # it that many times so each consumer gets its own pad.
    pads = {}
    for v in visual:
        k = 1 + (1 if v.get("is_a") else 0) + (1 if v.get("is_b") else 0)
        if k == 1:
            pads[v["idx"]] = [f"[{v['idx']}:v]"]
        else:
            labels = [f"[s{v['idx']}_{j}]" for j in range(k)]
            chains.append(f"[{v['idx']}:v]split={k}" + "".join(labels))
            pads[v["idx"]] = labels

    # plain layers: each clip scaled/colored, overlaid at (left,top) by z-order
    prev = "[0:v]"
    for n, v in enumerate(visual):
        c = v["clip"]
        cw, ch, left, top = _geo(c)
        op = float(c.get("opacity") if c.get("opacity") is not None else 1)
        colf = color_filter(c.get("color") or {})
        start = v["start"]; end = v["start"] + v["dur"]
        pad = pads[v["idx"]].pop(0)
        if v["kind"] == "video":
            parts = [f"{pad}trim=start={fmt(v['in'])}:end={fmt(v['out'])}",
                     "setpts=PTS-STARTPTS", f"scale={cw}:{ch}"]
        else:
            parts = [f"{pad}scale={cw}:{ch}"]
        if colf:
            parts.append(colf)
        parts.append("format=rgba")
        if op < 0.999:
            parts.append(f"colorchannelmixer=aa={fmt(op)}")
        ovx, ovy = _rot(parts, cw, ch, left, top, float(c.get("angle") or 0))
        parts.append(f"setpts=PTS+{fmt(start)}/TB")
        chains.append(",".join(parts) + f"[v{n}]")
        en_start = start + float(v.get("xfade_d", 0.0))   # transition clip covers the lead-in
        chains.append(f"{prev}[v{n}]overlay=x={ovx}:y={ovy}:"
                      f"enable='between(t,{fmt(en_start)},{fmt(end)})':eof_action=pass[bg{n}]")
        prev = f"[bg{n}]"

    # transition clips: real per-type xfade over each boundary, overlaid on top
    def _seg(pad, c, kind, t0, dur, freeze, lab):
        """Full-canvas WxH rgba segment of length `dur`: the clip content (from
        src time t0, or its frozen frame) scaled/colored and placed at its
        position on a transparent canvas — an xfade-ready frame."""
        cw, ch, left, top = _geo(c)
        colf = color_filter(c.get("color") or {})
        if kind == "video":
            p = [f"{pad}trim=start={fmt(t0)}:end={fmt(t0 + (1.0 / fps if freeze else dur))}",
                 "setpts=PTS-STARTPTS"]
            if freeze:
                p.append(f"tpad=stop_mode=clone:stop_duration={fmt(dur)}")
            p.append(f"scale={cw}:{ch}")
        else:
            p = [f"{pad}scale={cw}:{ch}"]
        if colf:
            p.append(colf)
        p.append("format=rgba")
        chains.append(",".join(p) + f"[{lab}c]")
        chains.append(f"color=c=black@0:s={W}x{H}:r={fps}:d={fmt(dur)},format=rgba[{lab}b]")
        chains.append(f"[{lab}b][{lab}c]overlay=x={left}:y={top}:shortest=1,"
                      f"trim=0:{fmt(dur)},setpts=PTS-STARTPTS,fps={fps}[{lab}]")

    for ti, T in enumerate(transitions):
        a = T["a"]; b = T["b"]; dd = T["dd"]; xf = T["xf"]; bs = b["start"]
        if a is not None:
            a_last = (a["out"] if a["kind"] == "video" else a["dur"]) - 1.0 / fps
            _seg(pads[a["idx"]].pop(0), a["clip"], a["kind"], max(0.0, a_last), dd, True, f"SA{ti}")
        else:    # no predecessor -> transition in from transparent (reveals beneath/black)
            chains.append(f"color=c=black@0:s={W}x{H}:r={fps}:d={fmt(dd)},format=rgba,fps={fps}[SA{ti}]")
        _seg(pads[b["idx"]].pop(0), b["clip"], b["kind"], b["in"], dd, False, f"SB{ti}")
        chains.append(f"[SA{ti}][SB{ti}]xfade=transition={xf}:duration={fmt(dd)}:offset=0,"
                      f"setpts=PTS+{fmt(bs)}/TB[TX{ti}]")
        chains.append(f"{prev}[TX{ti}]overlay="
                      f"enable='between(t,{fmt(bs)},{fmt(bs + dd)})':eof_action=pass[bgt{ti}]")
        prev = f"[bgt{ti}]"

    # text via ASS (libass) — faithful font/size/color/bold/italic/outline/align
    tmpdir = Path(tempfile.mkdtemp(prefix="redone_render_"))
    ass_path = None
    if texts:
        ass_path = str(tmpdir / "subs.ass")
        build_ass(texts, W, H, ass_path)
    if ass_path:
        chains.append(f"{prev}format=yuv420p,ass={_ffpath(ass_path)}[outv]")
    else:
        chains.append(f"{prev}format=yuv420p[outv]")

    # ── audio graph ────────────────────────────────────────────────────
    a_labels = []
    for n, a in enumerate(audios):
        c = a["clip"]
        vol = ((c.get("volume") if c.get("volume") is not None else 100) / 100.0) * a.get("tvol", 1.0)
        fin = float(c.get("fadeIn") or 0); fout = float(c.get("fadeOut") or 0)
        fade = ""
        if fin > 0:
            fade += f",afade=t=in:st=0:d={fmt(fin)}"
        if fout > 0 and a["dur"] > fout:
            fade += f",afade=t=out:st={fmt(a['dur'] - fout)}:d={fmt(fout)}"
        delay = int(a["start"] * 1000)
        a_labels.append(
            f"[{a['idx']}:a]atrim=start={fmt(a['in'])}:end={fmt(a['out'])},asetpts=PTS-STARTPTS,"
            f"volume={fmt(vol)}{fade},adelay={delay}|{delay}[a{n}]"
        )
    if a_labels:
        chains.append("".join(f"[a{n}]" for n in range(len(a_labels)))
                      + f"amix=inputs={len(a_labels)}:normalize=0:dropout_transition=0[aout]")
        chains = a_labels + chains
    else:
        chains.append(f"anullsrc=r=44100:cl=stereo,atrim=duration={fmt(total)},asetpts=PTS-STARTPTS[aout]")

    filter_complex = ";".join(chains)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    args = [
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "[aout]",
        "-r", str(fps),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-maxrate", preset["maxrate"], "-bufsize", preset["bufsize"], "-g", str(preset["gop"]),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
        "-t", fmt(total),
        "-movflags", "+faststart",
        str(output_path),
    ]
    try:
        code, err = await run(args, total, on_progress, should_cancel, pct_lo=0, pct_hi=97)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    if code != 0:
        raise RuntimeError(f"ffmpeg thất bại (mã {code}): {(err or '')[-800:] or '(không có log)'}")

    # thumbnail (best-effort)
    try:
        thumb = str(Path(output_path).with_suffix(".jpg"))
        await extract_thumbnail(str(output_path), thumb, at=min(1.0, total / 2))
    except Exception:
        pass
    if on_progress:
        try:
            await on_progress(100.0, "Hoàn tất")
        except Exception:
            pass
    return True
