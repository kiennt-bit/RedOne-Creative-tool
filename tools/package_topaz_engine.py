"""Topaz Video AI Proteus Engine Packager for RedOne Creative Tool.

This script extracts the standalone Topaz FFmpeg engine and model definitions
from a local Topaz Video AI installation, packages them into `addons/tvai-engine/`
for local development/runtime, and optionally generates a distributable zip bundle
with SHA256 verification for the RedOne Feature Store.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import zipfile
from pathlib import Path

# Ensure UTF-8 output across Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Paths
SOURCE_BIN_DIR = Path(r"C:\Program Files\Topaz Labs LLC\Topaz Video AI")
SOURCE_MODEL_DIR = Path(r"C:\ProgramData\Topaz Labs LLC\Topaz Video AI\models")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ADDON_DEST_DIR = PROJECT_ROOT / "addons" / "tvai-engine"
DIST_DIR = PROJECT_ROOT / "dist"

# Core binaries and libraries needed for standalone execution
ESSENTIAL_BINARIES = [
    # Topaz custom FFmpeg & probe
    "ffmpeg.exe",
    "ffprobe.exe",
    # Topaz AI core engine
    "aiengine.dll",
    "tvai.dll",
    "videoai.dll",
    "opencv_world456.dll",
    # FFmpeg shared codecs & filters
    "avcodec-61.dll",
    "avdevice-61.dll",
    "avfilter-10.dll",
    "avformat-61.dll",
    "avutil-59.dll",
    "swscale-8.dll",
    "swresample-5.dll",
    # Crypto & utility
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
    "libvpl.dll",
    "z.dll",
    "zip.dll",
    # Threading
    "tbb12.dll",
    "tbbmalloc.dll",
    # DirectML & ONNX Runtime (universal GPU / CPU fallback: AMD, Intel, NVIDIA)
    "DirectML.dll",
    "onnxruntime.dll",
    # OpenVINO (Intel CPU / iGPU acceleration)
    "openvino.dll",
    "openvino_c.dll",
    "openvino_intel_cpu_plugin.dll",
    "openvino_intel_gpu_plugin.dll",
    "openvino_auto_plugin.dll",
    "openvino_auto_batch_plugin.dll",
    "openvino_ir_frontend.dll",
    "openvino_onnx_frontend.dll",
    # NVIDIA TensorRT & cuBLAS (NVIDIA RTX / GTX hardware acceleration)
    "cublas64_11.dll",
    "cublasLt64_11.dll",
    "nvinfer.dll",
]

# Model definitions & base weights
ESSENTIAL_MODELS = [
    "prob-4.json",   # Proteus v4 (Enhance MQ) definition
    "prap-3.json",   # Proteus auto-parameter estimation
    "amq-13.json",   # Artemis MQ definition
    "tvai.tz",       # Base Topaz archive
]


def sha256_file(filepath: Path) -> str:
    """Calculate SHA256 of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def package_topaz_engine(create_zip: bool = True) -> bool:
    print(f"[*] Checking Topaz Video AI installation at: {SOURCE_BIN_DIR}")
    if not SOURCE_BIN_DIR.exists():
        print(f"[!] Error: Topaz binary directory not found at {SOURCE_BIN_DIR}")
        return False

    if not SOURCE_MODEL_DIR.exists():
        print(f"[!] Error: Topaz model directory not found at {SOURCE_MODEL_DIR}")
        return False

    print(f"[*] Target addon directory: {ADDON_DEST_DIR}")
    ADDON_DEST_DIR.mkdir(parents=True, exist_ok=True)
    models_dest = ADDON_DEST_DIR / "models"
    models_dest.mkdir(parents=True, exist_ok=True)

    # 1. Copy binaries
    print("[*] Copying essential binaries...")
    copied_bins = 0
    total_bin_size = 0
    for fname in ESSENTIAL_BINARIES:
        src = SOURCE_BIN_DIR / fname
        dst = ADDON_DEST_DIR / fname
        if src.exists():
            shutil.copy2(src, dst)
            sz = src.stat().st_size
            total_bin_size += sz
            copied_bins += 1
            print(f"  -> Copied: {fname} ({sz / (1024*1024):.2f} MB)")
        else:
            print(f"  [!] Warning: Missing binary {fname}")

    print(f"[+] Successfully copied {copied_bins}/{len(ESSENTIAL_BINARIES)} binaries ({total_bin_size / (1024*1024):.2f} MB)")

    # 2. Copy model definitions
    print("\n[*] Copying model definitions...")
    for mname in ESSENTIAL_MODELS:
        src = SOURCE_MODEL_DIR / mname
        dst = models_dest / mname
        if src.exists():
            shutil.copy2(src, dst)
            print(f"  -> Copied model config: {mname}")
        else:
            print(f"  [!] Warning: Model file {mname} not found in {SOURCE_MODEL_DIR}")

    # Also copy any pre-downloaded proteus weights if available
    pre_weights = list(SOURCE_MODEL_DIR.glob("prob-v4*.tz")) + list(SOURCE_MODEL_DIR.glob("prap-v3*.tz"))
    if pre_weights:
        print(f"\n[*] Copying {len(pre_weights)} pre-downloaded Proteus weights...")
        for pw in pre_weights:
            dst = models_dest / pw.name
            shutil.copy2(pw, dst)
            print(f"  -> Included weight: {pw.name} ({pw.stat().st_size / (1024*1024):.2f} MB)")

    print(f"\n[+] Addon ready at: {ADDON_DEST_DIR}")

    # 3. Create distributable zip bundle if requested
    if create_zip:
        DIST_DIR.mkdir(parents=True, exist_ok=True)
        zip_path = DIST_DIR / "tvai-engine.zip"
        is_full = "--full" in sys.argv
        mode_str = "FULL" if is_full else "LEAN (Tối ưu hóa dung lượng)"
        print(f"\n[*] Creating distributable archive [{mode_str}]: {zip_path}...")
        
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for root, _, files in os.walk(ADDON_DEST_DIR):
                for f in files:
                    # In lean mode, omit heavy .tz weights (FFmpeg auto-downloads the exact 30MB weight on client GPU)
                    if not is_full and f.endswith(".tz") and f != "tvai.tz":
                        continue
                    full_p = Path(root) / f
                    rel_p = full_p.relative_to(ADDON_DEST_DIR)
                    zf.write(full_p, arcname=str(rel_p))

        zip_size_mb = zip_path.stat().st_size / (1024 * 1024)
        print(f"[+] Zip created: {zip_size_mb:.2f} MB")
        checksum = sha256_file(zip_path)
        print(f"[+] SHA256: {checksum}")

        # Write metadata file for Feature Store
        meta_path = DIST_DIR / "tvai-engine.meta.json"
        with open(meta_path, "w", encoding="utf-8") as mf:
            import json
            json.dump({
                "name": "tvai-engine.zip",
                "size_mb": round(zip_size_mb, 2),
                "sha256": checksum,
                "mode": "full" if is_full else "lean",
            }, mf, indent=2)
        print(f"[+] Metadata written to: {meta_path}")

    return True


if __name__ == "__main__":
    make_zip = "--no-zip" not in sys.argv
    package_topaz_engine(create_zip=make_zip)
