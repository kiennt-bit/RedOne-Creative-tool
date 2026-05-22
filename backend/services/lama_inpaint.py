#!/usr/bin/env python3
"""
Video frame inpainting script.
Usage: python lama_inpaint.py <method> <input_frames_dir> <mask_path> <output_frames_dir>

Methods: lama, opencv
Prints JSON progress to stdout for the parent process to parse.
"""
import sys
import os
import json
from pathlib import Path


def run_opencv(input_dir, mask_path, output_dir, on_event=None):
    """Fast inpainting using OpenCV TELEA algorithm.

    Two call modes:
      • CLI (subprocess): `on_event` is None → emit JSON progress to stdout.
        This is the original mode; main() calls it this way when the script
        is invoked as a subprocess.
      • In-process (callable): pass `on_event=callback(dict)` to receive
        progress updates without subprocess. Used by the bundled EXE where
        cv2 is available in-process and we skip the subprocess hop entirely.

    Returns True on success, raises on failure (callable mode).
    In CLI mode, sys.exit(1) on failure to signal non-zero exit code.
    """
    import cv2
    import numpy as np
    from PIL import Image

    def _emit(payload):
        """Route a status payload to either stdout (CLI) or the callback."""
        if on_event is not None:
            try:
                on_event(payload)
            except Exception:
                pass   # callback errors shouldn't kill the inpainting
        else:
            print(json.dumps(payload), flush=True)

    def _fail(msg):
        _emit({"error": msg})
        if on_event is None:
            sys.exit(1)
        raise RuntimeError(msg)

    # Load mask
    mask_img = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if mask_img is None:
        _fail(f"Cannot read mask: {mask_path}")
        return False

    frames = sorted(input_dir.glob('*.png'))
    total = len(frames)

    if total == 0:
        _fail("No PNG frames found")
        return False

    _emit({"status": f"Processing {total} frames with OpenCV...", "total": total})

    # Check for static watermark fast path
    mask_pil = Image.open(str(mask_path)).convert('L')
    first_pil = Image.open(frames[0]).convert('RGB')
    crop_box, _ = _find_crop_region(mask_pil, first_pil.size)

    if crop_box is not None:
        is_static, _ = _check_static_watermark(frames, crop_box, on_event=on_event)
        if is_static:
            x1, y1, x2, y2 = crop_box
            # Inpaint first frame only
            img = cv2.imread(str(frames[0]))
            h, w = img.shape[:2]
            mh, mw = mask_img.shape[:2]
            cur_mask = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST) if (mh != h or mw != w) else mask_img.copy()
            _, cur_mask = cv2.threshold(cur_mask, 127, 255, cv2.THRESH_BINARY)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            cur_mask = cv2.dilate(cur_mask, kernel, iterations=2)
            result = cv2.inpaint(img, cur_mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            clean_patch = result[y1:y2, x1:x2].copy()

            _emit({"status": f"Static watermark → applying patch to {total} frames (parallel)..."})
            from concurrent.futures import ThreadPoolExecutor
            def _apply_patch_cv(frame_path):
                frame = cv2.imread(str(frame_path))
                frame[y1:y2, x1:x2] = clean_patch
                cv2.imwrite(str(output_dir / frame_path.name), frame)
            with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
                list(pool.map(_apply_patch_cv, frames))

            _emit({"progress": 100, "frame": total, "total": total})
            _emit({"status": "done", "progress": 100})
            return True

    # Full per-frame inpainting
    for i, frame_path in enumerate(frames):
        img = cv2.imread(str(frame_path))
        h, w = img.shape[:2]

        # Resize mask to frame size if needed
        mh, mw = mask_img.shape[:2]
        if mh != h or mw != w:
            cur_mask = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST)
        else:
            cur_mask = mask_img

        # Threshold mask: ensure binary (white = inpaint region)
        _, cur_mask = cv2.threshold(cur_mask, 127, 255, cv2.THRESH_BINARY)

        # Dilate mask slightly to cover anti-aliased edges
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        cur_mask = cv2.dilate(cur_mask, kernel, iterations=2)

        # Run TELEA inpainting (radius=5 works well for text)
        result = cv2.inpaint(img, cur_mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)

        cv2.imwrite(str(output_dir / frame_path.name), result)

        progress = round((i + 1) / total * 100, 1)
        _emit({"progress": progress, "frame": i + 1, "total": total})

    _emit({"status": "done", "progress": 100})
    return True


