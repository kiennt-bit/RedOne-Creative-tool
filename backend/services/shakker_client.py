"""ShakkerClient — talks to shakker.ai (Liblib AI) image-generation API.

Reverse-engineered from HAR captures (see docs/shakker_capture/api_notes.md).
Auth is a single 44-char hex `token` header per account; no cookies, no
Bearer/JWT. Validated working server-side from Python (no Cloudflare block).

Pipeline for one image:

    submit_generate(payload) -> generateId          POST /gen/tool/shake
    get_status(generateId)   -> {state, images...}   POST /generate/progress/msg/v1/{id}
    download_result(url)     -> bytes                 GET  <cdn url>

Catalog:
    list_models(search)      checkpoints (modelType=CHECKPOINT)
    list_loras(search)       LoRAs       (modelType=LORA)

Reference image (img2img):
    upload_reference_image(bytes) -> cdn_url          STS + Alibaba OSS PUT

Engine is Stable-Diffusion-style (FLUX.1 default "Shakker Zeno-1"). Default
sampler/steps/cfg mirror what the shakker web UI sends.

This client is intentionally NOT a drop-in for FlowClient — Shakker is a
separate provider with its own router (routers/shakker.py), so we keep the
surface explicit rather than forcing it through the make_flow_client shim.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import string
import time
from typing import Any, Optional

import httpx

log = logging.getLogger("redone.shakker")


# ── Constants ───────────────────────────────────────────────────────

BASE_URL = "https://www.shakker.ai"

# Default checkpoint — "Shakker Zeno-1" (FLUX.1 based). versionId observed
# in every capture. baseType 19 = FLUX.1 family.
DEFAULT_CHECKPOINT_ID = 1508012
DEFAULT_BASE_TYPE = 19

# Default negative prompt the shakker UI auto-applies in simple mode.
DEFAULT_NEG_PROMPT = (
    ",bad quality, poor quality, doll, disfigured, jpg, toy, bad anatomy, "
    "missing limbs, missing fingers, 3d, cgi"
)

# Engine generation dimensions per aspect ratio. Shakker targets ~1.05 MP.
# 1:1 and 16:9 are taken directly from captures; the rest are computed to
# the same pixel budget rounded to multiples of 16. May need tuning after a
# real capture of each ratio, but FLUX accepts any /8 dims.
ASPECT_DIMS: dict[str, tuple[int, int]] = {
    "1:1":  (1024, 1024),
    "3:4":  (896, 1152),
    "2:3":  (832, 1248),
    "9:16": (768, 1360),
    "4:3":  (1152, 896),
    "3:2":  (1248, 832),
    "16:9": (1360, 768),
}

# modelType codes in baseSearch (observed: LORA uses these; checkpoint TBD).
MODEL_TYPE_LORA = "5"
MODEL_TYPE_CHECKPOINT = "1"

# Polling: shakker web polls ~1/sec. We poll a bit slower to be gentle.
POLL_INTERVAL_S = 2.0
POLL_TIMEOUT_S = 300.0  # 5 min hard cap per image

# Status enum (data.subStatus / queueStatus) → our normalized state.
#   subStatus 0 + queueStatus 1 = queued
#   subStatus 0 + queueStatus 0 = running
#   subStatus 2                 = success (images present)
#   subStatus other / errorMsg  = failed
STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_SUCCESS = "success"
STATE_FAILED = "failed"

# ── Upscale (comfy-wrapper) ──────────────────────────────────────────
# Reverse-engineered from upscale_Enhanced.har / upscale_Original.har
# (see docs/shakker_capture/upscale_api.md). Submit goes to a DIFFERENT
# endpoint than /shake, but polling + download are identical.
CDN_HOST = "https://models-online-persist.shakker.cloud/"
# Alibaba OSS bucket the account uploads into (same one upload_reference_image
# has always used). STS creds are fetched per-upload.
OSS_ENDPOINT = "https://oss-us-east-1.aliyuncs.com"
OSS_BUCKET = "models-online-persist-us"
STS_PATH = "/gateway/common-server-api/common-service/api/sts/v2/0"

# The fixed positive prompt the shakker upscale UI always sends.
UPSCALE_PROMPT = (
    "high quality, detailed, photograph , hd, 8k , 4k , sharp, highly detailed"
)

# Scales the UI offers on our tier. 6x/8x are locked to higher plans.
UPSCALE_SCALES = [2, 3, 4]

# Two upscale models. upscaleType (str) + hiresType (int) + the pinned LoRA
# select the model server-side; detailFactor is the "Variability" slider
# (Enhanced only — Original is fixed at 0.05).
UPSCALE_MODELS = {
    "enhanced": {
        "upscale_type": "1", "hires_type": 1,
        "lora_id": 1559805, "lora_weight": 0.8,
        "default_detail": 0.3, "has_variability": True,
    },
    "original": {
        "upscale_type": "2", "hires_type": 2,
        "lora_id": 1540094, "lora_weight": 0.9,
        "default_detail": 0.05, "has_variability": False,
    },
}


def _gen_cid() -> str:
    """Generate a client id in shakker's format: unix_ms + 8 lowercase
    alphanumerics (e.g. '1755484523257lvktirhg'). Used as `cid` in gen
    payloads when an account has no stored `webid`."""
    ts = int(time.time() * 1000)
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{ts}{suffix}"


def _gen_uuid() -> str:
    """Project UUID — shakker uses a v4-style uuid per gen session. We just
    need something unique; the server doesn't validate it against anything."""
    import uuid as _uuid
    return str(_uuid.uuid4())


