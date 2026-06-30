"""Generate an ASS subtitle file from the timeline's text clips.

Faithful to the editor's text styling (font / size / fill / outline / bold /
italic / alignment / optional background box) and positioned at each clip's
top-left like the fabric.js Textbox (originX/originY = left/top). Applied at
render time via the libass `ass` filter — replaces the old drawtext path.
"""
from __future__ import annotations
from pathlib import Path


def _ass_color(hexs: str, default: str = "#ffffff", alpha: str = "00") -> str:
    """#RRGGBB -> ASS &HAABBGGRR (alpha 00 = opaque)."""
    c = (hexs or "").strip()
    if not (c.startswith("#") and len(c) >= 7):
        c = default
    r, g, b = c[1:3], c[3:5], c[5:7]
    return f"&H{alpha}{b}{g}{r}".upper()


def _ass_time(t: float) -> str:
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    cs = int(round((t - int(t)) * 100))
    if cs >= 100:
        cs = 99
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _esc(text: str) -> str:
    """Escape text for an ASS Dialogue field."""
    return (text or "").replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\r", "").replace("\n", "\\N")


def build_ass(texts, W: int, H: int, out_path: str) -> str:
    """Write an .ass file for `texts` (list of {clip,start,dur}); return its path."""
    head = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
         "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
         "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
         "MarginL, MarginR, MarginV, Encoding"),
    ]
    styles = []
    events = ["", "[Events]",
              "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    for i, t in enumerate(texts):
        c = t["clip"]
        st = c.get("style") or {}
        font = (st.get("fontFamily") or "Arial").strip() or "Arial"
        if font.lower() in ("inter",):          # web font not on Windows -> substitute
            font = "Arial"
        size = int(float(st.get("fontSize") or 72))
        primary = _ass_color(st.get("fill") or "#ffffff")
        sw = float(st.get("strokeWidth") or 0)
        outline_col = _ass_color(st.get("stroke") or "#000000", "#000000")
        bg = (st.get("bgColor") or "").strip()
        if bg:
            border_style = 3          # opaque box behind text
            back_col = _ass_color(bg, "#000000")
            outline = max(0.0, sw)
        else:
            border_style = 1          # outline + shadow
            back_col = "&H00000000"
            outline = max(0.0, sw)
        weight = str(st.get("fontWeight") or "")
        bold = -1 if (weight == "bold" or (weight.isdigit() and int(weight) >= 600)) else 0
        italic = -1 if (st.get("fontStyle") == "italic") else 0
        align = (st.get("align") or "left").lower()
        an = {"left": 7, "center": 8, "right": 9}.get(align, 7)

        styles.append(
            f"Style: t{i},{font},{size},{primary},&H000000FF,{outline_col},{back_col},"
            f"{bold},{italic},0,0,100,100,0,0,{border_style},{outline:g},0,{an},10,10,10,1"
        )

        left = float(c.get("left") or 0)
        top = float(c.get("top") or 0)
        width = float(c.get("natW") or 800)
        if an == 8:
            px, py = left + width / 2.0, top
        elif an == 9:
            px, py = left + width, top
        else:
            px, py = left, top
        start = _ass_time(t["start"])
        end = _ass_time(t["start"] + t["dur"])
        txt = _esc(c.get("text") or "")
        events.append(
            f"Dialogue: 0,{start},{end},t{i},,0,0,0,,{{\\pos({px:g},{py:g})}}{txt}"
        )

    content = "\n".join(head + styles + events) + "\n"
    Path(out_path).write_text(content, encoding="utf-8")
    return out_path
