# PyInstaller spec for RedOne Creative
# Run via:  pyinstaller RedOne.spec --noconfirm --clean
#
# Output: dist/RedOne Creative/<files>  (--onedir mode)
# After build, zip the entire folder and attach to GitHub release.

# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None
project_root = Path('.').resolve()

# Bundle ALL of frontend (HTML + CSS + JS) as data — server reads at runtime.
# Also bundle backend/resources/ which holds the lama_inpaint.py runner script
# and veo3watermark.png mask (Veo logo bottom-right) used by the video-watermark
# removal feature.
datas = [
    (str(project_root / 'frontend'), 'frontend'),
    (str(project_root / 'backend' / 'resources'), 'backend/resources'),
    (str(project_root / 'backend' / 'services' / 'lama_inpaint.py'), 'backend/services'),
]
binaries = []   # native DLLs/.so added by collect_all() — see loop below

# Heavy 3rd-party packages need full collection (binaries + data + submodules)
# Note: 'cloakbrowser' is optional — if user uses Cloak backend, the package
# is bundled but its Chromium binary (~200MB) auto-downloads on first run.
#
# 'cv2' (opencv-python) is bundled so the Xóa Watermark Video feature works
# out-of-box on a fresh machine without needing `pip install opencv-python`.
# Adds ~50MB to the EXE. LaMa quality (torch + simple-lama-inpainting) is
# still external — install via the in-app upgrade wizard.
#
# 'google' family — google-genai SDK + auth dependencies. Required for
# Vertex AI Commercial mode (image gen Nano Banana + video gen Veo).
# Without these the EXE silently fails on first gen — google.genai import
# fails inside vertex_client._build_client.
for pkg in ('playwright', 'curl_cffi', 'httpx', 'uvicorn', 'fastapi', 'starlette',
            'websockets', 'pydantic_core', 'cloakbrowser', 'cv2', 'imageio_ffmpeg',
            # Vertex AI commercial mode
            'google.genai', 'google.auth', 'google.oauth2', 'google.api_core',
            'google.cloud.storage', 'googleapiclient',
            # Tenacity is used by google-genai for retry logic; usually
            # picked up via collect_all('google.genai') but explicit is safer.
            'tenacity'):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b   # cv2 ships native DLLs (opencv_world*.dll, ffmpeg, ...)
    except Exception:
        pass

# Hidden imports — modules uvicorn / fastapi load lazily by string
hiddenimports = [
    'uvicorn.loops.auto', 'uvicorn.loops.asyncio',
    'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.httptools_impl', 'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.websockets_impl', 'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.lifespan.on', 'uvicorn.lifespan.off',
    'uvicorn.logging',
    'h11', 'httptools', 'websockets',
    'email.mime.multipart', 'email.mime.text',  # FastAPI / starlette pull these
]
hiddenimports += collect_submodules('backend')
hiddenimports += collect_submodules('playwright')
# google-genai SDK + auth — needed for Vertex AI Commercial mode
for _pkg in ('google.genai', 'google.auth', 'google.oauth2', 'google.api_core'):
    try:
        hiddenimports += collect_submodules(_pkg)
    except Exception:
        pass
# cv2 has a complex C-extension layout; collect_submodules helps PyInstaller
# pick up the data files (haarcascade XMLs etc.) it can't auto-discover.
try:
    hiddenimports += collect_submodules('cv2')
except Exception:
    pass
try:
    hiddenimports += collect_submodules('cloakbrowser')
except Exception:
    pass


a = Analysis(
    ['launch.py'],
    pathex=[str(project_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Drop optional heavy deps we don't bundle
        'rembg', 'whisper', 'torch', 'torchvision', 'spandrel',
        'numpy.f2py', 'scipy', 'sklearn', 'pandas', 'matplotlib',
        'tkinter', 'PySide6', 'PyQt5', 'PyQt6',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='RedOne Creative',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                # GUI mode, no terminal window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='redone.ico',            # red capital "R" — matches the extension icon
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='RedOne Creative',
)
