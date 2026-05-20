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

# Bundle ALL of frontend (HTML + CSS + JS) as data — server reads at runtime
datas = [
    (str(project_root / 'frontend'), 'frontend'),
]

# Heavy 3rd-party packages need full collection (binaries + data + submodules)
# Note: 'cloakbrowser' is optional — if user uses Cloak backend, the package
# is bundled but its Chromium binary (~200MB) auto-downloads on first run.
for pkg in ('playwright', 'curl_cffi', 'httpx', 'uvicorn', 'fastapi', 'starlette',
            'websockets', 'pydantic_core', 'cloakbrowser'):
    try:
        d, b, h = collect_all(pkg)
        datas += d
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
try:
    hiddenimports += collect_submodules('cloakbrowser')
except Exception:
    pass


a = Analysis(
    ['launch.py'],
    pathex=[str(project_root)],
    binaries=[],
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
    icon=None,                    # add 'icon.ico' here if you have one
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
