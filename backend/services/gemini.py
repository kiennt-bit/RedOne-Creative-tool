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

log = logging.getLogger("redone.gemini")

try:
    from google import genai
    from google.genai import types as gtypes
    HAS_GENAI = True
except Exception:
    HAS_GENAI = False


def parse_prompt_list(text: str, limit: Optional[int] = None) -> list:
    """Robustly turn a model response into a clean list of prompt strings.

    Handles ```json fences, leading/trailing prose (extracts the [...] slice),
    and a cleaned line-split fallback that drops bracket/punctuation-only lines
    (the cause of stray "[" / "]" "prompts"). Filters out junk shorter than 8
    chars and truncates to `limit` so the model over-generating (e.g. 13 when
    10 was asked) doesn't leak extra/empty scenes.
    """
    import json as _json
    import re as _re
    s = _re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", (text or "").strip())
    out: list = []
    candidates = [s]
    lb, rb = s.find("["), s.rfind("]")
    if lb != -1 and rb > lb:
        candidates.append(s[lb:rb + 1])
    for cand in candidates:
        try:
            parsed = _json.loads(cand)
        except Exception:
            continue
        if isinstance(parsed, list):
            out = [str(x).strip() for x in parsed if str(x).strip()]
            break
        if isinstance(parsed, dict):
            for v in parsed.values():
                if isinstance(v, list):
                    out = [str(x).strip() for x in v if str(x).strip()]
                    break
            if out:
                break
    if not out:
        # Fallback: one prompt per line, stripping wrapping quotes/commas and
        # skipping bracket/punctuation-only lines.
        for ln in s.splitlines():
            t = ln.strip().strip(",").strip().strip('"').strip("'").strip()
            if len(t) >= 8:
                out.append(t)
    out = [p for p in out if len(p.strip()) >= 8]
    if limit and len(out) > limit:
        out = out[:limit]
    return out


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


class GeminiAllKeysExhaustedError(RuntimeError):
    """Every configured Gemini API key is out of quota or unusable.

    Raised by generate_text() after it has rotated through ALL keys and each
    one hit a quota / dead-key error. Carries a clear, user-facing message so
    the calling endpoint can surface it as-is."""


# ── Error classification (drives key-rotation vs model-fallback) ─────
# A failed generate_content can mean three different things, each handled
# differently:
#   • "quota"            → this key is rate/quota limited → rotate to next KEY
#   • "key_dead"         → this key is invalid/expired/unauthenticated → rotate
#   • "model_transient"  → model unavailable / 5xx / bad model id → next MODEL
#                          (same key — rotating keys won't fix a model issue)
#   • "hard"             → anything else (real bug, bad request) → raise now
_QUOTA_MARKERS = (
    "quota", "429", "resource_exhausted", "resource exhausted", "exhausted",
    "rate limit", "rate_limit", "ratelimit", "too many requests", "billing",
)
_KEY_DEAD_MARKERS = (
    "api key not valid", "api_key_invalid", "invalid api key", "api key expired",
    "expired api key", "unauthenticated", "401",
)
_MODEL_TRANSIENT_MARKERS = (
    "503", "500", "502", "unavailable", "overload", "internal", "deadline",
    "timeout", "not_found", "not found", "404", "invalid_argument",
    "permission", "403",
)


def _classify_gemini_error(err_str: str) -> str:
    low = (err_str or "").lower()
    if any(k in low for k in _QUOTA_MARKERS):
        return "quota"
    if any(k in low for k in _KEY_DEAD_MARKERS):
        return "key_dead"
    if any(k in low for k in _MODEL_TRANSIENT_MARKERS):
        return "model_transient"
    return "hard"


class _KeyExhausted(Exception):
    """Internal: a single key failed its whole model chain on quota/dead-key
    errors → the caller should rotate to the next key. Carries the last raw
    error for the final user message."""
    def __init__(self, last_err):
        self.last_err = last_err
        super().__init__(str(last_err))


def get_api_keys() -> list[str]:
    """All usable Gemini API keys, in rotation order, de-duplicated.

    Sources (merged): the multi-key list `gemini_api_keys` (settings) → the
    legacy single `gemini_api_key` (settings) → the GEMINI_API_KEY env var.
    Lets old single-key installs keep working while enabling the new
    multi-key rotation."""
    keys: list[str] = []

    def _add(v):
        if isinstance(v, str):
            v = v.strip()
            if v and v not in keys:
                keys.append(v)

    multi = db.get_setting("gemini_api_keys")
    if isinstance(multi, list):
        for k in multi:
            _add(k)
    elif isinstance(multi, str):
        # tolerate a newline/comma-separated string
        import re as _re
        for k in _re.split(r"[\n,]", multi):
            _add(k)
    _add(db.get_setting("gemini_api_key"))
    _add(os.environ.get("GEMINI_API_KEY"))
    return keys


def get_api_key() -> Optional[str]:
    """First usable Gemini API key (back-compat for any single-key caller)."""
    keys = get_api_keys()
    return keys[0] if keys else None


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


