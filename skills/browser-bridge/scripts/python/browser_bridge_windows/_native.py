"""Win32 inspection and raw BGRA capture; no shell, Node, focus or restoration."""
from __future__ import annotations

import ctypes as c
import re
from contextlib import contextmanager
from ctypes import wintypes as w
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from os import environ
from typing import Callable, Iterator, Literal, NoReturn, TypeAlias

from ._platform import WindowsError, hwnd_value, require_windows

Json: TypeAlias = "None | bool | int | float | str | list[Json] | dict[str, Json]"
Record: TypeAlias = dict[str, Json]
Match: TypeAlias = Literal["contains", "exact", "regex"]


class ProcessEntry(c.Structure):
    _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD), ("heap", c.c_size_t),
                ("module", w.DWORD), ("threads", w.DWORD), ("parent", w.DWORD),
                ("priority", w.LONG), ("flags", w.DWORD), ("name", w.WCHAR * 260)]


class BitmapHeader(c.Structure):
    _fields_ = [("size", w.DWORD), ("width", w.LONG), ("height", w.LONG), ("planes", w.WORD),
                ("bit_count", w.WORD), ("compression", w.DWORD), ("image_size", w.DWORD),
                ("x_resolution", w.LONG), ("y_resolution", w.LONG), ("colors", w.DWORD), ("important", w.DWORD)]


@dataclass(frozen=True)
class Frame:
    data: bytes
    width: int
    height: int


@lru_cache(maxsize=1)
def user32() -> c.WinDLL:
    require_windows()
    lib = c.WinDLL(str(Path(environ.get("SystemRoot", "C:/Windows")) / "System32/user32.dll"), use_last_error=True)
    enum_callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    definitions = [
        ("EnumWindows", w.BOOL, [enum_callback, w.LPARAM]),
        ("GetWindowTextLengthW", c.c_int, [w.HWND]),
        ("GetWindowTextW", c.c_int, [w.HWND, w.LPWSTR, c.c_int]),
        ("GetClassNameW", c.c_int, [w.HWND, w.LPWSTR, c.c_int]),
        ("GetForegroundWindow", w.HWND, []),
        ("GetWindowThreadProcessId", w.DWORD, [w.HWND, c.POINTER(w.DWORD)]),
        ("GetWindowRect", w.BOOL, [w.HWND, c.POINTER(w.RECT)]),
        ("GetClientRect", w.BOOL, [w.HWND, c.POINTER(w.RECT)]),
        ("SetThreadDpiAwarenessContext", c.c_void_p, [c.c_void_p]),
        ("GetDC", w.HDC, [w.HWND]), ("ReleaseDC", c.c_int, [w.HWND, w.HDC]),
        ("PrintWindow", w.BOOL, [w.HWND, w.HDC, w.UINT]), ("GetSystemMetrics", c.c_int, [c.c_int]),
    ]
    for name in ("IsWindow", "IsWindowVisible", "IsIconic", "IsZoomed"):
        definitions.append((name, w.BOOL, [w.HWND]))
    for name, result, args in definitions:
        function = getattr(lib, name)
        function.restype = result
        function.argtypes = args
    return lib


