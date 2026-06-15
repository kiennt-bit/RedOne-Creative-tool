"""Helper: convert a Google service account JSON file into a Python dict
literal ready to paste into backend/private_config.py.

Usage:
    python tools/embed_service_account.py path/to/key.json
    python tools/embed_service_account.py path/to/key.json --write

The first form prints the dict literal to stdout (and copies to
clipboard if pyperclip is available). The --write flag updates
backend/private_config.py in-place, replacing the existing
VERTEX_SERVICE_ACCOUNT_INFO assignment.

Why this matters
================
For company distribution, the service account credentials must travel
INSIDE the EXE. Otherwise users would need to receive the .json file
separately and put it in some specific path, which is fragile.

By embedding the credentials as a Python dict in private_config.py,
PyInstaller bakes them into the binary at build time. End users just
run the EXE — credentials are already there, gated behind the OAuth
login (@redone.vn email check).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from pprint import pformat

REPO_ROOT = Path(__file__).resolve().parent.parent
PRIVATE_CONFIG = REPO_ROOT / "backend" / "private_config.py"


def to_python_dict_literal(data: dict) -> str:
    """Format the JSON dict as readable Python code with proper string
    escaping for the multi-line `private_key` field."""
    # pprint handles most types well, but for the long private_key string
    # we want it inline with explicit \n escapes (not triple-quoted) so
    # it stays a single str literal that Python evaluates cleanly.
    out_lines = ["{"]
    for k, v in data.items():
        if isinstance(v, str):
            # Use repr() so newlines come out as \n, quotes are escaped
            out_lines.append(f"    {k!r}: {v!r},")
        else:
            out_lines.append(f"    {k!r}: {v!r},")
    out_lines.append("}")
    return "\n".join(out_lines)


def write_into_private_config(dict_literal: str) -> None:
    """Replace the VERTEX_SERVICE_ACCOUNT_INFO assignment in
    private_config.py with the given dict literal."""
    if not PRIVATE_CONFIG.exists():
        print(
            f"ERROR: {PRIVATE_CONFIG} chưa tồn tại. "
            f"Copy backend/private_config.py.template trước.",
            file=sys.stderr,
        )
        sys.exit(1)

    current = PRIVATE_CONFIG.read_text(encoding="utf-8")
    # Match the entire assignment (possibly multi-line dict literal).
    # Greedy match up to the next top-level assignment (a line that
    # starts at column 0 with an identifier = value).
    pattern = re.compile(
        r"^VERTEX_SERVICE_ACCOUNT_INFO\s*=\s*(?:None|\{.*?^\})",
        re.MULTILINE | re.DOTALL,
    )
    # CRITICAL: use a lambda for replacement, NOT a plain string. re.sub
    # interprets escape sequences (\n, \t, \1 etc) in plain-string
    # replacements — and our dict_literal is FULL of \n inside repr'd
    # private_key strings. With a lambda, the returned string is treated
    # literally.
    replacement_str = f"VERTEX_SERVICE_ACCOUNT_INFO = {dict_literal}"
    new_content, count = pattern.subn(lambda _m: replacement_str, current)
    if count == 0:
        print(
            "ERROR: không tìm thấy `VERTEX_SERVICE_ACCOUNT_INFO = ...` "
            "trong private_config.py. Thêm dòng đó (giá trị nào cũng "
            "được, miễn là không phải comment) rồi chạy lại.",
            file=sys.stderr,
        )
        sys.exit(1)
    PRIVATE_CONFIG.write_text(new_content, encoding="utf-8")
    # Force-stdout ASCII to avoid cp1252 encode errors on Windows
    sys.stdout.buffer.write(
        f"[OK] Updated {PRIVATE_CONFIG.relative_to(REPO_ROOT)}\n".encode("utf-8")
    )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("json_file", help="Service account JSON file from Google Cloud Console")
    p.add_argument("--write", action="store_true",
                   help="Update backend/private_config.py in-place instead of printing")
    args = p.parse_args()

    json_path = Path(args.json_file).expanduser().resolve()
    if not json_path.exists():
        print(f"ERROR: file không tồn tại: {json_path}", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"ERROR: không parse được JSON: {e}", file=sys.stderr)
        sys.exit(1)

    # Sanity check — service account JSON has these required fields
    required = {"type", "project_id", "private_key", "client_email"}
    missing = required - set(data.keys())
    if missing:
        print(
            f"ERROR: JSON thiếu fields {missing}. File này có vẻ không phải "
            f"service account JSON. Download lai tu GCP Console > IAM > "
            f"Service Accounts > KEYS > Add key > JSON.",
            file=sys.stderr,
        )
        sys.exit(1)
    if data.get("type") != "service_account":
        print(
            f"ERROR: 'type' field = {data.get('type')!r}, phải là 'service_account'.",
            file=sys.stderr,
        )
        sys.exit(1)

    dict_literal = to_python_dict_literal(data)

    if args.write:
        write_into_private_config(dict_literal)
        # Also try clipboard copy as bonus
        try:
            import pyperclip   # type: ignore
            pyperclip.copy(dict_literal)
            print("[OK]Cũng đã copy vào clipboard (nếu bạn cần paste chỗ khác)")
        except ImportError:
            pass
        return

    # Print mode
    print("# Paste dòng dưới đây vào backend/private_config.py")
    print("# (thay thế dòng VERTEX_SERVICE_ACCOUNT_INFO = None hiện tại)")
    print()
    print(f"VERTEX_SERVICE_ACCOUNT_INFO = {dict_literal}")
    print()

    # Try clipboard
    try:
        import pyperclip   # type: ignore
        pyperclip.copy(f"VERTEX_SERVICE_ACCOUNT_INFO = {dict_literal}")
        sys.stderr.buffer.write(b"[OK] Copied to clipboard.\n")
    except ImportError:
        print(
            f"(Tip: pip install pyperclip để tool tự copy vào clipboard)",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
