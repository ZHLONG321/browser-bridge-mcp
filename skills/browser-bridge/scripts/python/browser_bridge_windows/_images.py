"""Encode native captures without resizing or size caps; return verified filenames."""
from __future__ import annotations

import os
import re
import sys
import tempfile
import uuid
from io import BytesIO
from pathlib import Path
from typing import Literal

from ._native import Frame
from ._platform import integer, require_windows


def screenshot_directory(session_id: str) -> Path:
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        raise ValueError("session_id must identify the active caller using letters, digits, underscores or hyphens.")
    return Path(os.environ.get("TMP") or tempfile.gettempdir()) / f"codex-{session_id}-browser-bridge" / "screen"


def save(frame: Frame, *, session_id: str, format: Literal["webp", "jpeg"] = "webp", quality: int | None = None) -> str:
    require_windows()
    directory = screenshot_directory(session_id)
    if format not in ("webp", "jpeg"):
        raise ValueError("format must be webp or jpeg.")
    quality = integer(quality if quality is not None else (100 if format == "webp" else 90), "quality", 1, 100)
    from PIL import Image

    # Pillow's native raw decoder drops GDI's undefined alpha without a Python pixel loop.
    with Image.frombytes("RGB", (frame.width, frame.height), frame.data, "raw", "BGRX") as image:
        encoded = BytesIO()
        image.save(encoded, format="WEBP" if format == "webp" else "JPEG", quality=quality)
    data = encoded.getvalue()
    filename = f"windows-{uuid.uuid4()}.{'jpg' if format == 'jpeg' else 'webp'}"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    saved = path.stat()
    if not path.is_file() or saved.st_size == 0 or saved.st_size != len(data):
        raise OSError("Screenshot file is missing or incomplete.")
    print(f"Windows screenshot: {frame.width}x{frame.height}, {saved.st_size} bytes ({format}).", file=sys.stderr)
    return filename