@lru_cache(maxsize=1)
def kernel32() -> c.WinDLL:
    require_windows()
    lib = c.WinDLL(str(Path(environ.get("SystemRoot", "C:/Windows")) / "System32/kernel32.dll"), use_last_error=True)
    definitions = [
        ("OpenProcess", w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
        ("QueryFullProcessImageNameW", w.BOOL, [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]),
        ("CloseHandle", w.BOOL, [w.HANDLE]),
        ("CreateToolhelp32Snapshot", w.HANDLE, [w.DWORD, w.DWORD]),
        ("Process32FirstW", w.BOOL, [w.HANDLE, c.POINTER(ProcessEntry)]),
        ("Process32NextW", w.BOOL, [w.HANDLE, c.POINTER(ProcessEntry)]),
    ]
    for name, result, args in definitions:
        function = getattr(lib, name)
        function.restype = result
        function.argtypes = args
    return lib


@lru_cache(maxsize=1)
def gdi32() -> c.WinDLL:
    require_windows()
    lib = c.WinDLL(str(Path(environ.get("SystemRoot", "C:/Windows")) / "System32/gdi32.dll"), use_last_error=True)
    definitions = [
        ("CreateCompatibleDC", w.HDC, [w.HDC]),
        ("CreateDIBSection", w.HBITMAP, [w.HDC, c.c_void_p, w.UINT, c.POINTER(c.c_void_p), w.HANDLE, w.DWORD]),
        ("SelectObject", w.HGDIOBJ, [w.HDC, w.HGDIOBJ]),
        ("DeleteObject", w.BOOL, [w.HGDIOBJ]), ("DeleteDC", w.BOOL, [w.HDC]), ("GdiFlush", w.BOOL, []),
        ("BitBlt", w.BOOL, [w.HDC, c.c_int, c.c_int, c.c_int, c.c_int, w.HDC, c.c_int, c.c_int, w.DWORD]),
    ]
    for name, result, args in definitions:
        function = getattr(lib, name)
        function.restype = result
        function.argtypes = args
    return lib


def fail(api: str) -> NoReturn:
    raise WindowsError(f"{api} failed (Win32 error {c.get_last_error()}).", code="WINDOWS_API_FAILED")


def window(hwnd: int | str) -> int:
    value = hwnd_value(hwnd)
    if not user32().IsWindow(value):
        raise WindowsError("The requested HWND no longer identifies a window. Discover it again.")
    return value


@contextmanager
def dpi() -> Iterator[None]:
    lib = user32()
    previous = lib.SetThreadDpiAwarenessContext(c.c_void_p(-4))
    if not previous:
        fail("SetThreadDpiAwarenessContext")
    try:
        yield
    finally:
        lib.SetThreadDpiAwarenessContext(previous)


def rect(hwnd: int, client: bool = False) -> Record:
    area = w.RECT()
    fn = user32().GetClientRect if client else user32().GetWindowRect
    if not fn(hwnd, c.byref(area)):
        fail("GetClientRect" if client else "GetWindowRect")
    return {"left": area.left, "top": area.top, "right": area.right, "bottom": area.bottom,
            "x": area.left, "y": area.top, "width": area.right - area.left, "height": area.bottom - area.top,
            "unit": "physical_pixel", "reference": "client" if client else "desktop"}


def process_path(pid: int) -> Record:
    lib = kernel32()
    process = lib.OpenProcess(0x1000, False, pid)
    if not process:
        return {"path": None, "path_error": c.get_last_error()}
    try:
        size = w.DWORD(32768)
        text = c.create_unicode_buffer(size.value)
        if not lib.QueryFullProcessImageNameW(process, 0, text, c.byref(size)):
            return {"path": None, "path_error": c.get_last_error()}
        return {"path": text.value}
    finally:
        lib.CloseHandle(process)


def owner(hwnd: int) -> Record:
    pid = w.DWORD()
    thread = user32().GetWindowThreadProcessId(hwnd, c.byref(pid))
    if not thread:
        fail("GetWindowThreadProcessId")
    return {"hwnd": str(hwnd), "process_id": pid.value, "thread_id": int(thread), **process_path(pid.value)}


def info(hwnd: int) -> Record:
    lib = user32()
    title = c.create_unicode_buffer(lib.GetWindowTextLengthW(hwnd) + 1)
    lib.GetWindowTextW(hwnd, title, len(title))
    class_name = c.create_unicode_buffer(256)
    lib.GetClassNameW(hwnd, class_name, len(class_name))
    return {**owner(hwnd), "title": title.value, "class_name": class_name.value,
            "visible": bool(lib.IsWindowVisible(hwnd)), "minimized": bool(lib.IsIconic(hwnd)),
            "maximized": bool(lib.IsZoomed(hwnd)), "rect": rect(hwnd)}


def title_matcher(title: str, match: Match) -> Callable[[str], bool]:
    if not isinstance(title, str):
        raise TypeError("title must be a string.")
    if match == "regex":
        pattern = re.compile(title, re.IGNORECASE)
        return lambda value: pattern.search(value) is not None
    if match == "exact":
        return lambda value: value.casefold() == title.casefold()
    if match == "contains":
        return lambda value: title.casefold() in value.casefold()
    raise ValueError("match must be contains, exact or regex.")


def windows(include_invisible: bool, limit: int, matches: Callable[[str], bool]) -> list[Record]:
    lib = user32()
    result: list[Record] = []
    failures: list[Exception] = []

    @c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def callback(hwnd: int, _lparam: int) -> bool:
        try:
            if not lib.IsWindow(hwnd) or (not include_invisible and not lib.IsWindowVisible(hwnd)):
                return True
            item = info(hwnd)
            if matches(str(item["title"])):
                result.append(item)
            return len(result) < limit
        except Exception as error:
            failures.append(error)
            return False

    with dpi():
        c.set_last_error(0)
        ok = lib.EnumWindows(callback, 0)
        if failures:
            raise failures[0]
        if not ok and len(result) < limit:
            fail("EnumWindows")
    return result


def processes(limit: int, selected: int | None = None) -> list[Record]:
    lib = kernel32()
    snapshot = lib.CreateToolhelp32Snapshot(2, 0)
    if snapshot == c.c_void_p(-1).value:
        fail("CreateToolhelp32Snapshot")
    entry = ProcessEntry()
    entry.size = c.sizeof(entry)
    result: list[Record] = []
    try:
        ok = lib.Process32FirstW(snapshot, c.byref(entry))
        while ok:
            if selected is None or entry.pid == selected:
                result.append({"process_id": entry.pid, "parent_process_id": entry.parent,
                               "threads": entry.threads, "name": entry.name, **process_path(entry.pid)})
                if selected is not None or len(result) >= limit:
                    break
            ok = lib.Process32NextW(snapshot, c.byref(entry))
        if not ok and c.get_last_error() != 18:
            fail("Process32FirstW/Process32NextW")
        return result
    finally:
        lib.CloseHandle(snapshot)


def capture(*, hwnd: int | None = None, x: int = 0, y: int = 0, width: int = 0, height: int = 0) -> Frame:
    lib, gdi = user32(), gdi32()
    with dpi():
        if hwnd is not None:
            window(hwnd)
            if lib.IsIconic(hwnd):
                raise WindowsError("Cannot capture a minimized window without restoring it. Restoration needs foreground authorization.")
            area = w.RECT()
            if not lib.GetWindowRect(hwnd, c.byref(area)):
                fail("GetWindowRect")
            width, height = area.right - area.left, area.bottom - area.top
        else:
            left, top = lib.GetSystemMetrics(76), lib.GetSystemMetrics(77)
            if x < left or y < top or x + width > left + lib.GetSystemMetrics(78) or y + height > top + lib.GetSystemMetrics(79):
                raise ValueError("Region must fit within the physical virtual desktop.")
        if width <= 0 or height <= 0:
            raise ValueError("Capture dimensions must be positive.")
        source = lib.GetDC(0)
        if not source:
            fail("GetDC")
        dc = bitmap = previous = None
        try:
            dc = gdi.CreateCompatibleDC(source)
            if not dc:
                fail("CreateCompatibleDC")
            # One RGBQUAD follows the header; 32-bit BI_RGB uses top-down BGRA.
            header = BitmapHeader(c.sizeof(BitmapHeader), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
            info_buffer = c.create_string_buffer(bytes(header) + bytes(4))
            bits = c.c_void_p()
            bitmap = gdi.CreateDIBSection(source, info_buffer, 0, c.byref(bits), None, 0)
            if not bitmap or not bits.value:
                fail("CreateDIBSection")
            previous = gdi.SelectObject(dc, bitmap)
            if not previous or previous == c.c_void_p(-1).value:
                fail("SelectObject")
            ok = lib.PrintWindow(hwnd, dc, 2) if hwnd is not None else gdi.BitBlt(dc, 0, 0, width, height, source, x, y, 0x40CC0020)
            if not ok:
                fail("PrintWindow" if hwnd is not None else "BitBlt")
            if not gdi.GdiFlush():
                fail("GdiFlush")
            return Frame(c.string_at(bits, width * height * 4), width, height)
        finally:
            if previous:
                gdi.SelectObject(dc, previous)
            if bitmap:
                gdi.DeleteObject(bitmap)
            if dc:
                gdi.DeleteDC(dc)
            lib.ReleaseDC(0, source)
