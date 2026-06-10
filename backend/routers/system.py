"""System info + update-check + auto-installer endpoints."""
from __future__ import annotations
import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import APP_NAME, APP_VERSION, GITHUB_REPO, IS_FROZEN, OUTPUT_DIR, DATA_DIR, FEEDBACK_FORM_URL
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
        "feedback_url": FEEDBACK_FORM_URL,
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


# ─── First-run setup wizard ────────────────────────────────────────

async def _run_setup_pipeline():
    """Background task: run the first-run wizard, broadcasting progress
    via WS. Exists at module level so asyncio.create_task() in /setup-run
    doesn't tie its lifetime to the HTTP request handler."""
    from ..services.setup_wizard import run_setup

    async def _emit(state: dict) -> None:
        await hub.broadcast("setup_progress", state)

    try:
        await run_setup(on_progress=_emit)
    except Exception as e:
        log.warning(f"Setup pipeline crashed: {e}")
        # run_setup already updated state.error before re-raising


@router.get("/setup-status")
async def setup_status():
    """Return what the wizard needs to do + whether it's already done
    for this version. Frontend hits this on app load — if `all_ready` is
    False and the version marker doesn't match, show the wizard modal."""
    from ..services.setup_wizard import compute_needs, is_setup_complete_for_current_version
    needs = await compute_needs()
    needs["setup_complete_for_current_version"] = is_setup_complete_for_current_version()
    return needs


@router.get("/setup-state")
async def setup_state():
    """Live state snapshot — frontend reattaches to an in-progress
    wizard after a tab reload by reading this."""
    from ..services.setup_wizard import get_setup_state
    return get_setup_state()


@router.post("/setup-run")
async def setup_run():
    """Kick off the wizard pipeline. Rejects if one is already running."""
    from ..services.setup_wizard import get_setup_state
    state = get_setup_state()
    if state["stage"] == "running":
        raise HTTPException(409, "Setup đang chạy rồi")
    asyncio.create_task(_run_setup_pipeline())
    return {"ok": True, "started": True}


# ─── LaMa AI upgrade installer ─────────────────────────────────────

async def _run_lama_install_pipeline():
    """Background task: install LaMa deps + download model, broadcasting
    progress via WS. Lives at module level so the asyncio.create_task() in
    /lama-install doesn't tie its lifetime to the request handler."""
    from ..services.lama_installer import install_lama

    async def _emit(state: dict) -> None:
        await hub.broadcast("lama_install_progress", state)

    try:
        await install_lama(on_progress=_emit)
    except Exception as e:
        log.warning(f"LaMa install pipeline crashed: {e}")
        # _emit already fired by install_lama() before re-raising


@router.get("/lama-install-state")
async def lama_install_state():
    """Snapshot of the in-progress (or last completed) LaMa install.

    Frontend uses this on page mount to reattach to an ongoing install
    after a refresh — same pattern as /update-state for the auto-updater.
    """
    from ..services.lama_installer import get_install_state
    return get_install_state()


@router.post("/lama-install")
async def lama_install():
    """Kick off the LaMa upgrade pipeline as a background task.

    Returns immediately; frontend subscribes to WS `lama_install_progress`
    events for live progress. Rejects with 409 if an install is already
    running so the user doesn't accidentally start two concurrent pip
    invocations (they'd race on the same cache).
    """
    from ..services.lama_installer import get_install_state
    state = get_install_state()
    if state["stage"] in ("detecting", "installing_pip", "downloading_model"):
        raise HTTPException(409, "Install đang chạy rồi")
    asyncio.create_task(_run_lama_install_pipeline())
    return {"ok": True, "started": True}


@router.post("/shutdown")
async def shutdown():
    """Kill the server process. Called from Settings → "Tắt tool".

    Browser tabs only disconnect — they don't kill the backend. Without this
    endpoint, the EXE keeps running in the background after the user closes
    the last tab, hogging port 8000 + RAM. Calls os._exit(0) after a tiny
    delay so the HTTP response flushes first.
    """
    import os
    import asyncio
    log.info("Shutdown requested via /api/system/shutdown — exiting in 0.5s")
    await hub.broadcast("server_shutting_down", {})

    async def _bye():
        await asyncio.sleep(0.5)   # let response flush
        os._exit(0)
    asyncio.create_task(_bye())
    return {"ok": True, "message": "Đang tắt tool..."}


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