def _load_lama_model():
    """Load the pre-downloaded LaMa model from TORCH_HOME, or download as fallback."""
    # Check for pre-downloaded model in TORCH_HOME (set by the Electron app)
    torch_home = os.environ.get("TORCH_HOME", "")
    if torch_home:
        local_model = os.path.join(torch_home, "hub", "checkpoints", "big-lama.pt")
        if os.path.isfile(local_model) and os.path.getsize(local_model) > 100 * 1024 * 1024:
            return local_model

    # Fallback: download via simple_lama_inpainting (will use TORCH_HOME if set)
    from simple_lama_inpainting.utils import download_model
    LAMA_MODEL_URL = os.environ.get(
        "LAMA_MODEL_URL",
        "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt",
    )
    return download_model(LAMA_MODEL_URL)


def _find_crop_region(mask_img, frame_size, pad=64):
    """Find watermark bounding box from mask with padding."""
    import numpy as np
    from PIL import Image
    fw, fh = frame_size
    if mask_img.size != frame_size:
        sized_mask = mask_img.resize(frame_size, Image.NEAREST)
    else:
        sized_mask = mask_img
    mask_np = np.array(sized_mask)
    ys, xs = np.where(mask_np > 127)
    if len(ys) == 0:
        return None, None
    y1 = max(0, int(ys.min()) - pad)
    y2 = min(fh, int(ys.max()) + pad)
    x1 = max(0, int(xs.min()) - pad)
    x2 = min(fw, int(xs.max()) + pad)
    return (x1, y1, x2, y2), mask_np


def _check_static_watermark(frames, crop_box, max_check=None, on_event=None):
    """Check if watermark region is identical across all frames.
    Progressive: compare frame[i+1] vs frame[i], stop on first mismatch.
    Returns (is_static, ref_crop_np) where ref_crop_np is the first frame's crop.

    `on_event` (optional callback) is forwarded from run_opencv so this
    helper's status messages reach the in-process caller too.
    """
    import numpy as np
    from PIL import Image

    def _emit(payload):
        if on_event is not None:
            try: on_event(payload)
            except Exception: pass
        else:
            print(json.dumps(payload), flush=True)

    if len(frames) < 2:
        return False, None

    x1, y1, x2, y2 = crop_box
    check_count = len(frames) if max_check is None else min(max_check, len(frames))

    # Load first frame crop as reference
    ref_img = Image.open(frames[0]).convert('RGB')
    ref_crop = np.array(ref_img.crop((x1, y1, x2, y2)), dtype=np.float32)

    _emit({"status": f"Checking static watermark ({check_count} frames)..."})

    for i in range(1, check_count):
        cur_img = Image.open(frames[i]).convert('RGB')
        cur_crop = np.array(cur_img.crop((x1, y1, x2, y2)), dtype=np.float32)

        # Mean absolute difference — threshold 2/255 for JPEG artifacts
        diff = np.mean(np.abs(ref_crop - cur_crop))
        if diff > 2.0:
            _emit({"status": f"Watermark region differs at frame {i+1} (diff={diff:.2f}), using full inpaint"})
            return False, None

        ref_crop = cur_crop  # progressive: compare N vs N-1

    _emit({"status": f"Static watermark detected! All {check_count} frames identical → single inpaint"})
    return True, ref_crop


