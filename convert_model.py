import os
import sys
import shutil
import tempfile
import urllib.request
import zipfile
import subprocess

# Define paths
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PTH_PATH = os.path.join(ROOT_DIR, "realesr-general-x4v3.pth")
DEST_DIR = os.path.join(ROOT_DIR, "addons", "video-upscale", "models")

print("=== RedOne Creative Model Converter ===")
if not os.path.exists(PTH_PATH):
    print(f"Loi: Khong tim thay file: {PTH_PATH}")
    print("Vui long copy file 'realesr-general-x4v3.pth' vao thu muc goc cua tool roi chay lai script nay.")
    sys.exit(1)

print(f"Tim thay: {PTH_PATH}")

# Step 1: Install ONNX
print("\n[1/5] Dang kiem tra va cai dat thu vien 'onnx'...")
try:
    import onnx
    print("Thu vien 'onnx' da duoc cai dat.")
except ImportError:
    print("Dang cai dat thu vien 'onnx' qua pip...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "onnx"])
    import onnx
    print("Da cai dat 'onnx' thanh cong.")

# Step 2: Export PyTorch to ONNX
print("\n[2/5] Dang chuyen doi model PyTorch (.pth) sang ONNX (.onnx)...")
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    # Define official SRVGGNetCompact architecture for realesr-general-x4v3
    class SRVGGNetCompact(nn.Module):
        def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu'):
            super(SRVGGNetCompact, self).__init__()
            self.num_in_ch = num_in_ch
            self.num_out_ch = num_out_ch
            self.num_feat = num_feat
            self.num_conv = num_conv
            self.upscale = upscale
            self.act_type = act_type

            self.body = nn.Sequential()
            self.body.add_module('0', nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
            for i in range(num_conv):
                if act_type == 'relu':
                    self.body.add_module(f'{2*i+1}', nn.ReLU(inplace=True))
                elif act_type == 'prelu':
                    self.body.add_module(f'{2*i+1}', nn.PReLU(num_parameters=num_feat))
                elif act_type == 'leakyrelu':
                    self.body.add_module(f'{2*i+1}', nn.LeakyReLU(negative_slope=0.1, inplace=True))
                self.body.add_module(f'{2*i+2}', nn.Conv2d(num_feat, num_feat, 3, 1, 1))

            if act_type == 'relu':
                self.body.add_module(f'{2*num_conv+1}', nn.ReLU(inplace=True))
            elif act_type == 'prelu':
                self.body.add_module(f'{2*num_conv+1}', nn.PReLU(num_parameters=num_feat))
            elif act_type == 'leakyrelu':
                self.body.add_module(f'{2*num_conv+1}', nn.LeakyReLU(negative_slope=0.1, inplace=True))
                
            self.body.add_module(f'{2*num_conv+2}', nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))

        def forward(self, x):
            out = self.body(x)
            out = F.pixel_shuffle(out, self.upscale)
            # Skip connection (bilinear interpolation of input)
            x_up = F.interpolate(x, scale_factor=self.upscale, mode='bilinear', align_corners=False)
            out = out + x_up
            return out

    # Initialize model
    model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
    
    # Load weights
    print("Dang nap file trong so...")
    state_dict = torch.load(PTH_PATH, map_location="cpu")
    if 'params' in state_dict:
        state_dict = state_dict['params']
    model.load_state_dict(state_dict, strict=True)
    model.eval()

    # Export
    onnx_path = os.path.join(ROOT_DIR, "realesr-general-x4v3.onnx")
    dummy_input = torch.randn(1, 3, 64, 64)
    torch.onnx.export(
        model, 
        dummy_input, 
        onnx_path, 
        opset_version=11,
        input_names=['data'],
        output_names=['output'],
        dynamic_axes={
            'data': {0: 'batch', 2: 'height', 3: 'width'},
            'output': {0: 'batch', 2: 'height', 3: 'width'}
        },
        dynamo=False
    )
    print(f"Da xuat file ONNX: {onnx_path}")
except Exception as e:
    print(f"Loi khi export sang ONNX: {e}")
    sys.exit(1)

# Step 3: Download NCNN prebuilt tools to get onnx2ncnn
print("\n[3/5] Dang tai cong cu convert onnx2ncnn cua Tencent NCNN...")
tmp_dir = tempfile.mkdtemp(prefix="ncnn_tools_")
zip_path = os.path.join(tmp_dir, "ncnn.zip")
ncnn_url = "https://github.com/Tencent/ncnn/releases/download/20240410/ncnn-20240410-windows-vs2019-shared.zip"

try:
    print("Dang tai file zip tu GitHub (khoang 9MB)...")
    urllib.request.urlretrieve(ncnn_url, zip_path)
    print("Tai thanh cong. Dang giai nen cong cu...")
    
    onnx2ncnn_exe = None
    ncnnoptimize_exe = None
    
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        for name in zip_ref.namelist():
            if name.endswith("onnx2ncnn.exe"):
                onnx2ncnn_exe = os.path.join(tmp_dir, "onnx2ncnn.exe")
                with open(onnx2ncnn_exe, "wb") as f:
                    f.write(zip_ref.read(name))
            elif name.endswith("ncnnoptimize.exe"):
                ncnnoptimize_exe = os.path.join(tmp_dir, "ncnnoptimize.exe")
                with open(ncnnoptimize_exe, "wb") as f:
                    f.write(zip_ref.read(name))
            # Also extract dependent dlls if any in same folder
            elif name.endswith(".dll") and ("x64/bin" in name or "bin" in name):
                dll_dest = os.path.join(tmp_dir, os.path.basename(name))
                with open(dll_dest, "wb") as f:
                    f.write(zip_ref.read(name))

    if not onnx2ncnn_exe or not ncnnoptimize_exe:
        raise FileNotFoundError("Khong tim thay onnx2ncnn.exe hoac ncnnoptimize.exe trong file zip tai ve.")
    print("Giai nen cac cong cu thanh cong.")
except Exception as e:
    print(f"Loi khi tai cong cu convert: {e}")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    sys.exit(1)

# Step 4: Convert and Optimize
print("\n[4/5] Dang chuyen doi ONNX sang NCNN va toi uu hoa (FP16)...")
try:
    raw_param = os.path.join(tmp_dir, "raw.param")
    raw_bin = os.path.join(tmp_dir, "raw.bin")
    
    # 1. onnx2ncnn
    print("Chay onnx2ncnn...")
    subprocess.check_call([onnx2ncnn_exe, onnx_path, raw_param, raw_bin])
    
    # 2. ncnnoptimize to FP16
    print("Chay ncnnoptimize...")
    opt_param = os.path.join(tmp_dir, "realesr-general-x4v3.param")
    opt_bin = os.path.join(tmp_dir, "realesr-general-x4v3.bin")
    subprocess.check_call([ncnnoptimize_exe, raw_param, raw_bin, opt_param, opt_bin, "65536"])
    
    print("Chuyen doi va toi uu hoa thanh cong.")
except Exception as e:
    print(f"Loi trong qua trinh convert/optimize: {e}")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    sys.exit(1)

# Step 5: Move to destination and Cleanup
print("\n[5/5] Dang luu tru va don dep cac tep tam thoi...")
try:
    os.makedirs(DEST_DIR, exist_ok=True)
    dest_param = os.path.join(DEST_DIR, "realesr-general-x4v3.param")
    dest_bin = os.path.join(DEST_DIR, "realesr-general-x4v3.bin")
    
    shutil.move(opt_param, dest_param)
    shutil.move(opt_bin, dest_bin)
    
    # Cleanup ONNX and temp dirs
    if os.path.exists(onnx_path):
        os.remove(onnx_path)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    
    print("\n=======================================================")
    print("CHUC MUNG! DA TICH HOP MODEL THANH CONG!")
    print("Tep cau hinh va trong so NCNN moi duoc luu tai:")
    print(f"-> {dest_param}")
    print(f"-> {dest_bin}")
    print("=======================================================")
except Exception as e:
    print(f"Loi khi copy file dich: {e}")
    sys.exit(1)
