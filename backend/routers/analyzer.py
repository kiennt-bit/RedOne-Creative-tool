"""YouTube / Script / Image analyzer endpoints — all Gemini-powered."""
from __future__ import annotations
import asyncio
import json
import logging
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from ..config import OUTPUT_DIR
from ..services.gemini import generate_text, describe_image
from ..ws_hub import hub

log = logging.getLogger("navtools.analyzer")
router = APIRouter(prefix="/api/analyzer", tags=["analyzer"])


class ScriptAnalyzeRequest(BaseModel):
    script: str
    num_scenes: int = 5
    auto_detect_scenes: bool = True
    style_preset: Optional[str] = None
    style_lock: Optional[str] = None
    global_context: Optional[str] = None
    voice_gender: str = "female"
    character_aliases: Optional[dict] = None  # {"@nv1": "tên nhân vật"}


def _build_script_prompt(req: ScriptAnalyzeRequest) -> str:
    aliases = req.character_aliases or {}
    alias_lines = "\n".join(f"  {k}: {v}" for k, v in aliases.items()) or "  (no characters)"
    style = req.style_preset or "Cinematic"
    scene_directive = (
        "Auto-detect the optimal number of scenes (4-10)."
        if req.auto_detect_scenes
        else f"Split into EXACTLY {req.num_scenes} scenes."
    )
    return f"""You are a professional film director. Convert the following script into a structured video storyboard.

SCRIPT:
\"\"\"
{req.script.strip()}
\"\"\"

CHARACTERS:
{alias_lines}

STYLE: {style}
{('STYLE LOCK (use verbatim): ' + req.style_lock) if req.style_lock else ''}
{('GLOBAL CONTEXT: ' + req.global_context) if req.global_context else ''}
VOICE GENDER for narration: {req.voice_gender}

INSTRUCTIONS:
{scene_directive}

For EACH scene, output a JSON object with these keys:
- "scene": integer scene number
- "shot": one of [Extreme Wide Shot, Wide Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Over-the-Shoulder, POV]
- "camera": one of [Static, Pan Left, Pan Right, Tilt Up, Tilt Down, Zoom In, Zoom Out, Push In, Pull Out, Dolly, Tracking, Aerial]
- "characters": array of character aliases visible in this scene (from CHARACTERS above)
- "narration": 1-2 sentences of Vietnamese narration in {req.voice_gender} voice
- "prompt": A complete English Veo 3 prompt — describe subject, action, environment, lighting, camera, style. Include the style description.

Output ONLY a JSON array of scenes. No prose, no markdown fences."""


@router.post("/script")
async def analyze_script(body: ScriptAnalyzeRequest):
    """One-shot Gemini call to plan script into scenes."""
    if not body.script.strip():
        raise HTTPException(400, "Script is empty")
    prompt = _build_script_prompt(body)
    try:
        result = await generate_text(
            prompt,
            response_mime_type="application/json",
        )
        text = result["text"]
        text = re.sub(r"^```(?:json)?\s*", "", text.strip())
        text = re.sub(r"\s*```$", "", text)
        scenes = json.loads(text)
        return {
            "scenes": scenes,
            "model_used": result["model_used"],
            "fallback_log": result["fallback_log"],
        }
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(500, f"AI error: {e}")


@router.post("/regenerate-scene")
async def regenerate_scene(req: dict):
    """Regenerate a single scene with higher temperature."""
    script = req.get("script", "")
    scenes = req.get("scenes", [])
    idx = int(req.get("scene_index", 0))
    if idx < 0 or idx >= len(scenes):
        raise HTTPException(400, "Invalid scene index")
    existing = scenes[idx]
    prompt = f"""Regenerate ONLY scene {existing['scene']} with a DIFFERENT shot, camera, and angle.
Keep the same narration intent but change the cinematography.

ORIGINAL SCENE: {json.dumps(existing, ensure_ascii=False)}

Output a single JSON object (NOT an array)."""
    try:
        result = await generate_text(prompt, response_mime_type="application/json")
        new_scene = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", result["text"].strip()))
        scenes[idx] = new_scene
        return {"scene": new_scene, "model_used": result["model_used"]}
    except Exception as e:
        raise HTTPException(500, f"Regenerate failed: {e}")


# ---------------- YouTube / TikTok analyzer ----------------

class YouTubeAnalyzeRequest(BaseModel):
    url: str
    style_preset: Optional[str] = None
    style_lock: Optional[str] = None
    global_context: Optional[str] = None
    use_whisper: bool = False
    quick_mode: bool = True
    voice_gender: str = "female"
    character_aliases: Optional[dict] = None
    max_scenes: int = 12