def _inpaint_frames_on_device(model, device, frames, crop_box, mask_np_full, output_dir, offset=0, total_all=0):
    """Tile multiple frame crops into one large image for GPU inference.
    This gives GPU a much larger workload per inference call, maximizing utilization.
    E.g. 16 crops of 230x175 -> 1 tiled image of 920x700 -> single inference -> split back."""
    import torch
    import numpy as np
    from PIL import Image
    import threading
    from queue import Queue
    import math

    x1, y1, x2, y2 = crop_box
    crop_w, crop_h = x2 - x1, y2 - y1

    # Tile grid: how many crops to fit in one tiled image
    # Target: ~1024-2048px on each side for good GPU utilization
    TILE_COLS = max(1, min(8, 1600 // crop_w))
    TILE_ROWS = max(1, min(8, 1600 // crop_h))
    TILE_COUNT = TILE_COLS * TILE_ROWS  # e.g. 8x8 = 64 crops per tile

    tile_w = TILE_COLS * crop_w
    tile_h = TILE_ROWS * crop_h

    # Build tiled mask (same for every tile)
    mask_crop = mask_np_full[y1:y2, x1:x2]
    tiled_mask = np.tile(mask_crop, (TILE_ROWS, TILE_COLS))
    tiled_mask_np = tiled_mask.astype(np.float32) / 255.0
    tiled_mask_tensor = torch.from_numpy(tiled_mask_np).unsqueeze(0).unsqueeze(0).to(device)
    tiled_mask_tensor = (tiled_mask_tensor > 0.5).float()

    # Pad tiled mask to multiple of 8
    pad_h = (8 - tile_h % 8) % 8
    pad_w_val = (8 - tile_w % 8) % 8
    if pad_h > 0 or pad_w_val > 0:
        tiled_mask_tensor = torch.nn.functional.pad(tiled_mask_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

    # --- Async save thread ---
    save_queue = Queue(maxsize=16)

    def save_worker():
        while True:
            item = save_queue.get()
            if item is None:
                break
            img, fp, result_np = item
            result_np = np.clip(result_np * 255, 0, 255).astype(np.uint8)
            img.paste(Image.fromarray(result_np), (x1, y1))
            img.save(output_dir / fp.name)

    save_thread = threading.Thread(target=save_worker, daemon=True)
    save_thread.start()

    # --- Process in tiled batches ---
    for tile_start in range(0, len(frames), TILE_COUNT):
        tile_frames = frames[tile_start:tile_start + TILE_COUNT]
        actual_count = len(tile_frames)

        # Read crops and build tiled image
        tile_imgs = []
        crops_np = []
        for fp in tile_frames:
            img = Image.open(fp).convert('RGB')
            tile_imgs.append((img, fp))
            crop = np.array(img.crop((x1, y1, x2, y2)), dtype=np.float32) / 255.0
            crops_np.append(crop)

        # Fill remaining slots with last crop (if partial tile)
        while len(crops_np) < TILE_COUNT:
            crops_np.append(crops_np[-1])

        # Assemble tiled image: grid of crops
        rows = []
        for r in range(TILE_ROWS):
            row_crops = crops_np[r * TILE_COLS:(r + 1) * TILE_COLS]
            rows.append(np.concatenate(row_crops, axis=1))  # concat horizontally
        tiled_img = np.concatenate(rows, axis=0)  # concat vertically

        # To tensor
        tiled_tensor = torch.from_numpy(tiled_img).permute(2, 0, 1).unsqueeze(0).to(device)
        if pad_h > 0 or pad_w_val > 0:
            tiled_tensor = torch.nn.functional.pad(tiled_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

        # Single inference on large tiled image
        with torch.inference_mode():
            result = model(tiled_tensor, tiled_mask_tensor)

        result_np = result[0, :, :tile_h, :tile_w].permute(1, 2, 0).detach().cpu().numpy()

        # Split tiled result back into individual crops
        for idx in range(actual_count):
            r = idx // TILE_COLS
            c = idx % TILE_COLS
            crop_result = result_np[r * crop_h:(r + 1) * crop_h, c * crop_w:(c + 1) * crop_w]
            img, fp = tile_imgs[idx]
            save_queue.put((img, fp, crop_result))

        # Report progress per frame
        done = tile_start + actual_count
        progress = round(done / len(frames) * 100, 1)
        print(json.dumps({"progress": progress, "frame": done, "total": len(frames)}), flush=True)

    save_queue.put(None)
    save_thread.join()
    return len(frames)


def _benchmark_device(model, device, sample_tensor, mask_tensor, crop_h, crop_w, runs=3):
    """Quick benchmark: time a few inferences on the given device."""
    import torch
    import time
    m = torch.jit.load(model, map_location=device)
    m.eval()
    m.to(device)
    t = sample_tensor.to(device)
    mk = mask_tensor.to(device)
    # Warmup
    with torch.inference_mode():
        m(t, mk)
    # Benchmark
    times = []
    for _ in range(runs):
        start = time.perf_counter()
        with torch.inference_mode():
            m(t, mk)
        if device.type == 'cuda':
            torch.cuda.synchronize()
        times.append(time.perf_counter() - start)
    return sum(times) / len(times)


def run_lama(input_dir, mask_path, output_dir, device_mode='auto', gpu_ratio=70):
    """High-quality inpainting using LaMa. Supports: auto, cpu, cuda, split (CPU+GPU concurrent)."""
    import torch
    import numpy as np
    from PIL import Image

    print(json.dumps({"status": "Loading LaMa model..."}), flush=True)
    try:
        model_file = _load_lama_model()
    except Exception as e:
        print(json.dumps({"error": f"Failed to download model: {e}"}))
        sys.exit(1)

    has_cuda = torch.cuda.is_available()

    # Resolve device mode
    if device_mode == 'auto':
        device_mode = 'cuda' if has_cuda else 'cpu'
    if device_mode == 'cuda' and not has_cuda:
        print(json.dumps({"status": "CUDA not available, falling back to CPU"}), flush=True)
        device_mode = 'cpu'
    if device_mode == 'split' and not has_cuda:
        print(json.dumps({"status": "CUDA not available, using CPU only"}), flush=True)
        device_mode = 'cpu'

    mask_img = Image.open(mask_path).convert('L')
    frames = sorted(input_dir.glob('*.png'))
    total = len(frames)

    if total == 0:
        print(json.dumps({"error": "No PNG frames found"}))
        sys.exit(1)

    # Find crop region
    first_frame = Image.open(frames[0]).convert('RGB')
    crop_box, mask_np_full = _find_crop_region(mask_img, first_frame.size)
    if crop_box is None:
        print(json.dumps({"error": "Mask is empty - no watermark region found"}))
        sys.exit(1)

    crop_w = crop_box[2] - crop_box[0]
    crop_h = crop_box[3] - crop_box[1]
    fw, fh = first_frame.size

    # ---- FAST PATH: Static watermark → inpaint once, paste to all ----
    is_static, _ = _check_static_watermark(frames, crop_box)
    if is_static:
        x1, y1, x2, y2 = crop_box
        print(json.dumps({"status": "Static watermark → inpainting single frame..."}), flush=True)

        # Load model on best device
        device = torch.device('cuda' if has_cuda else 'cpu')
        model = torch.jit.load(model_file, map_location=device)
        model.eval()
        model.to(device)

        # Inpaint first frame only
        ref_crop = np.array(first_frame.crop((x1, y1, x2, y2)), dtype=np.float32) / 255.0
        crop_tensor = torch.from_numpy(ref_crop).permute(2, 0, 1).unsqueeze(0).to(device)
        mask_crop_np = mask_np_full[y1:y2, x1:x2].astype(np.float32) / 255.0
        mask_tensor = torch.from_numpy(mask_crop_np).unsqueeze(0).unsqueeze(0).to(device)
        mask_tensor = (mask_tensor > 0.5).float()

        # Pad to multiple of 8
        pad_h = (8 - crop_h % 8) % 8
        pad_w_val = (8 - crop_w % 8) % 8
        if pad_h > 0 or pad_w_val > 0:
            crop_tensor = torch.nn.functional.pad(crop_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')
            mask_tensor = torch.nn.functional.pad(mask_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

        with torch.inference_mode():
            result = model(crop_tensor, mask_tensor)

        clean_patch_np = result[0, :, :crop_h, :crop_w].permute(1, 2, 0).detach().cpu().numpy()
        clean_patch = Image.fromarray(np.clip(clean_patch_np * 255, 0, 255).astype(np.uint8))

        print(json.dumps({"status": f"Applying clean patch to all {total} frames (parallel)..."}), flush=True)
        from concurrent.futures import ThreadPoolExecutor
        def _apply_patch_pil(fp):
            img = Image.open(fp).convert('RGB')
            img.paste(clean_patch, (x1, y1))
            img.save(output_dir / fp.name)
        with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
            list(pool.map(_apply_patch_pil, frames))

        print(json.dumps({"progress": 100, "frame": total, "total": total}), flush=True)
        print(json.dumps({"status": "done", "progress": 100}), flush=True)
        return

    if device_mode == 'split':
        # ---- SPLIT MODE: CPU + GPU concurrent ----
        gpu_count = max(1, int(total * gpu_ratio / 100))
        cpu_count = total - gpu_count
        gpu_frames = frames[:gpu_count]
        cpu_frames = frames[gpu_count:]

        # Define devices first (needed for benchmark and model loading)
        gpu_device = torch.device('cuda')
        cpu_device = torch.device('cpu')

        # Benchmark both devices to find optimal split
        print(json.dumps({"status": "Benchmarking GPU vs CPU speed..."}), flush=True)
        sample_crop = np.array(first_frame.crop(crop_box), dtype=np.float32) / 255.0
        sample_tensor = torch.from_numpy(sample_crop).permute(2, 0, 1).unsqueeze(0)
        bm_pad_h = (8 - crop_h % 8) % 8
        bm_pad_w = (8 - crop_w % 8) % 8
        if bm_pad_h > 0 or bm_pad_w > 0:
            sample_tensor = torch.nn.functional.pad(sample_tensor, (0, bm_pad_w, 0, bm_pad_h), mode='reflect')
        bm_mask = torch.from_numpy(mask_np_full[crop_box[1]:crop_box[3], crop_box[0]:crop_box[2]].astype(np.float32) / 255.0).unsqueeze(0).unsqueeze(0)
        bm_mask = (bm_mask > 0.5).float()
        if bm_pad_h > 0 or bm_pad_w > 0:
            bm_mask = torch.nn.functional.pad(bm_mask, (0, bm_pad_w, 0, bm_pad_h), mode='reflect')

        try:
            gpu_time = _benchmark_device(model_file, gpu_device, sample_tensor, bm_mask, crop_h, crop_w)
            cpu_time = _benchmark_device(model_file, cpu_device, sample_tensor, bm_mask, crop_h, crop_w)
            speed_ratio = cpu_time / gpu_time  # e.g. GPU is 5x faster
            gpu_ratio = int(round(speed_ratio / (1 + speed_ratio) * 100))
            gpu_ratio = max(10, min(95, gpu_ratio))
            print(json.dumps({
                "status": f"Benchmark: GPU {gpu_time*1000:.0f}ms vs CPU {cpu_time*1000:.0f}ms (GPU {speed_ratio:.1f}x faster) -> GPU {gpu_ratio}%",
            }), flush=True)
        except Exception as e:
            print(json.dumps({"status": f"Benchmark failed ({e}), using default {gpu_ratio}%"}), flush=True)

        gpu_count = max(1, int(total * gpu_ratio / 100))
        cpu_count = total - gpu_count
        gpu_frames = frames[:gpu_count]
        cpu_frames = frames[gpu_count:]

        print(json.dumps({
            "status": f"Split: GPU {gpu_count} frames ({gpu_ratio}%) + CPU {cpu_count} frames ({100-gpu_ratio}%) | crop {crop_w}x{crop_h}",
        }), flush=True)

        # Load model on both devices
        gpu_model = torch.jit.load(model_file, map_location=gpu_device)
        gpu_model.eval()
        gpu_model.to(gpu_device)
        cpu_model = torch.jit.load(model_file, map_location=cpu_device)
        cpu_model.eval()

        import threading
        results = {'gpu': 0, 'cpu': 0}
        errors = []

        def run_gpu():
            try:
                results['gpu'] = _inpaint_frames_on_device(
                    gpu_model, gpu_device, gpu_frames, crop_box, mask_np_full, output_dir, 0, total)
            except Exception as e:
                errors.append(f"GPU error: {e}")

        def run_cpu():
            try:
                results['cpu'] = _inpaint_frames_on_device(
                    cpu_model, cpu_device, cpu_frames, crop_box, mask_np_full, output_dir, gpu_count, total)
            except Exception as e:
                errors.append(f"CPU error: {e}")

        gpu_thread = threading.Thread(target=run_gpu)
        cpu_thread = threading.Thread(target=run_cpu)

        gpu_thread.start()
        cpu_thread.start()

        # Report progress while threads run
        import time
        while gpu_thread.is_alive() or cpu_thread.is_alive():
            done = 0
            for fp in frames:
                if (output_dir / fp.name).exists():
                    done += 1
            progress = round(done / total * 100, 1)
            print(json.dumps({"progress": progress, "frame": done, "total": total,
                              "status": f"Split: GPU+CPU | {done}/{total}"}), flush=True)
            time.sleep(0.5)

        gpu_thread.join()
        cpu_thread.join()

        if errors:
            print(json.dumps({"error": "; ".join(errors)}))
            sys.exit(1)

    else:
        # ---- SINGLE DEVICE MODE (cpu or cuda) ----
        device = torch.device(device_mode)
        dev_label = 'GPU (CUDA)' if device_mode == 'cuda' else 'CPU'
        print(json.dumps({"status": f"Using {dev_label} | crop {crop_w}x{crop_h} (was {fw}x{fh})"}), flush=True)

        model = torch.jit.load(model_file, map_location=device)
        model.eval()
        model.to(device)

        # Pre-compute mask tensor
        mask_crop_np = mask_np_full[crop_box[1]:crop_box[3], crop_box[0]:crop_box[2]].astype(np.float32) / 255.0
        mask_crop_tensor = torch.from_numpy(mask_crop_np).unsqueeze(0).unsqueeze(0).to(device)
        mask_crop_tensor = (mask_crop_tensor > 0.5).float()

        pad_h = (8 - crop_h % 8) % 8
        pad_w_val = (8 - crop_w % 8) % 8
        if pad_h > 0 or pad_w_val > 0:
            mask_crop_tensor = torch.nn.functional.pad(mask_crop_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

        # Use the optimized pipeline function (prefetch + batch + fp16 + async save)
        print(json.dumps({"status": f"Processing {total} frames on {dev_label}...", "total": total}), flush=True)
        _inpaint_frames_on_device(model, device, frames, crop_box, mask_np_full, output_dir)

    print(json.dumps({"status": "done", "progress": 100}), flush=True)


def run_sttn(input_dir, mask_path, output_dir):
    """Video inpainting using STTN (Spatial-Temporal Transformer Network).
    Uses temporal attention across neighboring frames for flicker-free results."""
    import torch
    import numpy as np
    from PIL import Image
    import cv2

    # Find STTN installation
    sttn_dir = None
    for candidate in [
        Path(os.environ.get('STTN_DIR', '')),
        Path.home() / 'AppData' / 'Roaming' / 'toolshelper' / 'sttn',
        Path(__file__).parent.parent / 'sttn',
    ]:
        if (candidate / 'model' / 'sttn.py').exists():
            sttn_dir = candidate
            break

    if sttn_dir is None:
        print(json.dumps({"error": "STTN not installed. Please install STTN first."}))
        sys.exit(1)

    model_path = sttn_dir / 'sttn.pth'
    if not model_path.exists():
        print(json.dumps({"error": "STTN model weights not found. Please reinstall STTN."}))
        sys.exit(1)

    # Add STTN repo to path and import model
    sys.path.insert(0, str(sttn_dir))
    print(json.dumps({"status": "Loading STTN model..."}), flush=True)

    try:
        from model.sttn import InpaintGenerator
    except ImportError as e:
        print(json.dumps({"error": f"Failed to import STTN model: {e}"}))
        sys.exit(1)

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(json.dumps({"status": f"Loading STTN model on {device}..."}), flush=True)
    net = InpaintGenerator()
    data = torch.load(str(model_path), map_location=device)
    net.load_state_dict(data['netG'])
    net.eval()
    net.to(device)

    # STTN processes at 480x864 (encoder outputs 60x108)
    PROC_H, PROC_W = 480, 864

    # Load mask and resize to processing resolution
    mask_img = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    mask_proc = cv2.resize(mask_img, (PROC_W, PROC_H), interpolation=cv2.INTER_NEAREST)
    _, mask_proc = cv2.threshold(mask_proc, 127, 255, cv2.THRESH_BINARY)
    # Dilate slightly
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask_proc = cv2.dilate(mask_proc, kernel, iterations=2)
    mask_tensor = torch.from_numpy(mask_proc.astype(np.float32) / 255.0).unsqueeze(0)  # [1, H, W]

    frames = sorted(input_dir.glob('*.png'))
    total = len(frames)

    if total == 0:
        print(json.dumps({"error": "No PNG frames found"}))
        sys.exit(1)

    print(json.dumps({"status": f"Processing {total} frames with STTN...", "total": total}), flush=True)

    # Load all frames into memory at processing resolution
    all_frames = []
    orig_sizes = []
    for fp in frames:
        img = cv2.imread(str(fp))
        orig_sizes.append((img.shape[1], img.shape[0]))  # (W, H)
        img_resized = cv2.resize(img, (PROC_W, PROC_H))
        img_rgb = cv2.cvtColor(img_resized, cv2.COLOR_BGR2RGB)
        img_tensor = torch.from_numpy(img_rgb.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1)  # [3, H, W] range [-1, 1]
        all_frames.append(img_tensor)

    # Process in sliding windows (window size = 5 for temporal context)
    WINDOW = min(5, total)

    with torch.inference_mode():
        for i in range(total):
            # Build temporal window centered on frame i
            half = WINDOW // 2
            start = max(0, i - half)
            end = min(total, start + WINDOW)
            start = max(0, end - WINDOW)

            window_frames = all_frames[start:end]
            T = len(window_frames)

            # STTN forward expects: (masked_frames [B,T,3,H,W], masks [B,T,1,H,W])
            imgs = torch.stack(window_frames, dim=0)  # [T, 3, H, W]
            masks = mask_tensor.unsqueeze(0).expand(T, -1, -1, -1)  # [T, 1, H, W]

            # Mask the frames (zero out watermark region)
            masked_frames = (imgs * (1 - masks)).unsqueeze(0).to(device)  # [1, T, 3, H, W]
            masks_input = masks.unsqueeze(0).to(device)  # [1, T, 1, H, W]

            # Run model — output is [B*T, 3, H, W]
            output = net(masked_frames, masks_input)  # [B*T, 3, H, W]

            # Get the frame corresponding to index i within the window
            idx_in_window = i - start
            result = output[idx_in_window]  # [3, H, W]
            result = result.permute(1, 2, 0).detach().cpu().numpy()  # [H, W, 3]
            result = np.clip((result + 1) / 2 * 255, 0, 255).astype(np.uint8)  # tanh output [-1,1] -> [0,255]

            # Composite: only replace masked region
            orig_frame = cv2.imread(str(frames[i]))
            orig_w, orig_h = orig_sizes[i]
            result_bgr = cv2.cvtColor(result, cv2.COLOR_RGB2BGR)
            result_full = cv2.resize(result_bgr, (orig_w, orig_h))

            # Create full-res mask
            mask_full = cv2.resize(mask_proc, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
            mask_3ch = np.stack([mask_full] * 3, axis=-1).astype(np.float32) / 255.0

            # Blend
            composite = (orig_frame * (1 - mask_3ch) + result_full * mask_3ch).astype(np.uint8)
            cv2.imwrite(str(output_dir / frames[i].name), composite)

            progress = round((i + 1) / total * 100, 1)
            print(json.dumps({"progress": progress, "frame": i + 1, "total": total}), flush=True)

    print(json.dumps({"status": "done", "progress": 100}), flush=True)


def run_propainter(input_dir, mask_path, output_dir):
    """Video inpainting using ProPainter (ICCV 2023).
    Uses optical flow propagation + transformer for state-of-the-art quality."""
    import subprocess
    import cv2
    import shutil

    # Find ProPainter installation
    pp_dir = None
    for candidate in [
        Path(os.environ.get('PROPAINTER_DIR', '')),
        Path.home() / 'AppData' / 'Roaming' / 'toolshelper' / 'propainter',
        Path(__file__).parent.parent / 'propainter',
    ]:
        if (candidate / 'inference_propainter.py').exists():
            pp_dir = candidate
            break

    if pp_dir is None:
        print(json.dumps({"error": "ProPainter not installed. Please install ProPainter first."}))
        sys.exit(1)

    weights_dir = pp_dir / 'weights'
    if not (weights_dir / 'ProPainter.pth').exists():
        print(json.dumps({"error": "ProPainter model weights not found. Please reinstall."}))
        sys.exit(1)

    frames = sorted(input_dir.glob('*.png'))
    total = len(frames)
    if total == 0:
        print(json.dumps({"error": "No PNG frames found"}))
        sys.exit(1)

    # ProPainter expects: video_frames/ and masks/ directories
    # masks/ should have one mask per frame (same mask duplicated)
    temp_masks = input_dir.parent / 'pp_masks'
    temp_masks.mkdir(parents=True, exist_ok=True)

    print(json.dumps({"status": "Preparing masks for ProPainter...", "progress": 5}), flush=True)

    # Read mask and create per-frame masks
    mask_img = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    _, mask_bin = cv2.threshold(mask_img, 127, 255, cv2.THRESH_BINARY)
    # Dilate mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask_bin = cv2.dilate(mask_bin, kernel, iterations=2)

    # Get frame size and resize mask
    sample_frame = cv2.imread(str(frames[0]))
    fh, fw = sample_frame.shape[:2]
    mask_resized = cv2.resize(mask_bin, (fw, fh), interpolation=cv2.INTER_NEAREST)

    for frame_path in frames:
        cv2.imwrite(str(temp_masks / frame_path.name), mask_resized)

    print(json.dumps({"status": f"Running ProPainter on {total} frames (GPU)...", "progress": 10}), flush=True)

    # Call ProPainter's inference script
    cmd = [
        sys.executable,
        str(pp_dir / 'inference_propainter.py'),
        '--video', str(input_dir),
        '--mask', str(temp_masks),
        '--output', str(output_dir.parent / 'pp_output'),
        '--save_frames',
        '--fp16',  # Use half precision for speed
    ]

    try:
        # Merge stdout+stderr so we capture everything
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(pp_dir),
            text=True,
            bufsize=1
        )

        output_log = []
        import re
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            output_log.append(line)

            # Try to parse frame progress (e.g. "frame 10/120", "100%|", "Processing 50 frames")
            pct = 10
            status = line[:100]

            # Detect tqdm-style progress bars
            pct_match = re.search(r'(\d+)%', line)
            frame_match = re.search(r'(\d+)/(\d+)', line)

            if pct_match:
                pct = min(int(pct_match.group(1)), 90)
                pct = max(pct, 10)  # keep in 10-90 range
            elif frame_match:
                cur, tot = int(frame_match.group(1)), int(frame_match.group(2))
                if tot > 0:
                    pct = int(10 + (cur / tot) * 80)

            if 'optical flow' in line.lower() or 'flow' in line.lower():
                status = f"Computing optical flow... {pct}%"
            elif 'propagat' in line.lower():
                status = f"Propagating features... {pct}%"
            elif 'inpaint' in line.lower() or 'transform' in line.lower():
                status = f"Transformer inpainting... {pct}%"
            elif 'sav' in line.lower():
                status = f"Saving frames... {pct}%"
                pct = max(pct, 85)

            print(json.dumps({"status": status, "progress": pct}), flush=True)

        proc.wait()

        if proc.returncode != 0:
            error_tail = '\n'.join(output_log[-10:])
            print(json.dumps({"error": f"ProPainter failed (code {proc.returncode}): {error_tail}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": f"ProPainter execution failed: {e}"}))
        sys.exit(1)

    # Collect output frames from ProPainter's output directory
    pp_out = output_dir.parent / 'pp_output'
    # ProPainter saves to a subdirectory
    result_dirs = list(pp_out.glob('*/frames'))
    if not result_dirs:
        result_dirs = list(pp_out.glob('*'))

    # Find the actual output frames
    output_frames = []
    for d in result_dirs:
        if d.is_dir():
            pngs = sorted(d.glob('*.png'))
            if pngs:
                output_frames = pngs
                break
        elif d.suffix == '.png':
            output_frames.append(d)

    if not output_frames:
        # Try finding directly
        output_frames = sorted(pp_out.rglob('*.png'))

    if output_frames:
        print(json.dumps({"status": f"Copying {len(output_frames)} output frames...", "progress": 90}), flush=True)
        for i, fp in enumerate(output_frames):
            if i < len(frames):
                shutil.copy2(str(fp), str(output_dir / frames[i].name))
    else:
        print(json.dumps({"error": "No output frames found from ProPainter"}))
        sys.exit(1)

    # Cleanup temp
    shutil.rmtree(str(temp_masks), ignore_errors=True)
    shutil.rmtree(str(pp_out), ignore_errors=True)

    print(json.dumps({"status": "done", "progress": 100}), flush=True)


def main():
    if len(sys.argv) < 5:
        print(json.dumps({"error": "Usage: lama_inpaint.py <method> <input_dir> <mask_path> <output_dir> [--device cpu|cuda|split] [--gpu-ratio 70]"}))
        sys.exit(1)

    method = sys.argv[1]
    input_dir = Path(sys.argv[2])
    mask_path = Path(sys.argv[3])
    output_dir = Path(sys.argv[4])

    # Parse optional --device and --gpu-ratio
    device_mode = 'auto'  # auto, cpu, cuda, split
    gpu_ratio = 70  # percentage of frames on GPU when split

    args = sys.argv[5:]
    i = 0
    while i < len(args):
        if args[i] == '--device' and i + 1 < len(args):
            device_mode = args[i + 1]
            i += 2
        elif args[i] == '--gpu-ratio' and i + 1 < len(args):
            gpu_ratio = int(args[i + 1])
            i += 2
        else:
            # Legacy: extra dir for STTN/ProPainter
            os.environ['STTN_DIR'] = args[i]
            os.environ['PROPAINTER_DIR'] = args[i]
            i += 1

    output_dir.mkdir(parents=True, exist_ok=True)

    if method == 'opencv':
        run_opencv(input_dir, mask_path, output_dir)
    elif method == 'lama':
        run_lama(input_dir, mask_path, output_dir, device_mode, gpu_ratio)
    elif method == 'sttn':
        run_sttn(input_dir, mask_path, output_dir)
    elif method == 'propainter':
        run_propainter(input_dir, mask_path, output_dir)
    else:
        print(json.dumps({"error": f"Unknown method: {method}. Use 'lama', 'opencv', 'sttn', or 'propainter'"}))
        sys.exit(1)


if __name__ == '__main__':
    main()