def _rand_id(n: int = 8) -> str:
    """Short lowercase-alnum id like shakker's `mqkdl2ab` (unitId/sourceId)."""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _source_image_id(url: str) -> str:
    """Derive shakker's `sourceImageId` from a CDN url: strip scheme+host and
    any query, then prepend 'copy/' (the upscale workflow makes a server-side
    working copy of the source). E.g.
        https://models-online-persist.shakker.cloud/img/<u>/<h>.png?Token=..
        -> copy/img/<u>/<h>.png
    """
    s = (url or "").split("?", 1)[0]
    if "://" in s:
        after = s.split("://", 1)[1]            # host/path...
        s = after.split("/", 1)[1] if "/" in after else ""
    return f"copy/{s.lstrip('/')}"


class ShakkerError(Exception):
    """Raised for shakker-specific failures. `.raw` holds the original
    error string for error_messages.py to map to Vietnamese."""
    def __init__(self, message: str, raw: str = ""):
        super().__init__(message)
        self.raw = raw or message


class ShakkerClient:
    def __init__(self, token: str, webid: Optional[str] = None,
                 user_uuid: Optional[str] = None):
        if not token:
            raise ShakkerError("Thiếu token Shakker")
        self.token = token
        # `cid` is stable per client. Prefer the real webid cookie; fall
        # back to a generated one (server treats it as opaque tracking id).
        self.cid = webid or _gen_cid()
        self.user_uuid = user_uuid

    # ── HTTP helpers ────────────────────────────────────────────────

    def _headers(self) -> dict:
        return {
            "token": self.token,
            "Accept": "application/json",
            "Content-Type": "application/json",
            # Mirror a real browser UA so we look like the web app. Not
            # strictly required (token auth works without) but cheap insurance.
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Origin": BASE_URL,
            "Referer": f"{BASE_URL}/aigenerator",
        }

    async def _post(self, path: str, body: dict, timeout: float = 30.0) -> dict:
        url = f"{BASE_URL}{path}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body, headers=self._headers())
        return self._parse(resp, path)

    async def _get(self, path: str, timeout: float = 30.0) -> dict:
        url = f"{BASE_URL}{path}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=self._headers())
        return self._parse(resp, path)

    def _parse(self, resp: httpx.Response, path: str) -> dict:
        """Validate shakker's `{code, data, msg}` envelope. Raises
        ShakkerError on auth failure / non-zero code."""
        if resp.status_code in (401, 403):
            raise ShakkerError("Phiên Shakker hết hạn", raw=f"HTTP {resp.status_code}")
        if resp.status_code >= 500:
            raise ShakkerError("Shakker đang lỗi máy chủ", raw=f"HTTP {resp.status_code}")
        try:
            j = resp.json()
        except Exception:
            raise ShakkerError("Shakker trả về không phải JSON",
                               raw=resp.text[:200])
        if not isinstance(j, dict):
            raise ShakkerError("Shakker trả về sai cấu trúc", raw=str(j)[:200])
        code = j.get("code")
        if code != 0:
            msg = j.get("msg") or f"code={code}"
            # code != 0 on these endpoints is usually auth or quota.
            raise ShakkerError(f"Shakker từ chối: {msg}", raw=f"code={code} msg={msg}")
        return j.get("data") if "data" in j else j

    # ── Credits ─────────────────────────────────────────────────────

    async def check_credits(self) -> dict:
        """Returns {tier, total_power, used_power, usable_power, concurrent,
        expiry}. Raises ShakkerError if token dead."""
        data = await self._get("/api/www/member/account")
        attr = (data.get("attr") or {}) if isinstance(data, dict) else {}
        return {
            "tier": data.get("accountLevelDesc") or "FREE",
            "total_power": int(attr.get("totalPower") or 0),
            "used_power": int(attr.get("usedPower") or 0),
            "usable_power": int(attr.get("usablePower") or 0),
            "concurrent": int(attr.get("concurrent") or 1),
            "expiry": data.get("endTime"),
        }

    # ── Catalog ─────────────────────────────────────────────────────

    async def _base_search(self, model_type: str, search: str,
                           base_type: Optional[int], page: int,
                           page_size: int) -> dict:
        body = {
            "page": page,
            "pageSize": page_size,
            "modelType": model_type,
            "cid": self.cid,
        }
        if search:
            # Verified against live API: the search field is `query` (not
            # keyword/search/name — those are silently ignored).
            body["query"] = search
        if base_type is not None:
            body["baseTypes"] = [str(base_type)]
        data = await self._post("/api/www/model/tool/baseSearch", body)
        return data or {}

    @staticmethod
    def _normalize_model(item: dict) -> dict:
        return {
            "model_id": item.get("modelId"),
            "version_id": item.get("versionId"),
            "name": item.get("name") or item.get("versionName") or "",
            "model_type": item.get("modelType"),
            "base_type": item.get("baseType"),
            "image_url": item.get("imageUrl") or "",
            "run_count": item.get("runCount") or 0,
            "trigger_word": item.get("triggerWord") or "",
            "uuid": item.get("uuid"),
            "model_uuid": item.get("modelUuid"),
        }

    async def list_models(self, search: str = "", base_type: Optional[int] = None,
                          page: int = 1, page_size: int = 24) -> dict:
        data = await self._base_search(MODEL_TYPE_CHECKPOINT, search, base_type,
                                       page, page_size)
        items = data.get("list") or data.get("data") or []
        return {
            "total": data.get("total") or len(items),
            "items": [self._normalize_model(i) for i in items if isinstance(i, dict)],
        }

    async def list_loras(self, search: str = "", base_type: Optional[int] = None,
                         page: int = 1, page_size: int = 24) -> dict:
        data = await self._base_search(MODEL_TYPE_LORA, search, base_type,
                                       page, page_size)
        items = data.get("list") or data.get("data") or []
        return {
            "total": data.get("total") or len(items),
            "items": [self._normalize_model(i) for i in items if isinstance(i, dict)],
        }

    # ── Reference image upload (img2img) ────────────────────────────

    async def _oss_put(self, object_key: str, file_bytes: bytes) -> str:
        """Upload bytes to shakker's OSS bucket at `object_key` using STS creds.
        Returns the public CDN url. Lazy-imports oss2 (t2i-only installs skip it).
        """
        try:
            import oss2  # type: ignore
        except ImportError:
            raise ShakkerError(
                "Thiếu thư viện oss2 để upload ảnh. Cài: pip install oss2",
                raw="oss2 not installed",
            )
        sts = await self._get(STS_PATH)
        ak = sts.get("accessKeyId")
        sk = sts.get("accessKeySecret")
        tok = sts.get("securityToken")
        if not (ak and sk and tok):
            raise ShakkerError("STS không trả đủ credentials", raw=str(sts)[:200])

        def _do() -> str:
            auth = oss2.StsAuth(ak, sk, tok)
            bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET)
            bucket.put_object(object_key, file_bytes)
            return f"{CDN_HOST}{object_key}"

        try:
            return await asyncio.to_thread(_do)
        except Exception as e:
            raise ShakkerError(f"Upload OSS thất bại: {e}", raw=str(e))

    async def upload_reference_image(self, file_bytes: bytes,
                                     ext: str = "jpeg") -> str:
        """Upload a reference image to shakker's Alibaba OSS bucket and
        return the CDN URL to embed in the gen payload.
        """
        if not self.user_uuid:
            raise ShakkerError("Thiếu user_uuid để upload ảnh", raw="no user_uuid")
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        if ext.lower() in ("jpg", "jpeg"):
            ext = "jpeg"
        object_key = f"img/{self.user_uuid}/{file_hash}.{ext}"
        cdn_url = await self._oss_put(object_key, file_bytes)
        log.info(f"shakker uploaded ref image -> {cdn_url}")
        return cdn_url

    async def prepare_upscale_source(self, image_url: str) -> str:
        """Ensure the upscale source image exists at its `copy/<path>` working
        location and return the matching sourceImageId.

        The upscale engine reads the source from `copy/<path>` (the web UI
        physically copies the source there via OSS before submitting). We
        achieve the same by downloading the source from its public CDN url and
        re-uploading it to `copy/<path>`. Works for both imported images and
        shakker-generated images. Without this, the engine reads an empty
        object and fails with "cannot identify image file".
        """
        target_key = _source_image_id(image_url)        # "copy/<path>"
        data = await self.download_result(image_url)
        if not data:
            raise ShakkerError("Không tải được ảnh nguồn để upscale",
                               raw="empty upscale source")
        await self._oss_put(target_key, data)
        return target_key

    # ── Payload builder ─────────────────────────────────────────────

    def build_payload(
        self,
        prompt: str,
        *,
        checkpoint_id: int = DEFAULT_CHECKPOINT_ID,
        base_type: int = DEFAULT_BASE_TYPE,
        aspect: str = "1:1",
        loras: Optional[list[dict]] = None,
        negative_prompt: str = "",
        ref_image_url: Optional[str] = None,
        ref_strength: float = 0.25,
        steps: int = 30,
        cfg_scale: float = 3.5,
        clip_skip: int = 2,
        sampler: str = "1",          # "1" = Euler
        seed: int = -1,
    ) -> dict:
        """Construct the /shake payload for ONE image (count=1).

        t2i vs i2i is auto-selected by presence of ref_image_url.
        """
        loras = loras or []
        width, height = ASPECT_DIMS.get(aspect, ASPECT_DIMS["1:1"])
        neg = negative_prompt.strip() or DEFAULT_NEG_PROMPT
        is_i2i = bool(ref_image_url)
        uuid = _gen_uuid()

        # LoRA representations:
        #  - projectData.loraModels  (UI rich objects)
        #  - additionalNetwork       (engine: modelId/versionId/weight)
        lora_models = []
        additional_network = []
        for lo in loras:
            vid = lo.get("version_id") or lo.get("versionId")
            mid = lo.get("model_id") or lo.get("modelId")
            weight = float(lo.get("weight", 0.8))
            # UI-state representation (projectData.loraModels).
            lora_models.append({
                "modelId": mid,
                "versionId": vid,
                "weight": weight,
                "baseType": lo.get("base_type") or lo.get("baseType"),
                "modelType": "LORA",
                "name": lo.get("name", ""),
                "triggerWord": lo.get("trigger_word") or lo.get("triggerWord") or "",
            })
            # Engine representation (additionalNetwork). CRITICAL: shakker's
            # `modelId` field here is actually the LoRA *versionId*, plus a
            # `type: 0` discriminator. Verified against HAR working payload:
            #   [{"modelId": 19408747(=versionId), "weight": 0.8, "type": 0}]
            additional_network.append({
                "modelId": vid,
                "weight": weight,
                "type": 0,
            })

        project_data = {
            "baseType": base_type,
            "presetBaseModelId": "base_checkpoint",
            "prompt": prompt,
            "negativePrompt": negative_prompt.strip(),
            "presetNegativePrompts": [],
            "loraModels": lora_models,
            "loraModelsTrialCount": [],
            "count": 1,
            "width": width,
            "height": height,
            "renderWidth": width,
            "renderHeight": height,
            "icon": [12, 12],
            "isFixedRatio": True,
            "isSimpleMode": True,
            "samplerMethod": sampler,
            "samplingSteps": steps,
            "seedType": "0",
            "seedNumber": "" if seed < 0 else str(seed),
            "vae": "-1",
            "cfgScale": cfg_scale,
            "clipSkip": clip_skip,
            "colorControl": {"colorPalette": []},
            "colorPalette": [],
            "colorReferenceImg": None,
            "addOns": [],
            "controlnets": [],
            "imageReference": None,
            "hiresOptions": {
                "enabled": False, "scale": 1.5, "upscaler": "6",
                "strength": 0.5, "steps": 20,
            },
        }

        engine_params = {
            "checkPointName": checkpoint_id,
            "prompt": prompt,
            "negPrompt": neg,
            "width": width,
            "height": height,
            "imgCount": 1,
            "samplingMethod": sampler,
            "samplingStep": steps,
            "cfgScale": cfg_scale,
            "clipSkip": clip_skip,
            "seed": seed,
            "seedExtra": 0,
            "hiResFix": 0,
            "restoreFaces": 0,
            "tiling": 0,
            "randnSource": 1,
        }

        payload = {
            "source": 3,
            "adetailerEnable": 0,
            "mode": 1,
            "uuid": uuid,
            "cid": self.cid,
            "platform": "shakker",
            "checkpointId": checkpoint_id,
            "taskQueuePriority": 1,
            "additionalNetwork": additional_network,
            "vae": "",
            "projectData": project_data,
        }

        if is_i2i:
            payload["coreParamsField"] = "img2img"
            payload["generateType"] = 22
            project_data["imageReference"] = {
                "id": self.cid,
                "url": ref_image_url,
                "mode": "custom",
                "label": "Customize",
                "strength": ref_strength,
            }
            # img2img engine needs extra fields beyond t2i. Source image is
            # referenced by its OSS object KEY (not the CDN url). Derive the
            # key from the uploaded url:
            #   https://models-online-persist.shakker.cloud/img/<uuid>/<hash>.jpeg
            #   → object key = img/<uuid>/<hash>.jpeg
            object_key = ref_image_url
            for marker in (".shakker.cloud/", ".aliyuncs.com/"):
                if marker in object_key:
                    object_key = object_key.split(marker, 1)[1]
                    break
            object_key = object_key.split("?")[0]
            # denoisingStrength is the inverse of UI "similarity": a faithful
            # reference (high ref_strength) means low denoise. Capture showed
            # imageReference.strength 0.25 ↔ denoisingStrength 0.75.
            denoise = round(max(0.0, min(1.0, 1.0 - ref_strength)), 2)
            engine_params.update({
                "denoisingStrength": denoise,
                "resizeWidth": width,
                "resizeHeight": height,
                "maskImageId": "",
                "sourceImageId": object_key,
                "imageMode": 0,
                "resizeMode": 1,
            })
            payload["img2img"] = engine_params
        else:
            payload["coreParamsField"] = "text2img"
            payload["generateType"] = 21
            payload["text2img"] = engine_params

        return payload

    # ── Cost preview ────────────────────────────────────────────────

    async def calculate_power(self, payload: dict) -> int:
        """Returns the power (credit) cost for a given gen payload."""
        data = await self._post(
            "/gateway/sd-api/generate/calculate-power/v1", payload)
        return int(data.get("power") or 0) if isinstance(data, dict) else 0

    # ── Submit ──────────────────────────────────────────────────────

    async def _submit_with_retry(self, path: str, payload: dict) -> str:
        """POST a gen-submit endpoint → returns generateId (string).

        Retries on the transient "task is being initiated / please wait"
        error: Shakker only lets ONE task initiate at a time per account
        (concurrent=1), so parallel submits collide. The web UI spaces its
        submits ~1s apart; we instead retry with backoff so the caller can
        still fan out items. Shared by /shake (generate) + /comfy-wrapper
        (upscale): both return the generateId directly as `data`.
        """
        last_err: Optional[ShakkerError] = None
        for attempt in range(6):
            try:
                data = await self._post(path, payload)
                if isinstance(data, (str, int)):
                    return str(data)
                if isinstance(data, dict):
                    gid = data.get("generateId") or data.get("id")
                    if gid:
                        return str(gid)
                raise ShakkerError("Shakker không trả generateId", raw=str(data)[:200])
            except ShakkerError as e:
                raw = (getattr(e, "raw", "") or str(e)).lower()
                transient = any(s in raw for s in (
                    "being initiated", "please wait", "wait a moment",
                    "正在", "请稍", "频繁", "task is being",
                ))
                if not transient:
                    raise
                last_err = e
                # Backoff: 1.2s, 2.4s, 3.6s … gives the prior task time to
                # leave the "initiating" state.
                await asyncio.sleep(1.2 * (attempt + 1))
        # Exhausted retries
        raise last_err or ShakkerError("Shakker bận — thử lại sau", raw="submit retries exhausted")

    async def submit_generate(self, payload: dict) -> str:
        """POST /gen/tool/shake → returns generateId (string)."""
        return await self._submit_with_retry("/gateway/sd-api/gen/tool/shake", payload)

    async def submit_upscale(self, payload: dict) -> str:
        """POST /gen/tool/comfy-wrapper → returns generateId (string).

        Same retry/concurrency semantics as submit_generate."""
        return await self._submit_with_retry(
            "/gateway/sd-api/gen/tool/comfy-wrapper", payload)

    # ── Poll status ─────────────────────────────────────────────────

    async def get_status(self, generate_id: str) -> dict:
        """POST /generate/progress/msg/v1/{id}. Returns normalized:
        {state, percent, queue_num, power, images: [url...], error}."""
        data = await self._post(
            f"/gateway/sd-api/generate/progress/msg/v1/{generate_id}",
            {"flag": 3, "cid": self.cid},
        )
        if not isinstance(data, dict):
            return {"state": STATE_FAILED, "error": "progress trả về rỗng"}

        sub_status = data.get("subStatus")
        queue_status = data.get("queueStatus")
        err_msg = data.get("errorMsg") or data.get("statusMsg")
        err_code = data.get("errCode")
        images_raw = data.get("images") or []

        # Extract image URLs (prefer previewPath with CDN token)
        images = []
        for im in images_raw:
            if not isinstance(im, dict):
                continue
            url = im.get("previewPath") or im.get("imageUrl") or im.get("path")
            if url:
                images.append({
                    "url": url,
                    "id": im.get("id"),
                    "info": im.get("imageInfo") or "",
                    "nsfw": bool(im.get("isNfsw")) or bool(im.get("illegal")),
                })

        # Determine state
        if err_msg or err_code:
            state = STATE_FAILED
        elif sub_status == 2 or images:
            state = STATE_SUCCESS
        elif queue_status == 1:
            state = STATE_QUEUED
        else:
            state = STATE_RUNNING

        return {
            "state": state,
            "percent": data.get("percentCompleted") or 0,
            "queue_num": data.get("queueNum") or 0,
            "total_queue": data.get("totalQueueNum") or 0,
            "power": data.get("power") or 0,
            "time_taken": data.get("timeTaken") or 0,
            "images": images,
            "error": err_msg or (f"errCode={err_code}" if err_code else None),
        }

    async def wait_for_completion(self, generate_id: str,
                                  on_progress=None) -> dict:
        """Poll until success/failure or timeout. Returns the final
        get_status dict. `on_progress(status)` called each tick if given."""
        deadline = time.time() + POLL_TIMEOUT_S
        while time.time() < deadline:
            status = await self.get_status(generate_id)
            if on_progress:
                try:
                    res = on_progress(status)
                    # Support both sync and async progress callbacks.
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass
            if status["state"] in (STATE_SUCCESS, STATE_FAILED):
                return status
            await asyncio.sleep(POLL_INTERVAL_S)
        return {"state": STATE_FAILED, "error": "Hết thời gian chờ (timeout 5 phút)",
                "images": []}

    # ── Download ────────────────────────────────────────────────────

    async def download_result(self, url: str, timeout: float = 60.0) -> bytes:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                raise ShakkerError(f"Tải ảnh thất bại: HTTP {resp.status_code}",
                                   raw=f"HTTP {resp.status_code}")
            return resp.content

    # ── Upscale ─────────────────────────────────────────────────────

    def build_upscale_payload(
        self,
        *,
        image_url: str,
        src_w: int,
        src_h: int,
        scale: int = 2,
        model: str = "enhanced",
        variability: Optional[float] = None,
        checkpoint_id: int = DEFAULT_CHECKPOINT_ID,
        source_image_id: Optional[str] = None,
    ) -> dict:
        """Construct the /gen/tool/comfy-wrapper payload to upscale ONE image.

        `image_url` is a shakker CDN url (from upload_reference_image for an
        imported image, or an existing shakker-generated image). `variability`
        only applies to the Enhanced model (the slider); Original is fixed.
        `source_image_id` overrides the derived `copy/<path>` — pass the value
        returned by prepare_upscale_source so it points at a populated object.
        """
        spec = UPSCALE_MODELS.get(model) or UPSCALE_MODELS["enhanced"]
        detail = float(spec["default_detail"])
        if spec["has_variability"] and variability is not None:
            detail = max(0.0, min(1.0, float(variability)))
        src_w, src_h, scale = int(src_w), int(src_h), int(scale)

        hires = {
            "checkpointId": checkpoint_id,
            "sourceImageId": source_image_id or _source_image_id(image_url),
            "prompt": UPSCALE_PROMPT,
            "scaleFactor": scale,
            "steps": 4,
            "detailFactor": detail,
            "imageWidth": src_w,
            "imageHeight": src_h,
            "hiresType": spec["hires_type"],
            "loraSetting": {"loraId": spec["lora_id"], "loraWeight": spec["lora_weight"]},
        }
        return {
            "source": 3,
            "internalComfyWorkflowType": 3,
            "projectData": {
                "count": 1,
                "scaleFactor": scale,
                "upscaleType": spec["upscale_type"],
                "detailFactor": detail,
                "width": src_w,
                "height": src_h,
                "generatorKey": "",
                "unitId": f"unit-upscale-{_rand_id()}",
                "unitLabel": "Upscale",
                "mode": 1,
                "isSimpleMode": True,
                "generateType": "upscale",
                "renderWidth": src_w * scale,
                "renderHeight": src_h * scale,
                "sourceElement": {
                    "id": _gen_uuid(),
                    "url": image_url,
                    "sourceId": f"element-image-{_rand_id()}",
                    "innerTaskId": None,
                    "innerImageId": None,
                    "width": src_w,
                    "height": src_h,
                },
            },
            "taskQueuePriority": 1,
            "hiresUserParam": hires,
            "cid": self.cid,
        }

    async def calculate_upscale_power(self, payload: dict) -> int:
        """Ask shakker how much power an upscale payload costs (preview +
        correct internal-credit reserve). Returns 0 if it can't be read."""
        body = {
            "source": 3,
            "internalComfyWorkflowType": 3,
            "taskQueuePriority": 1,
            "hiresUserParam": payload.get("hiresUserParam") or {},
            "cid": self.cid,
        }
        try:
            data = await self._post(
                "/gateway/sd-api/generate/comfy-wrapper/calculate-power", body)
        except ShakkerError:
            return 0
        if isinstance(data, dict):
            return int(data.get("power") or 0)
        return 0