def _detect_platform(url: str) -> str:
    if "tiktok.com" in url:
        return "tiktok"
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    return "unknown"


@router.post("/youtube")
async def analyze_youtube(body: YouTubeAnalyzeRequest):
    """Download video via yt-dlp, then run Gemini analysis on the video itself."""
    if not body.url.strip():
        raise HTTPException(400, "URL required")
    platform = _detect_platform(body.url)
    if platform == "unknown":
        raise HTTPException(400, "Unsupported URL (only YouTube/TikTok)")

    try:
        import yt_dlp
    except Exception:
        raise HTTPException(500, "yt-dlp not installed. Run: pip install yt-dlp")

    tmp = Path(tempfile.mkdtemp(prefix="navtools_yt_"))
    out_template = str(tmp / "video.%(ext)s")
    ydl_opts = {
        "outtmpl": out_template,
        "format": "best[height<=720][ext=mp4]/best[ext=mp4]/best",
        "quiet": True,
        "no_warnings": True,
    }
    title = None
    duration = None
    try:
        def _download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(body.url, download=True)
                return info
        info = await asyncio.to_thread(_download)
        title = info.get("title")
        duration = info.get("duration")
        downloaded = next(tmp.glob("video.*"), None)
        if not downloaded:
            raise RuntimeError("Download produced no file")
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(500, f"Download failed: {e}")

    aliases = body.character_aliases or {}
    alias_lines = "\n".join(f"  {k}: {v}" for k, v in aliases.items()) or "  (none)"
    style = body.style_preset or "Cinematic"
    instruction = f"""Analyze this video and break it into scenes for Veo 3 video generation.

PLATFORM: {platform}
TITLE: {title}
DURATION: {duration}s

CHARACTERS:
{alias_lines}

STYLE: {style}
{('STYLE LOCK: ' + body.style_lock) if body.style_lock else ''}
{('GLOBAL CONTEXT: ' + body.global_context) if body.global_context else ''}
VOICE GENDER: {body.voice_gender}

Output a JSON array, max {body.max_scenes} scenes. For each: scene, shot, camera, characters, narration, prompt.
{'QUICK MODE: Brief narration only.' if body.quick_mode else 'Detailed narration with quotes if heard.'}
Shot types: Extreme Wide, Wide, Medium, Medium Close-Up, Close-Up, Extreme Close-Up, OTS, POV.
Camera moves: Static, Pan Left/Right, Tilt Up/Down, Zoom In/Out, Push In, Pull Out, Dolly, Tracking, Aerial.

Output ONLY the JSON array."""

    try:
        result = await generate_text(
            instruction,
            images=[downloaded],
            response_mime_type="application/json",
        )
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", result["text"].strip())
        scenes = json.loads(text)
        return {
            "platform": platform,
            "title": title,
            "duration": duration,
            "scenes": scenes,
            "model_used": result["model_used"],
            "fallback_log": result["fallback_log"],
        }
    except Exception as e:
        raise HTTPException(500, f"AI analysis failed: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/youtube-upload")
async def analyze_uploaded_video(
    file: UploadFile = File(...),
    style_preset: str = Form("Cinematic"),
    max_scenes: int = Form(12),
):
    """Analyze a user-uploaded video file."""
    tmp = Path(tempfile.mkdtemp(prefix="navtools_upload_"))
    ext = Path(file.filename or "video.mp4").suffix
    out = tmp / f"video{ext}"
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        instruction = f"""Analyze this uploaded video and break it into scenes for Veo 3 video generation.
STYLE: {style_preset}
Output a JSON array, max {max_scenes} scenes. For each: scene, shot, camera, characters, narration, prompt.
Output ONLY the JSON array."""
        result = await generate_text(
            instruction,
            images=[out],
            response_mime_type="application/json",
        )
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", result["text"].strip())
        scenes = json.loads(text)
        return {"scenes": scenes, "model_used": result["model_used"]}
    except Exception as e:
        raise HTTPException(500, f"Failed: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------- Image-to-Prompt ----------------

@router.post("/image-to-prompt")
async def image_to_prompt(
    file: UploadFile = File(...),
    instruction: str = Form(""),
):
    tmp = Path(tempfile.mkdtemp(prefix="navtools_img_"))
    out = tmp / (file.filename or "image.png")
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        text = await describe_image(out, instruction.strip() or None)
        return {"prompt": text}
    except Exception as e:
        raise HTTPException(500, f"Failed: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
