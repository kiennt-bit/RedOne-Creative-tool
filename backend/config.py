"""Application constants and enums."""
from __future__ import annotations
import os
import sys
from enum import Enum
from pathlib import Path

APP_NAME = "RedOne Creative"
APP_VERSION = "1.2.1"

# GitHub repo for auto-update check (releases API)
GITHUB_REPO = "kiennt-bit/RedOne-Creative-tool"

# ── Path resolution: dev vs PyInstaller frozen ─────────────
# In dev:    BASE_DIR = project root (where backend/ frontend/ live)
#            DATA/OUTPUT under BASE_DIR
# In frozen: BASE_DIR (for static assets) = PyInstaller temp/bundle dir
#            DATA/OUTPUT must be PERSISTENT — placed next to the .exe
IS_FROZEN = getattr(sys, "frozen", False)

if IS_FROZEN:
    # PyInstaller: assets bundled in sys._MEIPASS, but user data must persist
    # alongside the .exe so it survives app updates and re-extractions.
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
    EXE_DIR = Path(sys.executable).resolve().parent
    BASE_DIR = BUNDLE_DIR              # for serving frontend/ static
    USER_DATA_ROOT = EXE_DIR           # for data/, outputs/
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    USER_DATA_ROOT = BASE_DIR

DATA_DIR = USER_DATA_ROOT / "data"
OUTPUT_DIR = USER_DATA_ROOT / "outputs"
COOKIES_DIR = DATA_DIR / "cookies"
DB_PATH = DATA_DIR / "navtools.db"

for d in (DATA_DIR, OUTPUT_DIR, COOKIES_DIR, OUTPUT_DIR / "video", OUTPUT_DIR / "image"):
    d.mkdir(parents=True, exist_ok=True)


class TaskMode(str, Enum):
    IMAGE = "IMAGE"
    CHAR_IMAGE = "CHAR_IMAGE"
    CHAR_VIDEO = "CHAR_VIDEO"
    VIDEO_PLAIN = "VIDEO_PLAIN"
    VIDEO_REF = "VIDEO_REF"
    FRAME_VIDEO = "FRAME_VIDEO"


class TaskStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    ERROR = "ERROR"
    CANCELLED = "CANCELLED"


class ItemStatus(str, Enum):
    PENDING = "PENDING"
    UPLOADING = "UPLOADING"
    GENERATING = "GENERATING"
    DOWNLOADING = "DOWNLOADING"
    COMPLETED = "COMPLETED"
    ERROR = "ERROR"


class AccountTier(str, Enum):
    FREE = "FREE"
    ULTRA = "ULTRA"
    PRO = "PRO"
    PAYGATE_TIER_TWO = "PAYGATE_TIER_TWO"


VIDEO_MODELS = {
    "veo_3_fast": {"name": "Veo 3 Fast", "cost": 10},
    "veo_3_quality": {"name": "Veo 3 Quality", "cost": 100},
    "veo_3_1_fast": {"name": "Veo 3.1 Fast", "cost": 20},
    "veo_3_1_quality": {"name": "Veo 3.1 Quality", "cost": 100},
    "veo_3_1_lite": {"name": "Veo 3.1 Lite (Low Priority)", "cost": 5},
}

IMAGE_MODELS = {
    "imagen_4": {"name": "Imagen 4", "cost": 1},
    "imagen_3": {"name": "Imagen 3", "cost": 1},
    "nano_banana_2": {"name": "Nano Banana 2", "cost": 1},
}

ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"]
RESOLUTIONS = ["720p", "1080p"]

GEMINI_MODELS_CHAIN = [
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemma-4-31b-it",
]

MAX_CONCURRENT_TASKS = 20
MAX_RETRY_COUNT = 3
POLL_INTERVAL_SECONDS = 5.0
MAX_CHARACTER_IMAGES = 100
SERVER_PORT = 8000

# ── Google Flow API endpoints ────────────────────────────────
AISANDBOX_BASE = "https://aisandbox-pa.googleapis.com/v1"
TRPC_BASE = "https://labs.google/fx/api/trpc"
SESSION_URL = "https://labs.google/fx/api/auth/session"
FLOW_URL = "https://labs.google/fx/tools/video-fx"
IMAGE_FX_URL = "https://labs.google/fx/tools/image-fx"

# ── Browser Headers ──────────────────────────────────────────
X_CLIENT_DATA = "CIa2yQEIprbJAQipncoBCLb9ygEIlqHLAQiFoM0BCNmqzwEY/qXPARikqM8BGMOrzwE="
X_BROWSER_VALIDATION = "AKIAtsVHZoiKbPixy+qSK1BgKWo="

DEFAULT_ACCOUNT_EXPIRY_DAYS = 30


def cost_for_model_key(model_key: str) -> int:
    if not model_key:
        return 10
    mk = model_key.lower()
    if "_low_priority" in mk or "_relaxed" in mk:
        return 0
    if "_extension_lite" in mk or "_extension_fast" in mk:
        return 0
    if "_lite" in mk:
        return 5
    if "_fast" in mk:
        return 10
    return 100


# Static model keys for Veo 3.1 (always 8s default — Google internally
# locks duration here. To support 4s/6s for Veo we'd need to capture each
# duration variant's key from the labs.google network tab.)
T2V_MODEL_MAP = {
    "lite":    "veo_3_1_t2v_lite",
    "fast":    "veo_3_1_t2v_fast_ultra",
    "quality": "veo_3_1_t2v",
    "lite_lp": "veo_3_1_t2v_lite_low_priority",
}

