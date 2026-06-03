"""Gemini API wrapper with model fallback chain."""
from __future__ import annotations
import asyncio
import base64
import logging
import mimetypes
import os
import sys
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("navtools.gemini")

try:
    from google import genai
    from google.genai import types as gtypes
    HAS_GENAI = True
except Exception:
    HAS_GENAI = False


def _missing_lib_msg() -> str:
    """Build a copy-pasteable install command that points at the SAME Python
    that's currently running the server. Avoids the common "I installed it
    but the server still says missing" trap where `pip` and `python` resolve
    to different interpreters on Windows."""
    py = sys.executable or "python"
    needs_quote = " " in py
    py_arg = f'"{py}"' if needs_quote else py
    return (
        "Thư viện google-genai chưa cài. Mở PowerShell rồi chạy:\n"
        f"  {py_arg} -m pip install google-genai\n"
        "→ Sau đó restart tool. Hoặc cài hết deps một lượt:\n"
        f"  {py_arg} -m pip install -r requirements.txt"
    )


from ..config import GEMINI_MODELS_CHAIN
from ..database import db


def get_api_key() -> Optional[str]:
    """Read Gemini API key from settings or env."""
    return db.get_setting("gemini_api_key") or os.environ.get("GEMINI_API_KEY")


def _client() -> Optional["genai.Client"]:
    if not HAS_GENAI:
        return None
    key = get_api_key()
    if not key:
        return None
    return genai.Client(api_key=key)


# Media over this size (or ANY video) must go through the Gemini Files API
# rather than inline base64 bytes (Gemini caps a single request at ~20MB).
_INLINE_LIMIT = 18 * 1024 * 1024


def _guess_mime(path: Path) -> str:
    """Real mime from file extension. Critical: the YouTube analyzer feeds a
    downloaded .mp4 here — labelling it image/jpeg (the old behaviour) made
    Gemini reply 400 'Unable to process input image'."""
    ext = path.suffix.lower()
    table = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
        ".mov": "video/quicktime", ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo", ".mpeg": "video/mpeg",
    }
    if ext in table:
        return table[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "image/jpeg"


async def _build_media_part(client, img):
    """Build a Gemini content part for an image OR video input.

    - raw bytes → inline JPEG (only image-describe callers pass bytes)
    - small image file → inline bytes with the CORRECT mime
    - video file OR file > ~18MB → upload via the Files API and wait until it
      finishes processing (required for video; also bypasses the inline cap)
    Returns None if it can't be built.
    """
    if not isinstance(img, (str, Path)):
        return gtypes.Part.from_bytes(data=img, mime_type="image/jpeg")

    path = Path(img)
    mime = _guess_mime(path)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0

    if mime.startswith("video/") or size > _INLINE_LIMIT:
        def _upload_and_wait():
            f = client.files.upload(file=str(path))
            import time as _t
            waited = 0.0
            # Video needs server-side processing before it's usable.
            while getattr(getattr(f, "state", None), "name", "") == "PROCESSING" and waited < 90:
                _t.sleep(2.0)
                waited += 2.0
                f = client.files.get(name=f.name)
            return f
        try:
            return await asyncio.to_thread(_upload_and_wait)
        except Exception as e:
            log.warning(f"Gemini Files API upload failed ({e}); trying inline fallback")
            if size <= _INLINE_LIMIT:
                return gtypes.Part.from_bytes(data=path.read_bytes(), mime_type=mime)
            raise

    return gtypes.Part.from_bytes(data=path.read_bytes(), mime_type=mime)


async def generate_text(
    prompt: str,
    *,
    images: Optional[list[Path | bytes]] = None,
    response_schema: Optional[dict] = None,
    response_mime_type: Optional[str] = None,
    model_chain: Optional[list[str]] = None,
) -> dict:
    """Generate with model fallback chain. Returns {text, model_used, fallback_log}."""
    if not HAS_GENAI:
        raise RuntimeError(_missing_lib_msg())
    client = _client()
    if not client:
        raise RuntimeError("Gemini API key not configured. Set in Settings → API Keys.")

    chain = model_chain or GEMINI_MODELS_CHAIN
    parts: list[Any] = [prompt]
    if images:
        for img in images:
            part = await _build_media_part(client, img)
            if part is not None:
                parts.append(part)

    fallback_log = []
    last_err: Optional[Exception] = None
    for model in chain:
        try:
            cfg = {}
            if response_mime_type and "gemma" not in model.lower():
                cfg["response_mime_type"] = response_mime_type
            if response_schema and "gemma" not in model.lower():
                cfg["response_schema"] = response_schema

            resp = await asyncio.to_thread(
                client.models.generate_content,
                model=model,
                contents=parts,
                config=gtypes.GenerateContentConfig(**cfg) if cfg else None,
            )
            return {
                "text": resp.text or "",
                "model_used": model,
                "fallback_log": fallback_log,
            }
        except Exception as e:
            err_str = str(e)
            fallback_log.append({"model": model, "error": err_str[:200]})
            last_err = e
            low = err_str.lower()
            # Fall back to next model in chain on:
            #   - Quota / rate-limit errors (existing): quota, rate, 429,
            #     permission, key, billing, exhausted
            #   - Server-side transient errors (new): 503/500/502,
            #     unavailable, overload, internal, deadline
            #   - Model-specific errors (new): not_found, not found,
            #     invalid_argument (model name typo / deprecated model
            #     like gemini-3-flash-preview being removed)
            transient_keys = (
                "quota", "rate", "429", "permission", "key", "billing", "exhausted",
                "503", "500", "502", "unavailable", "overload", "internal",
                "deadline", "timeout",
                "not_found", "not found", "404", "invalid_argument",
            )
            if any(k in low for k in transient_keys):
                log.warning(
                    f"Gemini {model} failed ({err_str[:100]}), trying next model..."
                )
                continue
            raise
    raise RuntimeError(f"All Gemini models failed. Last error: {last_err}")


async def describe_image(image_path: str | Path, instruction: Optional[str] = None) -> str:
    """Image → text prompt description (for Image-to-Prompt page)."""
    instruction = instruction or (
        "Describe this image in detail as a cinematic video generation prompt. "
        "Include: subject, action, environment, mood, lighting, camera angle, style. "
        "Output ONE paragraph of English prose, ready for Veo 3 text-to-video."
    )
    result = await generate_text(instruction, images=[Path(image_path)])
    return result["text"].strip()
