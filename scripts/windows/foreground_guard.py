import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import threading
import time

u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u.IsWindow.argtypes = [wintypes.HWND]
u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.GetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
u.GetPropW.restype = wintypes.HANDLE
u.SetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.HANDLE]
u.RemovePropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
u.RemovePropW.restype = wintypes.HANDLE
u.SetWindowsHookExW.argtypes = [ctypes.c_int, ctypes.c_void_p, wintypes.HINSTANCE, wintypes.DWORD]
u.SetWindowsHookExW.restype = wintypes.HANDLE
u.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
u.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
k.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
k.CreateEventW.restype = wintypes.HANDLE
k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k.ResetEvent.argtypes = [wintypes.HANDLE]
k.CloseHandle.argtypes = [wintypes.HANDLE]
enum_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
u.EnumWindows.argtypes = [enum_callback, wintypes.LPARAM]
chromium = sys.argv[1] == '--chromium'
if chromium:
    u.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
    u.FindWindowExW.restype = wintypes.HWND
    deadline = time.monotonic() + 5
    target_window = None
    while not target_window and time.monotonic() < deadline:
        target_window = u.FindWindowExW(wintypes.HWND(-3), None, 'Chrome_MessageWindow', str(Path(sys.argv[2]).resolve()))
        if not target_window:
            time.sleep(0.05)
    if not target_window:
        raise RuntimeError('No Chromium process singleton for the explicit user-data directory')
    expected_title = None
else:
    target_window = int(sys.argv[1])
    expected_title = sys.argv[2]
pid_value = wintypes.DWORD()
target_thread = u.GetWindowThreadProcessId(target_window, ctypes.byref(pid_value))
target_pid = pid_value.value
window_class = ctypes.create_unicode_buffer(64)
u.GetClassNameW(target_window, window_class, len(window_class))
expected_class = 'Chrome_MessageWindow' if chromium else 'MozillaWindowClass'
if not target_thread or window_class.value != expected_class:
    raise RuntimeError("Use the live native HWND of the selected Firefox window")
if chromium:
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    process_handle = k.OpenProcess(0x1000, False, target_pid)
    if not process_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        image = ctypes.create_unicode_buffer(32768)
        image_size = wintypes.DWORD(len(image))
        if not k.QueryFullProcessImageNameW(process_handle, 0, image, ctypes.byref(image_size)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not Path(image.value).samefile(sys.argv[3]):
            raise RuntimeError('The process singleton belongs to a different executable')
    finally:
        k.CloseHandle(process_handle)
u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
title = ctypes.create_unicode_buffer(8192)
u.GetWindowTextW(target_window, title, len(title))
if not chromium and (not expected_title or title.value != expected_title):
    raise RuntimeError("The native Firefox window title does not match the selected bridge window")
matching_threads = set()
existing = []

@enum_callback
def visit(hwnd, _):
    pid = wintypes.DWORD()
    thread = u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    class_name = ctypes.create_unicode_buffer(64)
    u.GetClassNameW(hwnd, class_name, len(class_name))
    if class_name.value == ('Chrome_WidgetWin_1' if chromium else 'MozillaWindowClass'):
        current_title = ctypes.create_unicode_buffer(8192)
        u.GetWindowTextW(hwnd, current_title, len(current_title))
        if current_title.value == expected_title:
            matching_threads.add((thread, pid.value))
        if thread == target_thread and pid.value == target_pid:
            existing.append(hwnd)
    return True

u.EnumWindows(visit, 0)
if not chromium and not existing:
    raise RuntimeError("A live Firefox window must establish the target thread/process")
if not chromium and matching_threads != {(target_thread, target_pid)}:
    raise RuntimeError("The window title matches several Firefox processes; establish the profile association first")
property_name = "BrowserBridgeFocusGuardExistingWindow"
marked = []
hooks = []
ready = None
try:
    for hwnd in existing:
        if u.GetPropW(hwnd, property_name):
            raise RuntimeError("Another foreground guard owns this window")
        if not u.SetPropW(hwnd, property_name, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        marked.append(hwnd)
    library = ctypes.WinDLL(str(Path(__file__).with_name("foreground-guard.dll")))
    ctypes.set_last_error(0)
    ready = k.CreateEventW(None, True, False, f"Local\\BrowserBridgeFocusGuardReady_{target_thread}")
    if not ready:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        raise RuntimeError('Another foreground guard owns the selected browser thread')
    for kind, name in ((5, "CbtGuardProc"), (3, "ReadyProc")):
        hook = u.SetWindowsHookExW(kind, ctypes.cast(getattr(library, name), ctypes.c_void_p), library._handle, target_thread)
        if not hook:
            raise ctypes.WinError(ctypes.get_last_error())
        hooks.append(hook)
    if not u.PostThreadMessageW(target_thread, 0, 0xB04B, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    if k.WaitForSingleObject(ready, 3000) != 0:
        raise RuntimeError("Firefox did not acknowledge loading the native guard; do not create a window")
    stop = threading.Event()
    def read_stop():
        sys.stdin.readline()
        stop.set()
    threading.Thread(target=read_stop, daemon=True).start()
    print(json.dumps({"ready": True, "thread_id": target_thread, "pid": target_pid, "existing": existing}), flush=True)
    if not stop.wait(40):
        raise RuntimeError("Foreground guard lease expired")
    if not k.ResetEvent(ready) or not u.PostThreadMessageW(target_thread, 0, 0xB04B, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    if k.WaitForSingleObject(ready, 3000) != 0:
        raise RuntimeError('The browser did not acknowledge the final message-queue barrier')
finally:
    release_errors = []
    for hook in reversed(hooks):
        if not u.UnhookWindowsHookEx(hook):
            release_errors.append(f"UnhookWindowsHookEx: {ctypes.get_last_error()}")
    if ready:
        k.CloseHandle(ready)
    for hwnd in marked:
        if not u.RemovePropW(hwnd, property_name) and u.IsWindow(hwnd):
            release_errors.append(f"RemovePropW: {ctypes.get_last_error()}")
    if release_errors:
        raise RuntimeError("; ".join(release_errors))
print(json.dumps({"stopped": True}), flush=True)
