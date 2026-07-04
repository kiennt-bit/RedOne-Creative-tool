"""Kho tính năng — install / uninstall downloadable features.

Only `frontend` (JS/CSS/asset bundle) and `asset` (model/binary) features
download anything; `builtin` features ship inside the EXE and are toggled
client-side (no backend call). Security:
  - download URLs MUST be on the GitHub host allowlist (config.FEATURES_ALLOWED_HOSTS)
  - every download MUST match a declared sha256 (when provided)
  - zip extraction rejects absolute paths / `..` traversal
  - a hard size cap guards against runaway downloads
We NEVER download or execute Python — only static assets the frontend imports.

Installed state lives in `addons/installed.json`:
    { "<feature-id>": {"kind": "frontend", "version": "1.0.0", "entry": "index.js"},
      "<feature-id>": {"kind": "asset", "version": "1.0.0", "files": ["models/x.pt"]} }
"""
from __future__ import annotations
import hashlib
import json
import logging
import shutil
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

from ..config import EXT_DIR, USER_DATA_ROOT, FEATURES_ALLOWED_HOSTS

log = logging.getLogger("redone.features")

INSTALLED_JSON = EXT_DIR / "installed.json"
_CHUNK = 64 * 1024
_MAX_BYTES = 600 * 1024 * 1024   # 600 MB hard cap per file

# ── Migration: extensions/ → addons/ (v1.5.1+) ──────────────────────
# Renamed to avoid user confusion with the Chrome "extension/" folder.
# If the old directory exists and the new one is empty, move contents over.
_OLD_EXT_DIR = USER_DATA_ROOT / "extensions"
try:
    if _OLD_EXT_DIR.exists() and _OLD_EXT_DIR.is_dir():
        # Only migrate if old dir has actual content (not just an empty dir)
        old_contents = list(_OLD_EXT_DIR.iterdir())
        if old_contents:
            EXT_DIR.mkdir(parents=True, exist_ok=True)
            for item in old_contents:
                dest = EXT_DIR / item.name
                if not dest.exists():
                    shutil.move(str(item), str(dest))
            log.info("Migrated feature store: extensions/ → addons/")
        # Remove old dir (now empty or fully migrated)
        shutil.rmtree(_OLD_EXT_DIR, ignore_errors=True)
except Exception as _mig_err:
    log.warning("extensions→addons migration failed: %s", _mig_err)

# progress(percent: float, stage: str, message: str)
ProgressCb = Callable[[float, str, str], None]


def _host_of(url: str) -> str:
    from urllib.parse import urlparse
    return (urlparse(url).hostname or "").lower()


def is_host_allowed(url: str) -> bool:
    host = _host_of(url)
    return bool(host) and any(
        host == h or host.endswith("." + h) for h in FEATURES_ALLOWED_HOSTS
    )


