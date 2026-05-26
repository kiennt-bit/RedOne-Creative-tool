"""VertexFlowClient — RedOne tool's commercial Vertex AI mode.

Replaces the Google Labs Flow (free quota) call path with paid Vertex AI
REST API. Models exposed:

    Image gen (Nano Banana via Vertex):
      "nano_banana_2"   → gemini-3.1-flash-image-preview
      "nano_banana_pro" → gemini-3-pro-image-preview

    Video gen (Veo 3.1 via Vertex):
      "lite"    → veo-3.1-lite-generate-001
      "fast"    → veo-3.1-fast-generate-001
      "quality" → veo-3.1-generate-001

    NOT available in Vertex (Labs Flow-only):
      "lite_lp"     — Free low-priority queue, no Vertex equivalent
      "omni_flash"  — Labs internal model, not exposed via Vertex

Unified auth (service account)
===============================
We use **one** auth method for everything: Service Account JSON via
Application Default Credentials. The `google-genai` SDK Client is built
with `project=` and `location=` (the SDK auto-picks up the service
account from `GOOGLE_APPLICATION_CREDENTIALS` env var).

    client = genai.Client(project="...", location="us-central1")
    # Works for BOTH:
    #   client.models.generate_content_stream(...)  ← image gen
    #   client.models.generate_videos(...)          ← video gen

Why not the API key approach?
  - Google's mid-2025 policy requires Vertex API keys to be "bound" to
    a service account, and the UI for that binding is currently buggy
    (Select API restrictions dropdown shows "No items to display" even
    when the service account is correctly selected).
  - Service account auth works without any of that ceremony and gives
    the same access.

So `VERTEX_API_KEY` in private_config.py is now optional/deprecated —
the SDK only needs SERVICE_ACCOUNT_PATH + PROJECT_ID + REGION.

Public API matches FlowClient
==============================
Routers don't branch — they call `make_flow_client()` which returns this
class when auth_mode = "vertex_api". Same method signatures as FlowClient
so generate_video / upload_image / wait_for_completion all "just work".
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("redone.vertex")


# ── Model maps ──────────────────────────────────────────────────────

IMAGE_MODEL_MAP: dict[str, str] = {
    "nano_banana_2":   "gemini-3.1-flash-image-preview",
    "nano_banana_pro": "gemini-3-pro-image-preview",
    # Legacy Labs Flow keys — map to closest Vertex equivalent so old
    # task records still gen something instead of erroring out.
    "imagen_4":        "gemini-3.1-flash-image-preview",
    "nano_banana":     "gemini-3.1-flash-image-preview",
}

VIDEO_MODEL_MAP: dict[str, str] = {
    "lite":    "veo-3.1-lite-generate-001",
    "fast":    "veo-3.1-fast-generate-001",
    "quality": "veo-3.1-generate-001",
}

# Labs Flow models with no Vertex AI equivalent — raise clear error so
# user knows to switch model when working in Vertex mode.
UNAVAILABLE_IN_VERTEX = {
    "lite_lp":    "Veo 3.1 Lite [LP] (free queue) chỉ tồn tại trên Labs Flow consumer. Trong Vertex AI mode, hãy chọn 'Lite' (paid).",
    "omni_flash": "Omni Flash là model nội bộ của Labs Flow, không expose qua Vertex AI. Trong Vertex AI mode, hãy chọn 'Fast' hoặc 'Lite'.",
}


# Aspect ratio maps — Labs Flow uses different terms ("16:9 Landscape")
# vs Vertex AI which wants raw ratios ("16:9").
ASPECT_RATIO_NORMALIZE: dict[str, str] = {
    "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4",
}


class VertexAuthError(Exception):
    """Raised when Vertex AI settings (API key / service account / project)
    are missing or invalid. Routers catch this and surface to UI."""


class VertexFlowClient:
    """RedOne FlowClient variant that calls Vertex AI commercial API.

    Public API mirrors FlowClient — routers don't need to branch.
    """

    def __init__(self, page=None, cookie_path: str = "", account_email: str = ""):
        # `page` and `cookie_path` are accepted for signature compat with
        # FlowClient — both ignored in Vertex mode (we don't drive a browser).
        self._account_email = account_email or "vertex"
        self._token: Optional[str] = "vertex-api-key"  # truthy sentinel
        # Cached SDK clients — re-created when settings change between tasks
        self._image_client = None
        self._video_client = None
        # State expected by FlowClient consumers
        self._last_remaining_credits = None
        self._last_credit_cost = 0
        self._last_model_key = None
        # Read settings lazily on first call so they pick up live edits
        self._settings_loaded = False
        self._api_key: str = ""
        self._sa_path: str = ""
        self._project_id: str = ""
        self._region: str = "us-central1"

    # ── Settings ────────────────────────────────────────────────────

    def _load_settings(self) -> None:
        """Read Vertex AI config — private_config.py FIRST, DB as fallback.

        Priority order:
          1. backend/private_config.py  (baked into EXE at build, never
             committed to git, used by company-internal distribution).
          2. SQLite settings             (user-editable via Settings page,
             for one-off / personal usage).

        This way a single EXE distributed company-wide ships with the
        admin's keys but individual users can still override via UI if
        they want to test with their own GCP project.
        """
        # 1. Try private_config first
        pc_api_key = ""
        pc_sa_path = ""
        pc_project = ""
        pc_region = ""
        try:
            from .. import private_config as _pc  # type: ignore
            pc_api_key = getattr(_pc, "VERTEX_API_KEY", "") or ""
            pc_sa_path = getattr(_pc, "VERTEX_SERVICE_ACCOUNT_PATH", "") or ""
            pc_project = getattr(_pc, "VERTEX_PROJECT_ID", "") or ""
            pc_region  = getattr(_pc, "VERTEX_REGION", "") or ""
            # Skip the "REPLACE_ME" placeholders from the template — treat
            # them as "not set" so DB fallback kicks in.
            if pc_api_key.startswith("AIzaSy-REPLACE"):
                pc_api_key = ""
            if pc_project in ("your-project-id-here", ""):
                pc_project = ""
        except Exception:
            pass  # private_config missing — fall through to DB

        # 2. DB fallback for any field private_config didn't provide
        try:
            from ..database import db
            db_api_key = db.get_setting("vertex_api_key", "") or ""
            db_sa_path = db.get_setting("vertex_service_account_path", "") or ""
            db_project = db.get_setting("vertex_project_id", "") or ""
            db_region  = db.get_setting("vertex_region", "us-central1") or "us-central1"
        except Exception as e:
            log.warning(f"vertex: failed to load DB settings: {e}")
            db_api_key = db_sa_path = db_project = ""
            db_region = "us-central1"

        # Merge — private_config wins per-field; DB fills in the rest.
        self._api_key = pc_api_key or db_api_key
        self._sa_path = pc_sa_path or db_sa_path
        self._project_id = pc_project or db_project
        self._region = pc_region or db_region or "us-central1"
        self._settings_loaded = True

        # Tell logs which source provided each value — helps debug
        # "why is the tool using the wrong project ID" mysteries.
        srcs = []
        if pc_api_key: srcs.append("api_key=pc")
        elif db_api_key: srcs.append("api_key=db")
        if pc_sa_path: srcs.append("sa=pc")
        elif db_sa_path: srcs.append("sa=db")
        if pc_project: srcs.append("project=pc")
        elif db_project: srcs.append("project=db")
        log.debug(f"vertex._load_settings: {' '.join(srcs) or 'no sources configured'}")

    def _require_auth(self) -> None:
        """Validate service account config is present + file exists +
        project_id set. Used by BOTH image and video gen since they
        share the same auth path now."""
        if not self._settings_loaded:
            self._load_settings()
        if not self._sa_path:
            raise VertexAuthError(
                "Vertex AI: chưa cấu hình Service Account JSON. "
                "Settings → Auth mode → Vertex AI → nhập đường dẫn file JSON "
                "service account (download từ Google Cloud Console → IAM → "
                "Service Accounts → KEYS → Add key → JSON). Hoặc admin "
                "điền sẵn trong backend/private_config.py."
            )
        if not Path(self._sa_path).exists():
            raise VertexAuthError(
                f"Vertex AI: file service account không tồn tại tại {self._sa_path!r}. "
                f"Kiểm tra lại đường dẫn trong Settings hoặc private_config.py."
            )
        if not self._project_id:
            raise VertexAuthError(
                "Vertex AI: thiếu Project ID. Settings → nhập Project ID "
                "(xem ở Google Cloud Console góc trên top bar — vd "
                "resonant-forge-497503-e0)."
            )

    # Kept for backwards compatibility — both delegate to the unified
    # _require_auth. (Old code paths may still call these names.)
    _require_image_auth = _require_auth
    _require_video_auth = _require_auth

    # ── SDK client builders ─────────────────────────────────────────

    def _get_client(self):
        """One google-genai client used for BOTH image + video gen.

        Auth: explicit service account credentials loaded from the JSON
        file. We pass `credentials=` directly to genai.Client + force
        `vertexai=True` so the SDK doesn't fall back to AI Studio mode
        (which would demand an api_key).

        Earlier versions relied on the GOOGLE_APPLICATION_CREDENTIALS
        env var, but google-genai sometimes didn't pick it up reliably
        when Client was created from a worker thread — giving the
        cryptic "No API key was provided" error even though service
        account was set. Loading credentials explicitly avoids that
        whole class of bug.
        """
        if self._video_client is not None:
            return self._video_client
        self._require_auth()
        try:
            from google import genai
        except ImportError:
            raise VertexAuthError(
                "Thiếu google-genai SDK. Chạy: pip install --upgrade google-genai"
            )

        # Load service account credentials EXPLICITLY rather than relying
        # on env-var lookup. Add the cloud-platform scope so the same
        # credentials cover Vertex AI predict + Cloud Storage download.
        try:
            from google.oauth2 import service_account
            credentials = service_account.Credentials.from_service_account_file(
                self._sa_path,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        except Exception as e:
            raise VertexAuthError(
                f"Không load được service account JSON tại {self._sa_path!r}: {e}. "
                f"Kiểm tra file có hợp lệ + role 'Agent Platform User'."
            )

        # Still set the env var as a belt-and-suspenders — some SDK code
        # paths read it independent of the Client we hand them.
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = self._sa_path

        client = genai.Client(
            vertexai=True,
            project=self._project_id,
            location=self._region,
            credentials=credentials,
        )
        # Cache on both legacy attributes so old _get_image_client /
        # _get_video_client callers (if any) hit the same instance.
        self._video_client = client
        self._image_client = client
        return client

    # Old names — both delegate to the unified _get_client.
    _get_image_client = _get_client
    _get_video_client = _get_client

    # ── Auth / token ────────────────────────────────────────────────

    async def ensure_token(self) -> None:
        """No-op for Vertex AI — auth happens via SDK Client construction.
        Surfaces config errors early so routers see them at task start."""
        # _require_auth checks service account + project_id and raises
        # VertexAuthError with a clear Vietnamese message if missing.
        self._require_auth()

    async def renew_token(self) -> None:
        """No-op — Vertex AI SDK handles token refresh internally."""

    async def get_recaptcha_token(self, action: str = "VIDEO_GENERATION") -> str:
        """No-op — Vertex AI doesn't use reCAPTCHA."""
        return ""

    async def close(self) -> None:
        """No-op — SDK clients hold no persistent connections."""

    # ── Image upload (pass-through) ─────────────────────────────────

    async def upload_image(self, image_path: str) -> Optional[str]:
        """In Vertex mode we don't upload to a remote ID server. Just
        return the local path as a synthetic "media_id" — generate_video
        and generate_image read the file directly when needed.
        """
        path = Path(image_path)
        if not path.exists():
            log.error(f"vertex.upload_image: file missing {image_path}")
            return None
        return str(path)

    # ── Image generation ────────────────────────────────────────────

    async def generate_image(
        self,
        prompt: str,
        model_key: str = "nano_banana_2",
        aspect_ratio: str = "1:1",
        reference_images: Optional[list[str]] = None,
        seed: Optional[int] = None,
    ) -> dict:
        """Generate via Gemini image-capable model.

        Returns the same shape FlowClient does:
            {
              "download_url": "<local file URL or path>",
              "media_id":     "<our synthetic id>",
              "width":        None,   # Vertex doesn't report dims
              "height":       None,
            }
        """
        await self.ensure_token()
        model_id = IMAGE_MODEL_MAP.get(model_key)
        if not model_id:
            raise ValueError(
                f"Vertex AI: model '{model_key}' không hỗ trợ cho image gen. "
                f"Models available: {list(IMAGE_MODEL_MAP.keys())}"
            )
        self._last_model_key = model_id

        from google.genai import types as gtypes

        # Build content parts: each reference image + the text prompt.
        parts: list[Any] = []
        for ref_path in (reference_images or []):
            if not ref_path or not Path(ref_path).exists():
                continue
            try:
                img_bytes = Path(ref_path).read_bytes()
                mime = _guess_mime(ref_path)
                parts.append(gtypes.Part.from_bytes(data=img_bytes, mime_type=mime))
            except Exception as e:
                log.warning(f"vertex: skipped ref image {ref_path}: {e}")
        parts.append(gtypes.Part.from_text(text=prompt))

        # Aspect ratio: clamp to a known value (Vertex picks "auto" if invalid).
        ar = ASPECT_RATIO_NORMALIZE.get(aspect_ratio, "auto")

        config = gtypes.GenerateContentConfig(
            temperature=1.0,
            top_p=0.95,
            max_output_tokens=32768,
            response_modalities=["TEXT", "IMAGE"],
            safety_settings=[
                gtypes.SafetySetting(category=c, threshold="OFF")
                for c in (
                    "HARM_CATEGORY_HATE_SPEECH",
                    "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    "HARM_CATEGORY_HARASSMENT",
                )
            ],
            image_config=gtypes.ImageConfig(
                aspect_ratio=ar,
                image_size="1K",   # 1K is default; Pro can do up to 4K
                output_mime_type="image/png",
            ),
        )

        contents = [gtypes.Content(role="user", parts=parts)]
        client = self._get_image_client()

        log.info(
            f"vertex.generate_image: model={model_id}, ar={ar}, "
            f"refs={len(reference_images or [])}"
        )
        # SDK call is blocking → run in thread
        def _do_call() -> bytes:
            image_bytes = b""
            for chunk in client.models.generate_content_stream(
                model=model_id, contents=contents, config=config,
            ):
                # Each chunk's candidate parts may contain inline_data (image)
                # or text. We only want the image bytes.
                if not chunk.candidates:
                    continue
                for part in chunk.candidates[0].content.parts or []:
                    inline = getattr(part, "inline_data", None)
                    if inline and inline.data:
                        image_bytes += inline.data
            return image_bytes

        try:
            image_bytes = await asyncio.to_thread(_do_call)
        except Exception as e:
            log.exception(f"vertex.generate_image failed for model={model_id}")
            raise RuntimeError(f"Vertex AI image gen lỗi: {e}")

        if not image_bytes:
            raise RuntimeError(
                "Vertex AI trả về response không có image bytes. "
                "Có thể safety filter chặn — thử prompt khác."
            )

        # Save to the standard output dir so frontend's /files URL works.
        from ..config import OUTPUT_DIR
        day = time.strftime("%Y-%m-%d")
        out_dir = OUTPUT_DIR / "image" / day / "vertex"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"vertex_{uuid.uuid4().hex[:12]}.png"
        out_path.write_bytes(image_bytes)
        log.info(f"vertex.generate_image: saved {len(image_bytes)} bytes → {out_path}")

        return {
            "download_url": f"/files/{out_path.relative_to(OUTPUT_DIR).as_posix()}",
            "media_id":     str(out_path),
            "width":        None,
            "height":       None,
            "path":         str(out_path),
        }

    async def download_image(self, url: str, output_path: str) -> bool:
        """In Vertex mode, generate_image already saved the file. If the
        caller has `download_url` it can just copy/move — but the existing
        routers call `download_image(result['download_url'], target)` so
        we honour that: copy the file from media_id (which IS the path) to
        the requested output_path.

        `url` here is actually the same as media_id in our Vertex flow.
        """
        # Resolve "url" back to a local path. We saved the file in
        # generate_image; the URL was just `/files/<rel>`. Convert back.
        try:
            from ..config import OUTPUT_DIR
            if url.startswith("/files/"):
                src = OUTPUT_DIR / url[len("/files/"):]
            else:
                src = Path(url)
            if not src.exists():
                log.error(f"vertex.download_image: source file missing {src}")
                return False
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            if str(src) != str(output_path):
                import shutil
                shutil.copy2(src, output_path)
            return True
        except Exception as e:
            log.error(f"vertex.download_image failed: {e}")
            return False

    # ── Video generation ────────────────────────────────────────────

    async def generate_video(
        self,
        prompt: str,
        model_key: str = "fast",
        aspect_ratio: str = "16:9",
        reference_image: Optional[str] = None,
        duration: int = 8,
    ) -> str:
        """Submit Veo video gen job. Returns operation NAME (string) which
        is then polled by wait_for_completion.

        `reference_image` is the local file path (returned from upload_image).
        If provided, runs as I2V; otherwise T2V.
        """
        await self.ensure_token()

        # Block unsupported Labs Flow-only models with a clear message
        if model_key in UNAVAILABLE_IN_VERTEX:
            raise ValueError(UNAVAILABLE_IN_VERTEX[model_key])

        model_id = VIDEO_MODEL_MAP.get(model_key)
        if not model_id:
            raise ValueError(
                f"Vertex AI: video model '{model_key}' không hỗ trợ. "
                f"Models available: {list(VIDEO_MODEL_MAP.keys())} "
                f"(lite/fast/quality)."
            )
        self._last_model_key = model_id

        from google.genai import types as gtypes

        # Build source: prompt + optional starting image (I2V)
        source_kwargs: dict[str, Any] = {"prompt": prompt}
        if reference_image:
            ref_path = Path(reference_image)
            if ref_path.exists():
                try:
                    img_bytes = ref_path.read_bytes()
                    mime = _guess_mime(reference_image)
                    source_kwargs["image"] = gtypes.Image(
                        image_bytes=img_bytes, mime_type=mime,
                    )
                except Exception as e:
                    log.warning(
                        f"vertex.generate_video: skipped ref image "
                        f"{reference_image}: {e}"
                    )

        source = gtypes.GenerateVideosSource(**source_kwargs)

        # Aspect ratio: Vertex AI Veo supports "16:9" and "9:16"
        ar = aspect_ratio if aspect_ratio in ("16:9", "9:16") else "16:9"

        config = gtypes.GenerateVideosConfig(
            aspect_ratio=ar,
            number_of_videos=1,
            duration_seconds=max(4, min(int(duration or 8), 8)),
            person_generation="allow_all",
            generate_audio=True,
            resolution="720p",   # safer/cheaper default; could expose later
            seed=0,
        )

        client = self._get_video_client()

        log.info(
            f"vertex.generate_video: model={model_id}, ar={ar}, "
            f"duration={config.duration_seconds}, i2v={bool(reference_image)}"
        )

        def _do_call():
            return client.models.generate_videos(
                model=model_id, source=source, config=config,
            )

        try:
            operation = await asyncio.to_thread(_do_call)
        except Exception as e:
            log.exception(f"vertex.generate_video submit failed (model={model_id})")
            raise RuntimeError(f"Vertex AI video gen submit lỗi: {e}")

        # Stash the live operation handle so wait_for_completion can poll it.
        # FlowClient returns a workflow_id string; the operation .name field
        # serves the same purpose and lets us reconstruct it later.
        op_name = getattr(operation, "name", None) or str(uuid.uuid4())
        # Cache the actual op object — we'll reuse it for polling instead of
        # rebuilding from name (faster + no extra API call).
        if not hasattr(self, "_pending_ops"):
            self._pending_ops: dict[str, Any] = {}
        self._pending_ops[op_name] = operation
        log.info(f"vertex.generate_video: submitted, operation={op_name}")
        return op_name

    async def wait_for_completion(self, workflow: str, timeout: int = 600) -> dict:
        """Poll Vertex operation until done. Returns dict shaped like
        Labs Flow's:
            {
              "state": "SUCCEEDED" | "FAILED",
              "name":  <media_id our side — local file path>,
              "media_id": <same>,
              "video_id": <same>,
              "error": "..." (only if failed),
            }
        """
        client = self._get_video_client()
        operation = getattr(self, "_pending_ops", {}).get(workflow)
        if operation is None:
            # No cached handle — try to construct from name. Some SDK
            # versions accept a string here; others need the full op.
            # Fall back to error so user retries.
            return {"state": "FAILED", "error": f"Lost operation handle for {workflow}"}

        log.info(f"vertex.wait_for_completion: polling {workflow}...")
        started = time.time()
        poll_count = 0
        while True:
            if (time.time() - started) > timeout:
                return {
                    "state": "FAILED",
                    "error": f"Timeout sau {timeout}s khi đợi video — Veo có thể đang quá tải, retry sau.",
                }
            poll_count += 1
            await asyncio.sleep(10)
            try:
                operation = await asyncio.to_thread(
                    client.operations.get, operation,
                )
            except Exception as e:
                log.warning(f"vertex poll error (try {poll_count}): {e}")
                continue
            if getattr(operation, "done", False):
                break

        # Operation finished — extract response
        response = getattr(operation, "response", None) or getattr(operation, "result", None)
        if response is None:
            err = getattr(operation, "error", None)
            err_msg = str(err) if err else "Veo trả về response trống"
            log.error(f"vertex.wait_for_completion: failed — {err_msg}")
            return {"state": "FAILED", "error": err_msg}

        # Save the first generated video to outputs and return its local path
        # as the "media_id" so download_to can find it.
        videos = getattr(response, "generated_videos", None) or []
        if not videos:
            return {"state": "FAILED", "error": "Veo response không có video nào"}

        video = videos[0].video
        from ..config import OUTPUT_DIR
        day = time.strftime("%Y-%m-%d")
        out_dir = OUTPUT_DIR / "video" / day / "vertex"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"vertex_{uuid.uuid4().hex[:12]}.mp4"

        try:
            # SDK Video objects expose .save(path) and .video_bytes
            if hasattr(video, "save"):
                await asyncio.to_thread(video.save, str(out_path))
            elif hasattr(video, "video_bytes"):
                out_path.write_bytes(video.video_bytes)
            else:
                # Fallback: try the GCS URI download (some SDK shapes use this)
                gcs = getattr(video, "uri", None) or getattr(video, "gcs_uri", None)
                if gcs:
                    await self._download_gcs(gcs, out_path)
                else:
                    return {"state": "FAILED", "error": "Không đọc được video bytes từ Veo response"}
        except Exception as e:
            log.exception("vertex: video save failed")
            return {"state": "FAILED", "error": f"Lỗi lưu video: {e}"}

        # Clean up cached op handle now that we've consumed it
        try:
            del self._pending_ops[workflow]
        except (AttributeError, KeyError):
            pass

        log.info(f"vertex.wait_for_completion: saved → {out_path}")
        # Return shape FlowClient consumers expect
        return {
            "state":    "SUCCEEDED",
            "name":     str(out_path),
            "media_id": str(out_path),
            "video_id": str(out_path),
        }

    async def _download_gcs(self, gcs_uri: str, output_path: Path) -> None:
        """Fallback: download a gs://bucket/object URI using the service
        account's storage role."""
        try:
            from google.cloud import storage   # type: ignore
        except ImportError:
            raise RuntimeError(
                "google-cloud-storage chưa cài. Veo trả về GCS URI mà tool "
                "không download được. Chạy: pip install google-cloud-storage"
            )
        # Parse gs://bucket/path/to/object
        if not gcs_uri.startswith("gs://"):
            raise ValueError(f"Not a GCS URI: {gcs_uri}")
        path = gcs_uri[5:]
        bucket_name, _, blob_path = path.partition("/")

        def _download():
            client = storage.Client.from_service_account_json(self._sa_path)
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(blob_path)
            blob.download_to_filename(str(output_path))

        await asyncio.to_thread(_download)
        log.info(f"vertex._download_gcs: {gcs_uri} → {output_path}")

    async def download_to(self, media_id: str, output_path: str) -> bool:
        """In Vertex mode, `media_id` IS the local file path (we saved
        the video in wait_for_completion). Just copy/move to where the
        router asked.
        """
        try:
            src = Path(media_id)
            if not src.exists():
                log.error(f"vertex.download_to: source missing {src}")
                return False
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            if str(src) != str(output_path):
                import shutil
                shutil.copy2(src, output_path)
            return True
        except Exception as e:
            log.error(f"vertex.download_to failed: {e}")
            return False

    # ── Credits ─────────────────────────────────────────────────────

    async def check_credits(self) -> Optional[dict]:
        """Vertex AI uses pay-per-call billing, not credits. We can't show
        a "remaining credits" number — direct user to GCP billing console.

        Returns a placeholder dict so the accounts page still shows
        SOMETHING (and credit_fetch_ok=True so UI doesn't flag the
        account dead)."""
        # Could query Cloud Billing API for budget alerts, but that's
        # another scope of permissions. For v1, just signal "alive".
        return {
            "remainingCredits": None,
            "info": "Vertex AI uses pay-per-call billing — xem chi tiết tại Google Cloud Console → Billing",
        }

    # ── Stubs for features not in Vertex ────────────────────────────

    async def upscale_image(self, media_id: str, resolution: str = "4k") -> dict:
        """Vertex AI Imagen has an upscale endpoint, but Gemini-Image
        (Nano Banana) doesn't. For Pro tier, just regen at 4K. For now
        we surface a clear "not supported" error."""
        raise NotImplementedError(
            "Upscale chưa support trong Vertex AI mode. Để upscale 2K/4K, "
            "dùng Nano Banana Pro với image_size='4K' khi gen lại (cần code "
            "future enhancement)."
        )

    async def extend_video(
        self,
        prompt: str,
        media_id: str,
        workflow_id: str,
        model_key: str,
        aspect_ratio: str,
    ) -> str:
        """Veo on Vertex doesn't have a public "extend video" endpoint
        like Labs Flow does. Workaround: gen new video using last frame
        of previous as the I2V starting image (manual chain). Not done in
        v1 — surface error."""
        raise NotImplementedError(
            "Extend video (nối video dài) chưa support trong Vertex AI mode. "
            "Labs Flow có endpoint riêng cho extend, Vertex AI chỉ gen 1 đoạn "
            "8s. Để làm video dài, dùng Auth mode = Extension/Playwright."
        )


# ── Helpers ─────────────────────────────────────────────────────────

def _guess_mime(path: str) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif":  "image/gif",
    }.get(suffix, "image/jpeg")
