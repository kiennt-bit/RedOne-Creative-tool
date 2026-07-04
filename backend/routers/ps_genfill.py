"""Photoshop Generative Fill endpoint.

Receives an image + mask (selection) + prompt from the Photoshop CEP panel,
uploads both to Google Flow via the Chrome extension bridge, then calls
generate_image_with_mask() to fill the masked region with AI-generated content.

Returns the result image as base64 for the Photoshop panel to display + apply.
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse

from ..config import OUTPUT_DIR
from ..database import db

log = logging.getLogger("redone.ps_genfill")
router = APIRouter(prefix="/api/ps-genfill", tags=["ps-genfill"])


def _pick_account() -> Optional[dict]:
    """Pick the best available account (highest credits)."""
    accounts = [a for a in db.get_accounts() if a["enabled"]]
    accounts.sort(key=lambda a: -(a.get("credit") or 0))
    if accounts:
        return accounts[0]
    from ..services.flow_factory import is_vertex_mode, synthetic_vertex_account
    if is_vertex_mode():
        return synthetic_vertex_account()
    return None


async def _save_upload_to_temp(data: bytes, suffix: str = ".png") -> Path:
    """Save uploaded bytes to a temp file and return the path."""
    tmp = Path(tempfile.mkdtemp(prefix="redone_genfill_"))
    path = tmp / f"upload{suffix}"
    await asyncio.to_thread(path.write_bytes, data)
    return path


def _ensure_mask_format(mask_bytes: bytes) -> bytes:
    """Ensure mask is a proper black/white PNG.

    Photoshop selection → white = selected area (to fill), black = keep.
    Flow API expects the same convention.
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(mask_bytes))
        # Convert to grayscale if not already
        if img.mode != "L":
            img = img.convert("L")
        # Threshold to pure black/white
        img = img.point(lambda x: 255 if x > 127 else 0)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        log.warning(f"Mask format conversion failed ({e}), using raw bytes")
        return mask_bytes


@router.post("/generate")
async def generate_genfill(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: str = Form(...),
    model: str = Form("nano_banana_pro"),
):
    """Generate fill for a masked region of an image.

    Accepts multipart form data:
      - image: The source image (PNG/JPEG)
      - mask: The mask image (PNG, white = area to fill, black = keep)
      - prompt: Text description of what to generate
      - model: nano_banana_pro | nano_banana_2

    Returns JSON with base64-encoded result image.
    """
    acc = _pick_account()
    if not acc:
        raise HTTPException(status_code=503, detail="Không có tài khoản khả dụng. Kiểm tra tab Tài Khoản.")

    # Read uploaded files
    image_bytes = await image.read()
    mask_bytes = await mask.read()

    if len(image_bytes) < 100:
        raise HTTPException(status_code=400, detail="Image file quá nhỏ hoặc rỗng")
    if len(mask_bytes) < 100:
        raise HTTPException(status_code=400, detail="Mask file quá nhỏ hoặc rỗng")

    # Validate model
    valid_models = {"nano_banana_pro", "nano_banana_2", "imagen_4"}
    if model not in valid_models:
        raise HTTPException(status_code=400, detail=f"Model không hợp lệ. Chọn: {', '.join(valid_models)}")

    # Ensure mask is proper format
    mask_bytes = _ensure_mask_format(mask_bytes)

    # Save to temp files for the FlowClient upload_image method
    image_path = await _save_upload_to_temp(image_bytes, ".png")
    mask_path = await _save_upload_to_temp(mask_bytes, ".png")

    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account

        page = await get_page_for_account(acc)
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )

        log.info(f"[ps-genfill] Starting: prompt='{prompt[:60]}', model={model}, "
                 f"image={len(image_bytes)}B, mask={len(mask_bytes)}B")

        # Upload image and mask to Flow
        await client.ensure_token()

        base_media_id = await client.upload_image(str(image_path))
        if not base_media_id:
            raise HTTPException(status_code=500, detail="Upload ảnh gốc thất bại")

        mask_media_id = await client.upload_image(str(mask_path))
        if not mask_media_id:
            raise HTTPException(status_code=500, detail="Upload mask thất bại")

        log.info(f"[ps-genfill] Uploaded: base={base_media_id}, mask={mask_media_id}")

        # Generate with mask
        result = await client.generate_image_with_mask(
            prompt=prompt,
            base_image_id=base_media_id,
            mask_image_id=mask_media_id,
            model_key=model,
        )

        # Download the result image
        download_url = result.get("download_url", "")
        if not download_url:
            raise HTTPException(status_code=500, detail="Không có URL kết quả từ Flow API")

        import httpx
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as http:
            resp = await http.get(download_url)
            if resp.status_code != 200 or len(resp.content) < 500:
                raise HTTPException(
                    status_code=500,
                    detail=f"Download kết quả thất bại (HTTP {resp.status_code})",
                )
            result_bytes = resp.content

        # Also save to outputs for reference
        out_dir = OUTPUT_DIR / "ps_genfill"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_name = f"genfill_{int(time.time())}.png"
        out_path = out_dir / out_name
        await asyncio.to_thread(out_path.write_bytes, result_bytes)

        # Return as base64
        result_b64 = base64.b64encode(result_bytes).decode("utf-8")

        log.info(f"[ps-genfill] Done: {result.get('media_id', '?')} "
                 f"({result.get('width', '?')}x{result.get('height', '?')}), "
                 f"saved to {out_path}")

        return {
            "ok": True,
            "image_base64": result_b64,
            "media_id": result.get("media_id"),
            "width": result.get("width"),
            "height": result.get("height"),
            "seed": result.get("seed"),
            "output_path": str(out_path),
        }

    except fc_mod.SessionDeadError as sde:
        log.warning(f"[ps-genfill] Session dead: {sde}")
        raise HTTPException(status_code=401, detail=f"Session hết hạn: {sde.reason}")
    except ValueError as ve:
        log.error(f"[ps-genfill] Generation error: {ve}")
        raise HTTPException(status_code=500, detail=str(ve))
    except HTTPException:
        raise
    except Exception as ex:
        log.error(f"[ps-genfill] Unexpected error: {ex}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Lỗi: {str(ex)}")
    finally:
        # Cleanup temp files
        for p in [image_path, mask_path]:
            try:
                if p.exists():
                    p.unlink()
                if p.parent.exists():
                    p.parent.rmdir()
            except Exception:
                pass


@router.get("/health")
async def genfill_health():
    """Health check for the Photoshop panel to verify connectivity."""
    acc = _pick_account()
    return {
        "ok": True,
        "has_account": acc is not None,
        "account_email": acc["email"] if acc else None,
    }