def load_installed() -> dict:
    try:
        if INSTALLED_JSON.exists():
            return json.loads(INSTALLED_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("read installed.json failed: %s", e)
    return {}


def save_installed(data: dict) -> None:
    EXT_DIR.mkdir(parents=True, exist_ok=True)
    INSTALLED_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _download(url: str, dest: Path, expected_sha: Optional[str],
              progress: ProgressCb, label: str) -> None:
    if not is_host_allowed(url):
        raise ValueError(f"URL không nằm trong allowlist GitHub: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    h = hashlib.sha256()
    req = urllib.request.Request(url, headers={"User-Agent": "RedOne-Creative"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # nosec - host allowlisted
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(_CHUNK)
                if not chunk:
                    break
                done += len(chunk)
                if done > _MAX_BYTES:
                    raise ValueError("File quá lớn (>600MB) — từ chối tải")
                h.update(chunk)
                f.write(chunk)
                pct = (done / total * 100) if total else 0.0
                mb = done // 1024 // 1024
                tot = (total // 1024 // 1024) if total else "?"
                progress(pct, "downloading", f"Đang tải {label} {mb}/{tot} MB")
    digest = h.hexdigest()
    if expected_sha and digest.lower() != str(expected_sha).lower():
        tmp.unlink(missing_ok=True)
        raise ValueError(f"sha256 không khớp ({label})")
    tmp.replace(dest)


def _safe_extract_zip(zip_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    root = dest_dir.resolve()
    with zipfile.ZipFile(zip_path) as z:
        for m in z.namelist():
            target = (dest_dir / m).resolve()
            if not str(target).startswith(str(root)):
                raise ValueError(f"Zip entry không an toàn (path traversal): {m}")
        z.extractall(dest_dir)


def install_frontend(feature: dict, progress: ProgressCb) -> dict:
    """Download + unpack a frontend bundle into extensions/<id>/."""
    fid = feature["id"]
    dl = feature.get("download") or {}
    url = dl.get("url")
    if not url:
        raise ValueError("Thiếu download.url cho tính năng frontend")
    target = EXT_DIR / fid
    zip_path = EXT_DIR / f"{fid}.zip"
    progress(0, "downloading", "Bắt đầu tải")
    _download(url, zip_path, dl.get("sha256"), progress, feature.get("name", fid))
    progress(100, "extracting", "Đang giải nén")
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    _safe_extract_zip(zip_path, target)
    zip_path.unlink(missing_ok=True)
    rec = {
        "kind": "frontend",
        "version": feature.get("version", ""),
        "entry": dl.get("entry", "index.js"),
    }
    inst = load_installed()
    inst[fid] = rec
    save_installed(inst)
    progress(100, "done", "Hoàn tất")
    return rec


def install_asset(feature: dict, progress: ProgressCb) -> dict:
    """Download model/binary assets to their declared dest (under USER_DATA_ROOT).

    If an asset has an ``extract_to`` key, the downloaded file is treated as a
    zip archive and extracted to that directory (relative to USER_DATA_ROOT).
    """
    fid = feature["id"]
    assets = feature.get("assets") or []
    if not assets:
        raise ValueError("Thiếu assets cho tính năng asset")
    root = USER_DATA_ROOT.resolve()
    files: list[str] = []
    n = len(assets)
    for i, a in enumerate(assets):
        rel = a.get("dest")
        if not rel:
            raise ValueError("Asset thiếu 'dest'")
        dest = (USER_DATA_ROOT / rel).resolve()
        if not str(dest).startswith(str(root)):
            raise ValueError(f"dest không an toàn: {rel}")

        def _scoped(p, s, m, _i=i):
            progress((_i * 100 + p) / n, s, m)

        _download(a["url"], dest, a.get("sha256"), _scoped, rel)

        # If extract_to is specified, treat as zip and extract
        extract_to = a.get("extract_to")
        if extract_to and str(dest).lower().endswith(".zip"):
            extract_dir = (USER_DATA_ROOT / extract_to).resolve()
            if not str(extract_dir).startswith(str(root)):
                raise ValueError(f"extract_to không an toàn: {extract_to}")
            progress((_scoped and (i * 100 + 95)) / n, "extracting",
                     f"Đang giải nén {rel}...")
            _safe_extract_zip(dest, extract_dir)
            dest.unlink(missing_ok=True)  # remove zip after extraction
            files.append(extract_to)
        else:
            files.append(rel)

    rec = {"kind": "asset", "version": feature.get("version", ""), "files": files}
    inst = load_installed()
    inst[fid] = rec
    save_installed(inst)
    progress(100, "done", "Hoàn tất")
    return rec


def uninstall_feature(fid: str) -> None:
    inst = load_installed()
    rec = inst.pop(fid, None)
    if rec:
        if rec.get("kind") == "frontend":
            shutil.rmtree(EXT_DIR / fid, ignore_errors=True)
        elif rec.get("kind") == "asset":
            for rel in rec.get("files", []):
                try:
                    (USER_DATA_ROOT / rel).unlink(missing_ok=True)
                except Exception:
                    pass
    save_installed(inst)
