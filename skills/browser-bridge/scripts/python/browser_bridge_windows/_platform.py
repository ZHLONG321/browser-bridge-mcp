"""Platform and input contracts shared by the independent Python Windows client."""
from __future__ import annotations

import ctypes
import sys


class WindowsError(RuntimeError):
    def __init__(self, message: str, *, code: str = "WINDOWS_OPERATION_FAILED",
                 details: dict[str, str | bool] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def require_windows() -> None:
    if sys.platform != "win32":
        raise WindowsError("Windows commands are unavailable on this platform.",
                           code="WINDOWS_UNAVAILABLE", details={"platform": sys.platform})


def integer(value: int, name: str, minimum: int = -(2**31), maximum: int = 2**31 - 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}].")
    return value


def hwnd_value(value: int | str) -> int:
    if isinstance(value, str):
        try:
            value = int(value, 16 if value.lower().startswith("0x") else 10)
        except ValueError:
            raise ValueError("hwnd must be a decimal/hexadecimal integer string.") from None
    return integer(value, "hwnd", 1, 2 ** (ctypes.sizeof(ctypes.c_void_p) * 8) - 1)
