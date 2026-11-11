"""Independent Python Windows operations: ctypes + Pillow, without Node/BO/Bridge.

Every call names its live HWND/PID; no default browser is stored. Inspection
returns dictionaries/lists, captures return only complete verified filenames,
and failures raise WindowsError (or a specific input/dependency error). Calls
execute synchronously in this process. Use the CLI's isolated worker for a
bounded single operation; compose process-local handles in one saved script.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Literal, TypeAlias

from . import _native
from ._native import Json, Match, Record
from ._platform import WindowsError, hwnd_value, integer, require_windows

if TYPE_CHECKING:
    from pydantic import SecretStr

Result: TypeAlias = Record | list[Record] | str | None
Format: TypeAlias = Literal["webp", "jpeg"]


def list_windows(*, include_invisible: bool = False, limit: int = 500) -> list[Record]:
    require_windows()
    if not isinstance(include_invisible, bool):
        raise TypeError("include_invisible must be boolean.")
    return _native.windows(include_invisible, integer(limit, "limit", 1, 2**53 - 1), lambda _: True)


def find_windows(title: str, *, match: Match = "contains", include_invisible: bool = False, limit: int = 100) -> list[Record]:
    require_windows()
    if not isinstance(include_invisible, bool):
        raise TypeError("include_invisible must be boolean.")
    return _native.windows(include_invisible, integer(limit, "limit", 1, 2**53 - 1), _native.title_matcher(title, match))


def get_window(hwnd: int | str) -> Record:
    require_windows()
    with _native.dpi():
        return _native.info(_native.window(hwnd))


def get_foreground_window() -> Record | None:
    require_windows()
    hwnd = _native.user32().GetForegroundWindow()
    return get_window(int(hwnd)) if hwnd else None


def get_window_rect(hwnd: int | str) -> Record:
    require_windows()
    with _native.dpi():
        return _native.rect(_native.window(hwnd))


def get_client_rect(hwnd: int | str) -> Record:
    require_windows()
    with _native.dpi():
        return _native.rect(_native.window(hwnd), client=True)


def get_window_process(hwnd: int | str) -> Record:
    require_windows()
    return _native.owner(_native.window(hwnd))


def list_processes(*, limit: int = 5000) -> list[Record]:
    require_windows()
    return _native.processes(integer(limit, "limit", 1, 2**53 - 1))


def get_process(process_id: int) -> Record:
    require_windows()
    found = _native.processes(1, integer(process_id, "process_id", 0, 0xFFFFFFFF))
    if not found:
        raise WindowsError("The requested process no longer exists. Discover it again.")
    return found[0]


def _capture(*, session_id: str, format: Format, quality: int | None, hwnd: int | None = None,
             x: int = 0, y: int = 0, width: int = 0, height: int = 0) -> str:
    from . import _images

    _images.screenshot_directory(session_id)
    if format not in ("webp", "jpeg"):
        raise ValueError("format must be webp or jpeg.")
    if quality is not None:
        integer(quality, "quality", 1, 100)
    frame = _native.capture(hwnd=hwnd, x=x, y=y, width=width, height=height)
    return _images.save(frame, session_id=session_id, format=format, quality=quality)


def capture_window(*, session_id: str, hwnd: int | str | None = None, title: str | None = None,
                   title_match: Match = "exact", format: Format = "webp", quality: int | None = None) -> str:
    require_windows()
    if (hwnd is None) == (title is None):
        raise ValueError("Supply exactly one of hwnd or title.")
    if title is not None:
        candidates = find_windows(title, match=title_match)
        if len(candidates) != 1:
            raise ValueError(f"Window title matched {len(candidates)} visible windows; resolve an exact HWND first.")
        hwnd = str(candidates[0]["hwnd"])
    if hwnd is None:
        raise ValueError("Resolve an exact HWND first.")
    return _capture(session_id=session_id, format=format, quality=quality, hwnd=hwnd_value(hwnd))


def capture_foreground(*, session_id: str, format: Format = "webp", quality: int | None = None) -> str:
    require_windows()
    hwnd = _native.user32().GetForegroundWindow()
    if not hwnd:
        raise WindowsError("There is no foreground window to capture.")
    return _capture(session_id=session_id, format=format, quality=quality, hwnd=int(hwnd))


def capture_region(*, session_id: str, x: int, y: int, width: int, height: int,
                   format: Format = "webp", quality: int | None = None) -> str:
    require_windows()
    return _capture(session_id=session_id, format=format, quality=quality,
                    x=integer(x, "x"), y=integer(y, "y"), width=integer(width, "width", 1), height=integer(height, "height", 1))


def search_api(query: str, *, max_results: int = 10, proxy_url: str | SecretStr | None = None) -> list[Record]:
    require_windows()
    from ._api import Catalog

    return Catalog(proxy_url).search(query, max_results)


def describe_api(api: str, *, proxy_url: str | SecretStr | None = None) -> Record:
    require_windows()
    from ._api import Catalog

    return Catalog(proxy_url).describe(api)


def raw_call(api: str, *, arguments: dict[str, Json], mode: Literal["read_only", "authorized_mutation"],
             allow_foreground: bool = False, proxy_url: str | SecretStr | None = None) -> Record:
    require_windows()
    from ._api import raw_call as invoke

    return invoke(api, arguments, mode, allow_foreground, proxy_url)


_OPERATIONS: dict[str, Callable[..., Result]] = {
    "list_windows": list_windows, "find_windows": find_windows, "get_foreground_window": get_foreground_window,
    "get_window": get_window, "get_window_rect": get_window_rect, "get_client_rect": get_client_rect,
    "get_window_process": get_window_process, "list_processes": list_processes, "get_process": get_process,
    "capture_window": capture_window, "capture_foreground": capture_foreground, "capture_region": capture_region,
    "search_api": search_api, "describe_api": describe_api, "raw_call": raw_call,
}
OPERATIONS = tuple(_OPERATIONS)


def call(operation: str, **arguments: Json) -> Result:
    """Execute one named operation immediately; unknown operations/fields fail."""
    require_windows()
    name = operation.replace("-", "_")
    if name not in _OPERATIONS:
        raise ValueError("Unknown Windows operation.")
    return _OPERATIONS[name](**arguments)


__all__ = [
    "list_windows", "find_windows", "get_foreground_window", "get_window", "get_window_rect",
    "get_client_rect", "get_window_process", "list_processes", "get_process", "capture_window",
    "capture_foreground", "capture_region", "search_api", "describe_api", "raw_call",
    "call", "OPERATIONS", "WindowsError",
]