I2V_MODEL_MAP = {
    "lite":    "veo_3_1_i2v_lite",
    "fast":    "veo_3_1_i2v_s_fast_ultra",
    "quality": "veo_3_1_i2v_s",
    "lite_lp": "veo_3_1_i2v_lite_low_priority",
}

# Extend video model keys (Omni Flash doesn't currently support extend)
EXTEND_MODEL_MAP = {
    "lite":    "veo_3_1_extension_lite",
    "fast":    "veo_3_1_extension_fast_ultra",
    "quality": "veo_3_1_extension_t2v",
    "lite_lp": "veo_3_1_extension_lite_low_priority",
}

# Allowed duration options (seconds) per model preset.
#
# CONFIRMED via labs.google network capture:
#   Omni Flash uses `abra_<mode>_<N>s` pattern — duration encoded in key.
#
# UNCONFIRMED:
#   Veo 3.1 (lite/fast/quality/lite_lp) — capture only showed
#   `veo_3_1_t2v_lite` etc. without a duration suffix. Google may always
#   render at 8s for those keys. Until we capture an actual 4s/6s Veo
#   payload, we only expose 8s for Veo models.
VIDEO_DURATIONS_BY_MODEL = {
    "omni_flash": [4, 6, 8, 10],
    "lite":       [8],
    "fast":       [8],
    "quality":    [8],
    "lite_lp":    [8],
}

DEFAULT_VIDEO_DURATION = 8


def allowed_durations(quality: str) -> list[int]:
    """Return the duration options (seconds) allowed for a given model preset."""
    return VIDEO_DURATIONS_BY_MODEL.get(quality, [4, 6, 8])


def clamp_duration(quality: str, duration: int | None) -> int:
    """Clamp a requested duration to the closest allowed value for the model."""
    allowed = allowed_durations(quality)
    if not duration or duration not in allowed:
        return DEFAULT_VIDEO_DURATION if DEFAULT_VIDEO_DURATION in allowed else allowed[-1]
    return duration


# Human-readable labels (used by frontend if it asks for the list)
VIDEO_MODEL_LABELS = [
    {"value": "omni_flash", "label": "Omni Flash",                          "cost": None,
     "supports": [4, 6, 8, 10]},
    {"value": "lite",       "label": "Veo 3.1 — Lite",                      "cost": 5,
     "supports": [4, 6, 8]},
    {"value": "fast",       "label": "Veo 3.1 — Fast",                      "cost": 10,
     "supports": [4, 6, 8]},
    {"value": "quality",    "label": "Veo 3.1 — Quality",                   "cost": 100,
     "supports": [4, 6, 8]},
    {"value": "lite_lp",    "label": "Veo 3.1 — Lite [Lower Priority]",     "cost": 0,
     "supports": [4, 6, 8]},
]

# Backwards-compat alias (some old code still references VIDEO_MODEL_MAP)
VIDEO_MODEL_MAP = T2V_MODEL_MAP


def video_model_for(quality: str, mode: str = "t2v", duration: int = 8) -> str:
    """Pick the correct internal model key.

    - Omni Flash: duration is encoded in the key itself.
      Pattern: `abra_<t2v|i2v>_<duration>s` (eg. `abra_t2v_10s`).
    - Veo 3.1: static keys from T2V/I2V_MODEL_MAP. Duration is ignored
      because we haven't captured Veo's duration-variant keys yet.
    """
    m = (mode or "t2v").lower()
    if quality == "omni_flash":
        d = clamp_duration("omni_flash", duration)
        # Currently CONFIRMED only `abra_t2v_<N>s` from labs.google capture.
        # Try the same key for both T2V and I2V (Google's image-input is
        # signalled via `startImage` field, model itself may be unified).
        # If 500 from Google → need to capture I2V payload separately.
        return f"abra_t2v_{d}s"
    table = I2V_MODEL_MAP if m == "i2v" else T2V_MODEL_MAP
    return table.get(quality, table["fast"])


_SLUG_INVALID_RE = None


def slugify_folder(name: str, fallback: str = "task") -> str:
    """Convert a free-text task name into a safe folder name.
    Keeps Vietnamese letters but strips path separators and special chars.
    """
    import re
    global _SLUG_INVALID_RE
    if _SLUG_INVALID_RE is None:
        # Reject path separators, control chars, and Windows reserved chars
        _SLUG_INVALID_RE = re.compile(r'[\\/<>:"|?*\x00-\x1f]+')
    if not name:
        return fallback
    s = _SLUG_INVALID_RE.sub(" ", str(name).strip())
    s = re.sub(r"\s+", "_", s)
    s = s.strip("._ ")
    return s[:80] or fallback


def get_save_dir(
    kind: str,
    task_id: int | str,
    task_name: str | None = None,
) -> "Path":
    """Return where a generated file should be saved.

    Layout:
        outputs/<kind>/<YYYY-MM-DD>/<task_name|task_id>/

    If auto_save_outputs is False, the same layout is used under
    outputs/_pending/ (auto-cleaned after 24h).

    Kind is "video" or "image".
    """
    from datetime import datetime
    from .database import db  # local import — avoid circular
    auto_save = db.get_setting("auto_save_outputs", True)
    if isinstance(auto_save, str):
        auto_save = auto_save.lower() not in ("false", "0", "no")
    base = OUTPUT_DIR if auto_save else (OUTPUT_DIR / "_pending")
    today = datetime.now().strftime("%Y-%m-%d")
    folder = slugify_folder(task_name or "", fallback=f"task_{task_id}")
    d = base / kind / today / folder
    d.mkdir(parents=True, exist_ok=True)
    return d
