"""System info + update-check + auto-installer endpoints."""
from __future__ import annotations
import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import APP_NAME, APP_VERSION, GITHUB_REPO, IS_FROZEN, OUTPUT_DIR, DATA_DIR
from ..services.updater import (
    check_for_update,
    download_update,
    extract_update,
    apply_update_and_exit,
    get_update_state,
    _UPDATE_LOCK,
)
from ..ws_hub import hub

log = logging.getLogger("navtools.system")
router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/info")
async def info():
    """Static app info."""
    return {
        "app_name": APP_NAME,
        "version": APP_VERSION,
        "frozen": IS_FROZEN,
        "github_repo": GITHUB_REPO,
        "github_url": f"https://github.com/{GITHUB_REPO}",
        "data_dir": str(DATA_DIR),
        "output_dir": str(OUTPUT_DIR),
        "can_auto_install": IS_FROZEN,
    }


@router.get("/check-update")
async def check_update(force: bool = False):
    """Check GitHub releases for a newer version. Cached 5 min."""
    return await check_for_update(force=force)


@router.get("/update-state")
async def update_state():
    """Snapshot of the in-progress (or last completed) update.

    Useful after a page reload mid-download: frontend can call this to
    reattach to an ongoing job and resume showing the progress bar without
    waiting for the next WS tick.
    """
    return get_update_state()


# ─── In-app updater ────────────────────────────────────────────────

async def _run_download_pipeline(download_url: str, asset_name: str | None,
                                 asset_size: int | None, version: str | None):
    """Background task: download → extract → broadcast progress.

    Holds the global _UPDATE_LOCK so only one update can run at a time.
    Broadcasts a single WS event type, `update_progress`, with the full
    state snapshot — frontend only needs one subscription.
    """
    async def _emit(state: dict) -> None:
        await hub.broadcast("update_progress", state)

    async with _UPDATE_LOCK:
        try:
            zip_path = await download_update(
                download_url, asset_name=asset_name,
                expected_size=asset_size, on_progress=_emit,
            )
            await extract_update(zip_path, version=version or "pending",
                                 on_progress=_emit)
            # Final emit so frontend's stage = "ready" reaches the WS even
            # without further activity.
            await _emit(get_update_state())
        except Exception as e:
            log.exception("Update pipeline crashed")
            from ..services.updater import _UPDATE_STATE
            _UPDATE_STATE["stage"] = "error"
            _UPDATE_STATE["error"] = str(e)
            _UPDATE_STATE["message"] = f"Lỗi: {e}"
            await _emit(get_update_state())


@router.post("/start-update")
async def start_update():
    """Kick off background download + extract. Returns immediately.

    The frontend listens to WS `update_progress` events for live progress.
    Refuses if (a) not running as a frozen EXE — dev mode can't self-replace,
    or (b) GitHub didn't expose a .zip asset on the release.
    """
    if not IS_FROZEN:
        raise HTTPException(
            400,
            "Tool đang chạy ở dev mode — auto-update chỉ áp dụng cho bản EXE "
            "đã đóng gói. Cập nhật bằng `git pull` thủ công.",
        )

    info = await check_for_update(force=True)
    if not info.get("update_available"):
        raise HTTPException(400, "Đang ở phiên bản mới nhất rồi")
    url = info.get("download_url")
    if not url:
        raise HTTPException(
            400,
            "Release mới không có file .zip — yêu cầu maintainer upload "
            "asset RedOne-Creative-vX.X.X-win64.zip vào release.",
        )

    # Lock-check: if a download is already running, just acknowledge so
    # the user can still see live progress instead of getting an error.
    state = get_update_state()
    if state["stage"] in ("downloading", "extracting"):
        return {
            "ok": True, "already_running": True, "state": state,
        }

    # Spawn background coroutine — don't await it. Frontend polls via WS.
    asyncio.create_task(_run_download_pipeline(
        url, info.get("asset_name"), info.get("asset_size"), info.get("latest"),
    ))
    return {"ok": True, "started": True, "version": info["latest"]}


@router.post("/apply-update")
async def apply_update():
    """Swap to the staged build and restart. THIS PROCESS DIES.

    Must be called after a successful start-update + extract. Frontend
    detects stage="ready" before showing the "Install & restart" button.
    """
    state = get_update_state()
    if state["stage"] != "ready" or not state.get("extracted_dir"):
        raise HTTPException(
            400,
            f"Chưa có bản update sẵn sàng (stage={state['stage']}). "
            "Bấm 'Tải xuống' trước đã.",
        )

    extracted = Path(state["extracted_dir"])
    if not extracted.exists():
        raise HTTPException(500, f"Thư mục extract đã biến mất: {extracted}")

    # Broadcast one last event so the frontend can show "Đang cài…"
    await hub.broadcast("update_progress", {
        **state, "stage": "installing", "message": "Đang khởi động installer…",
    })

    # Schedule the death after returning the HTTP response. We can't call
    # apply_update_and_exit() synchronously here — uvicorn would never
    # finish sending the response. Use an asyncio task with a tiny delay.
    async def _delayed_exit():
        await asyncio.sleep(0.5)   # let response flush
        try:
            apply_update_and_exit(extracted)
        except Exception as e:
            log.exception("apply_update_and_exit failed")
            await hub.broadcast("update_progress", {
                "stage": "error", "message": str(e),
                "error": str(e), "percent": 0.0,
            })
    asyncio.create_task(_delayed_exit())

    return {"ok": True, "scheduled": True}
