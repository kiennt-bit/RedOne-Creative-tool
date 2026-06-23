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


def run_opencv(input_dir, mask_path, output_dir):
    """Fast inpainting using OpenCV TELEA algorithm."""
    import cv2
    import numpy as np
    from PIL import Image

    # Load mask
    mask_img = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if mask_img is None:
        print(json.dumps({"error": f"Cannot read mask: {mask_path}"}))
        sys.exit(1)

    frames = sorted(input_dir.glob('*.png'))
    total = len(frames)

    if total == 0:
        print(json.dumps({"error": "No PNG frames found"}))
        sys.exit(1)

    print(json.dumps({"status": f"Processing {total} frames with OpenCV...", "total": total}), flush=True)

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
        print(json.dumps({"progress": progress, "frame": i + 1, "total": total}), flush=True)

    print(json.dumps({"status": "done", "progress": 100}), flush=True)


def _load_lama_model():
    """Load the LaMa model, preferring local TORCH_HOME path."""
    # Check local model first (set by ToolsHelper via TORCH_HOME env)
    torch_home = os.environ.get("TORCH_HOME", "")
    if torch_home:
        local_model = os.path.join(torch_home, "hub", "checkpoints", "big-lama.pt")
        if os.path.isfile(local_model) and os.path.getsize(local_model) > 100 * 1024 * 1024:
            return local_model

    # Fallback: try default torch cache location
    default_cache = os.path.join(os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints", "big-lama.pt")
    if os.path.isfile(default_cache) and os.path.getsize(default_cache) > 100 * 1024 * 1024:
        return default_cache

    # Last resort: download
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


def _inpaint_frames_on_device(model, device, frames, crop_box, mask_np_full, output_dir, offset=0, total_all=0, pre_cropped=False, watermark_rgb=None,
                              no_demix=False, no_temporal=False, no_noise=False):
    """Inpaint multiple frame crops using standard PyTorch batching.
    Processes crops independently along the batch dimension [B, C, H, W] to avoid cross-frame artifacts.
    Also implements:
    1. Temporal Smoothing (EMA) to prevent frame-to-frame flickering.
    2. Noise/Grain Matching to restore original camera sensor noise.
    3. Soft Mask Blending (Feathering) for seamless border transitions."""
    import torch
    import numpy as np
    from PIL import Image
    import threading
    from queue import Queue
    import cv2

    x1, y1, x2, y2 = crop_box
    crop_w, crop_h = x2 - x1, y2 - y1

    # Extract mask crop
    mask_crop = mask_np_full[y1:y2, x1:x2]
    mask_crop_np = mask_crop.astype(np.float32) / 255.0

    # Generate binary dilated mask for the AI model to ensure full coverage of text and outlines.
    # We use a 5x5 ellipse kernel with 2 iterations to expand the mask by ~4 pixels,
    # covering any glowing or bright outlines/shadows surrounding the logo.
    kernel_ai = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask_ai_np = (mask_crop_np > 0.05).astype(np.float32)
    mask_ai_dilated = cv2.dilate(mask_ai_np, kernel_ai, iterations=2)
    
    mask_tensor = torch.from_numpy(mask_ai_dilated).unsqueeze(0).unsqueeze(0).to(device)

    # Pre-compute soft blurred mask for seamless alpha blending (feathering).
    # We use a 15x15 Gaussian blur on the dilated mask to ensure a highly smooth transition
    # at the border of the inpainting area.
    mask_blur = cv2.GaussianBlur(mask_ai_dilated, (15, 15), 0)
    mask_blur_3d = np.expand_dims(mask_blur, axis=-1)

    # Pad mask to multiple of 8 (required by LaMa)
    pad_h = (8 - crop_h % 8) % 8
    pad_w_val = (8 - crop_w % 8) % 8
    if pad_h > 0 or pad_w_val > 0:
        mask_tensor = torch.nn.functional.pad(mask_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

    # Determine batch size based on device type to optimize speed and memory
    if device.type == 'cuda':
        batch_size = 64
    else:
        batch_size = 4

    # Setup default watermark color (white) if not provided
    if watermark_rgb is None:
        watermark_rgb = np.ones((crop_h, crop_w, 3), dtype=np.float32)

    # --- Async save thread ---
    save_queue = Queue(maxsize=32)

    def save_worker():
        while True:
            item = save_queue.get()
            if item is None:
                break
            img, fp, result_np = item
            result_np = np.clip(result_np * 255, 0, 255).astype(np.uint8)
            if pre_cropped:
                Image.fromarray(result_np).save(output_dir / fp.name)
            else:
                img.paste(Image.fromarray(result_np), (x1, y1))
                img.save(output_dir / fp.name)

    save_thread = threading.Thread(target=save_worker, daemon=True)
    save_thread.start()

    # State for temporal smoothing across batch boundaries
    prev_crop_result = None

    # --- Process in batches ---
    for batch_start in range(0, len(frames), batch_size):
        batch_frames = frames[batch_start:batch_start + batch_size]
        actual_count = len(batch_frames)

        # Read crop frames
        crops_np = []
        batch_imgs = []
        for fp in batch_frames:
            img = Image.open(fp).convert('RGB')
            if pre_cropped:
                crop = np.array(img, dtype=np.float32) / 255.0
                batch_imgs.append((None, fp))
            else:
                batch_imgs.append((img, fp))
                crop = np.array(img.crop((x1, y1, x2, y2)), dtype=np.float32) / 255.0
            crops_np.append(crop)

        # Stack into batch tensor: [B, H, W, C] -> [B, C, H, W]
        batch_tensor = torch.from_numpy(np.stack(crops_np, axis=0)).permute(0, 3, 1, 2).to(device)
        if pad_h > 0 or pad_w_val > 0:
            batch_tensor = torch.nn.functional.pad(batch_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

        # Expand mask tensor to match the actual batch size
        batch_mask = mask_tensor.expand(actual_count, -1, -1, -1)

        # Inference
        with torch.inference_mode():
            result = model(batch_tensor, batch_mask)

        # Crop back to original dimensions
        result = result[:, :, :crop_h, :crop_w]
        result_np = result.permute(0, 2, 3, 1).detach().cpu().numpy()

        # Post-processing: temporal smoothing, noise injection, and soft blending
        for idx in range(actual_count):
            crop_result = result_np[idx]
            orig_crop = crops_np[idx]

            # 1. Temporal Smoothing (EMA): Dampen frame-to-frame flicker on AI output
            if not no_temporal and prev_crop_result is not None:
                crop_result = 0.85 * crop_result + 0.15 * prev_crop_result
            prev_crop_result = crop_result.copy()

            # 2. Pure AI mode: crop_result is the raw AI output, which covers the entire dilated region.
            # Watermark De-mixing has been removed to avoid background artifacts and ensure maximum clean output.
            pass

            # 3. Noise/Grain Matching: Calculate background camera grain and inject it into the patch
            if not no_noise:
                orig_gray = cv2.cvtColor((orig_crop * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                laplacian = cv2.Laplacian(orig_gray, cv2.CV_32F, ksize=3)
                bg_pixels = laplacian[mask_crop < 127]
                if len(bg_pixels) > 0:
                    # Standard deviation of Laplacian / sqrt(8) approximates sensor noise std
                    noise_std = (np.std(bg_pixels) / 2.828) / 255.0
                else:
                    noise_std = 0.005
                
                # Keep noise standard deviation within natural limits
                noise_std = np.clip(noise_std, 0.001, 0.015)
                
                # Add Gaussian noise
                noise = np.random.normal(0, noise_std, crop_result.shape).astype(np.float32)
                crop_result = crop_result + noise
                crop_result = np.clip(crop_result, 0.0, 1.0)

            # 4. Soft Mask Blending (Feathering): Seamless transition at the boundary
            blended_crop = crop_result * mask_blur_3d + orig_crop * (1.0 - mask_blur_3d)

            img, fp = batch_imgs[idx]
            save_queue.put((img, fp, blended_crop))

        # Report progress per frame
        done = batch_start + actual_count
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


def run_lama(input_dir, mask_path, output_dir, device_mode='auto', gpu_ratio=70,
             orig_width=None, orig_height=None, crop_x=None, crop_y=None, crop_w=None, crop_h=None,
             no_demix=False, no_temporal=False, no_noise=False):
    """High-quality inpainting using LaMa. Supports: auto, cpu, cuda, split (CPU+GPU concurrent)."""
    import torch
    import numpy as np
    from PIL import Image
    import cv2

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

    original_mask = Image.open(mask_path)
    
    # Extract alpha and RGB from RGBA mask generated by FFmpeg (pixel-perfect alignment)
    if original_mask.mode in ('RGBA', 'LA') or (original_mask.mode == 'P' and 'transparency' in original_mask.info):
        mask_rgba = original_mask.convert('RGBA')
        mask_img = mask_rgba.getchannel('A')
        watermark_rgb_full = np.array(mask_rgba.convert('RGB'), dtype=np.float32) / 255.0
    else:
        # Backward compatibility for grayscale masks
        mask_img = original_mask.convert('L')
        watermark_rgb_full = None

    frames = sorted(list(input_dir.glob('*.png')) + list(input_dir.glob('*.jpg')))
    total = len(frames)

    if total == 0:
        print(json.dumps({"error": "No image frames found"}))
        sys.exit(1)

    # Detect if frames are already pre-cropped (small crop frames from FFmpeg).
    # IMPORTANT: do NOT treat "mask same size as frame" as pre-cropped. The
    # video pipeline (watermark_video.py) always extracts FULL frames and may
    # pass a FULL-resolution mask — e.g. the user-drawn region mask is generated
    # at the video's native size, and the Veo mask can match a 4K frame. Using
    # the size-equality heuristic there wrongly enabled pre-cropped mode, which
    # ran LaMa over the WHOLE frame and SAVED the whole-frame output (overwriting
    # everything) instead of inpainting just the masked region and pasting it
    # back onto the original frame -> the entire video came out black/garbled.
    # Genuine pre-cropped frames are tiny (a watermark crop), caught by <500.
    first_frame = Image.open(frames[0]).convert('RGB')
    fw, fh = first_frame.size
    mask_w, mask_h = mask_img.size
    pre_cropped = (fw < 500 and fh < 500)
    if pre_cropped:
        # Frames are already cropped to watermark region; the whole frame IS the crop
        crop_box = (0, 0, fw, fh)
        mask_np_full = np.array(mask_img.resize((fw, fh), Image.NEAREST))
        print(json.dumps({"status": f"Pre-cropped mode: {fw}x{fh} frames, mask resized to match"}), flush=True)
    else:
        crop_box, mask_np_full = _find_crop_region(mask_img, first_frame.size)
        if crop_box is None:
            print(json.dumps({"error": "Mask is empty - no watermark region found"}))
            sys.exit(1)

    crop_w = crop_box[2] - crop_box[0]
    crop_h = crop_box[3] - crop_box[1]

    # --- Load watermark original colors from the mask channels (pixel-perfect) ---
    watermark_rgb = None
    if watermark_rgb_full is not None:
        watermark_rgb = watermark_rgb_full[crop_box[1]:crop_box[3], crop_box[0]:crop_box[2]]
    else:
        # Fallback to loading static veo3watermark.png (only if mask is not RGBA)
        watermark_path = Path(__file__).parent / "veo3watermark.png"
        if watermark_path.exists():
            try:
                watermark_img = Image.open(watermark_path).convert('RGBA')
                if pre_cropped and orig_width and orig_height and crop_x is not None and crop_y is not None:
                    # Scale watermark to original video size, then crop to match frames
                    watermark_resized = watermark_img.resize((orig_width, orig_height), Image.BILINEAR)
                    watermark_crop = watermark_resized.crop((crop_x, crop_y, crop_x + crop_w, crop_y + crop_h))
                    if watermark_crop.size != (fw, fh):
                        watermark_crop = watermark_crop.resize((fw, fh), Image.BILINEAR)
                    watermark_rgb = np.array(watermark_crop.convert('RGB'), dtype=np.float32) / 255.0
                elif not pre_cropped:
                    # Scale watermark to full frame size, then crop using crop_box
                    watermark_resized = watermark_img.resize(first_frame.size, Image.BILINEAR)
                    watermark_crop = watermark_resized.crop(crop_box)
                    watermark_rgb = np.array(watermark_crop.convert('RGB'), dtype=np.float32) / 255.0
            except Exception as e:
                print(json.dumps({"status": f"Warning: Failed to load/process static watermark colors ({e})"}), flush=True)

    if device_mode == 'split':
        # ---- SPLIT MODE: CPU + GPU concurrent ----
        gpu_count = max(1, int(total * gpu_ratio / 100))
        cpu_count = total - gpu_count
        gpu_frames = frames[:gpu_count]
        cpu_frames = frames[gpu_count:]

        # Load devices
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
        
        bm_mask_np = mask_np_full[crop_box[1]:crop_box[3], crop_box[0]:crop_box[2]].astype(np.float32) / 255.0
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        bm_mask_ai = (bm_mask_np > 0.05).astype(np.float32)
        bm_mask_dilated = cv2.dilate(bm_mask_ai, kernel, iterations=1)
        bm_mask = torch.from_numpy(bm_mask_dilated).unsqueeze(0).unsqueeze(0)
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
                    gpu_model, gpu_device, gpu_frames, crop_box, mask_np_full, output_dir, 0, total, pre_cropped=pre_cropped, watermark_rgb=watermark_rgb,
                    no_demix=no_demix, no_temporal=no_temporal, no_noise=no_noise)
            except Exception as e:
                errors.append(f"GPU error: {e}")

        def run_cpu():
            try:
                results['cpu'] = _inpaint_frames_on_device(
                    cpu_model, cpu_device, cpu_frames, crop_box, mask_np_full, output_dir, gpu_count, total, pre_cropped=pre_cropped, watermark_rgb=watermark_rgb,
                    no_demix=no_demix, no_temporal=no_temporal, no_noise=no_noise)
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

        # Pre-compute mask tensor using dilation to match inference
        mask_crop_np = mask_np_full[crop_box[1]:crop_box[3], crop_box[0]:crop_box[2]].astype(np.float32) / 255.0
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        mask_ai_np = (mask_crop_np > 0.05).astype(np.float32)
        mask_ai_dilated = cv2.dilate(mask_ai_np, kernel, iterations=1)
        mask_crop_tensor = torch.from_numpy(mask_ai_dilated).unsqueeze(0).unsqueeze(0).to(device)

        pad_h = (8 - crop_h % 8) % 8
        pad_w_val = (8 - crop_w % 8) % 8
        if pad_h > 0 or pad_w_val > 0:
            mask_crop_tensor = torch.nn.functional.pad(mask_crop_tensor, (0, pad_w_val, 0, pad_h), mode='reflect')

        # Use the optimized pipeline function (prefetch + batch + fp16 + async save)
        print(json.dumps({"status": f"Processing {total} frames on {dev_label}...", "total": total}), flush=True)
        _inpaint_frames_on_device(model, device, frames, crop_box, mask_np_full, output_dir, pre_cropped=pre_cropped, watermark_rgb=watermark_rgb,
                                  no_demix=no_demix, no_temporal=no_temporal, no_noise=no_noise)

    print(json.dumps({"status": "done", "progress": 100}), flush=True)


def run_sttn(input_dir, mask_path, output_dir):
    """Video inpainting using STTN (Spatial-Temporal Transformer Network)."""
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
    """Video inpainting using ProPainter (ICCV 2023)."""
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

            pct = 10
            status = line[:100]

            pct_match = re.search(r'(\d+)%', line)
            frame_match = re.search(r'(\d+)/(\d+)', line)

            if pct_match:
                pct = min(int(pct_match.group(1)), 90)
                pct = max(pct, 10)
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
    result_dirs = list(pp_out.glob('*/frames'))
    if not result_dirs:
        result_dirs = list(pp_out.glob('*'))

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

    no_demix = False
    no_temporal = False
    no_noise = False

    device_mode = 'auto'
    gpu_ratio = 70
    orig_width = None
    orig_height = None
    crop_x = None
    crop_y = None
    crop_w_val = None
    crop_h_val = None

    args = sys.argv[5:]
    i = 0
    while i < len(args):
        if args[i] == '--device' and i + 1 < len(args):
            device_mode = args[i + 1]
            i += 2
        elif args[i] == '--gpu-ratio' and i + 1 < len(args):
            gpu_ratio = int(args[i + 1])
            i += 2
        elif args[i] == '--orig-width' and i + 1 < len(args):
            orig_width = int(args[i + 1])
            i += 2
        elif args[i] == '--orig-height' and i + 1 < len(args):
            orig_height = int(args[i + 1])
            i += 2
        elif args[i] == '--crop-x' and i + 1 < len(args):
            crop_x = int(args[i + 1])
            i += 2
        elif args[i] == '--crop-y' and i + 1 < len(args):
            crop_y = int(args[i + 1])
            i += 2
        elif args[i] == '--crop-w' and i + 1 < len(args):
            crop_w_val = int(args[i + 1])
            i += 2
        elif args[i] == '--crop-h' and i + 1 < len(args):
            crop_h_val = int(args[i + 1])
            i += 2
        elif args[i] == '--no-demix':
            no_demix = True
            i += 1
        elif args[i] == '--no-temporal':
            no_temporal = True
            i += 1
        elif args[i] == '--no-noise':
            no_noise = True
            i += 1
        else:
            os.environ['STTN_DIR'] = args[i]
            os.environ['PROPAINTER_DIR'] = args[i]
            i += 1

    output_dir.mkdir(parents=True, exist_ok=True)

    if method == 'opencv':
        run_opencv(input_dir, mask_path, output_dir)
    elif method == 'lama':
        run_lama(input_dir, mask_path, output_dir, device_mode, gpu_ratio,
                 orig_width, orig_height, crop_x, crop_y, crop_w_val, crop_h_val,
                 no_demix, no_temporal, no_noise)
    elif method == 'sttn':
        run_sttn(input_dir, mask_path, output_dir)
    elif method == 'propainter':
        run_propainter(input_dir, mask_path, output_dir)
    else:
        print(json.dumps({"error": f"Unknown method: {method}. Use 'lama', 'opencv', 'sttn', or 'propainter'"}))
        sys.exit(1)


if __name__ == '__main__':
    main()