async def _run_model_chain(
    client, chain, parts, *, response_mime_type, response_schema,
    system_instruction, fallback_log,
) -> dict:
    """Try each model in `chain` with one client/key. Returns the result dict
    on the first success.

    Raises:
      • _KeyExhausted — every model failed and ≥1 failure was a quota/dead-key
        error → the caller should rotate to the NEXT API key.
      • the underlying exception — a hard error (raised immediately) or an
        all-models-transient failure (rotating keys wouldn't help).
    """
    last_err: Optional[Exception] = None
    saw_rotate_signal = False
    for model in chain:
        try:
            is_gemma = "gemma" in model.lower()
            cfg = {}
            if response_mime_type and not is_gemma:
                cfg["response_mime_type"] = response_mime_type
            if response_schema and not is_gemma:
                cfg["response_schema"] = response_schema

            # System instruction: Gemini supports the dedicated field; Gemma
            # doesn't, so fold it into the prompt text for those models.
            contents = parts
            if system_instruction:
                if is_gemma:
                    contents = [f"{system_instruction}\n\n{parts[0]}", *parts[1:]]
                else:
                    cfg["system_instruction"] = system_instruction

            resp = await asyncio.to_thread(
                client.models.generate_content,
                model=model,
                contents=contents,
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
            kind = _classify_gemini_error(err_str)
            if kind in ("quota", "key_dead"):
                saw_rotate_signal = True
                log.warning(f"Gemini {model}: key-limited ({err_str[:90]}) → next model/key")
                continue
            if kind == "model_transient":
                log.warning(f"Gemini {model}: transient ({err_str[:90]}) → next model")
                continue
            raise  # hard error — surface immediately
    # Whole chain failed for this key.
    if saw_rotate_signal:
        raise _KeyExhausted(last_err)
    raise last_err if last_err else RuntimeError("All Gemini models failed")


async def generate_text(
    prompt: str,
    *,
    images: Optional[list[Path | bytes]] = None,
    response_schema: Optional[dict] = None,
    response_mime_type: Optional[str] = None,
    model_chain: Optional[list[str]] = None,
    system_instruction: Optional[str] = None,
) -> dict:
    """Generate text, rotating across API keys + falling back across models.

    Returns {text, model_used, fallback_log, key_index}.

    Two nested loops:
      • OUTER over every configured API key (get_api_keys). When a key's whole
        model chain fails on quota / dead-key, rotate to the next key.
      • INNER over the model chain (_run_model_chain) for the current key.

    When ALL keys are quota-exhausted, raises GeminiAllKeysExhaustedError with a
    precise Vietnamese message so the user knows to add a key or wait for reset.
    `system_instruction` (a ported Gemini Gem persona) goes via the dedicated
    Gemini config field; Gemma models get it prepended to the prompt instead.
    """
    if not HAS_GENAI:
        raise RuntimeError(_missing_lib_msg())
    keys = get_api_keys()
    if not keys:
        raise RuntimeError(
            "Chưa cấu hình Gemini API key. Vào Cài đặt → API Keys để thêm "
            "(có thể thêm nhiều key để tự xoay vòng khi hết quota)."
        )

    chain = model_chain or GEMINI_MODELS_CHAIN
    fallback_log: list = []
    last_rotate_err: Optional[Exception] = None
    n = len(keys)

    for ki, key in enumerate(keys):
        try:
            client = genai.Client(api_key=key)
        except Exception as e:
            last_rotate_err = e
            fallback_log.append({"key_index": ki, "error": f"client init: {str(e)[:120]}"})
            log.warning(f"Gemini key #{ki + 1}/{n}: client init failed ({str(e)[:90]})")
            continue

        # Media parts are key-scoped (Files API uploads live in the key's
        # project) → rebuild per key. Cheap for the common no-image / inline
        # case; only re-uploads on an actual key rotation.
        parts: list[Any] = [prompt]
        if images:
            for img in images:
                part = await _build_media_part(client, img)
                if part is not None:
                    parts.append(part)

        try:
            result = await _run_model_chain(
                client, chain, parts,
                response_mime_type=response_mime_type,
                response_schema=response_schema,
                system_instruction=system_instruction,
                fallback_log=fallback_log,
            )
            result["key_index"] = ki
            return result
        except _KeyExhausted as ke:
            last_rotate_err = ke.last_err
            if n > 1:
                log.warning(f"Gemini API key #{ki + 1}/{n} hết quota → chuyển key kế tiếp")
            continue
        # Any other exception (hard error / all-transient) propagates as-is.

    # Reached only when EVERY key rotated out on quota / dead-key.
    prefix = f"Tất cả {n} Gemini API key" if n > 1 else "Gemini API key"
    raise GeminiAllKeysExhaustedError(
        f"{prefix} đều đã hết hạn mức (quota) hoặc không dùng được. "
        f"→ Vào Cài đặt thêm API key mới, hoặc đợi Google reset quota "
        f"(bản free reset theo ngày). Lỗi cuối: {str(last_rotate_err)[:200]}"
    )


async def describe_image(image_path: str | Path, instruction: Optional[str] = None) -> str:
    """Image → text prompt description (for Image-to-Prompt page)."""
    instruction = instruction or (
        "Describe this image in detail as a cinematic video generation prompt. "
        "Include: subject, action, environment, mood, lighting, camera angle, style. "
        "Output ONE paragraph of English prose, ready for Veo 3 text-to-video."
    )
    result = await generate_text(instruction, images=[Path(image_path)])
    return result["text"].strip()
