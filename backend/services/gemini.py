"""Gemini API wrapper with model fallback chain."""
from __future__ import annotations
import asyncio
import base64
import logging
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
            if isinstance(img, (str, Path)):
                data = Path(img).read_bytes()
            else:
                data = img
            parts.append(gtypes.Part.from_bytes(
                data=data,
                mime_type="image/jpeg",
            ))

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
            if any(k in err_str.lower() for k in ["quota", "rate", "429", "permission", "key", "billing", "exhausted"]):
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
