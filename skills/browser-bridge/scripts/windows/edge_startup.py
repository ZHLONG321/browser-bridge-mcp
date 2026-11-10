"""Lease a process-scoped Edge startup guard; never save a browser selection."""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import mmap
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time

k = ctypes.WinDLL('kernel32', use_last_error=True)
u = ctypes.WinDLL('user32', use_last_error=True)

class Startup(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
                ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD),
                ('width', w.DWORD), ('height', w.DWORD), ('chars_x', w.DWORD),
                ('chars_y', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                ('show', w.WORD), ('reserved_size', w.WORD), ('reserved_ptr', ctypes.c_void_p),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]

class Process(ctypes.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]

k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                            w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
                            ctypes.POINTER(Startup), ctypes.POINTER(Process)]
k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
k.ResumeThread.argtypes = [w.HANDLE]
k.ResumeThread.restype = w.DWORD
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k.GetTickCount64.restype = ctypes.c_ulonglong
k.CloseHandle.argtypes = [w.HANDLE]
k.CreateEventW.argtypes = [ctypes.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR]
k.CreateEventW.restype = w.HANDLE
k.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]
k.CreateMutexW.restype = w.HANDLE
k.ReleaseMutex.argtypes = [w.HANDLE]
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
u.SetWinEventHook.argtypes = [w.DWORD, w.DWORD, w.HMODULE, ctypes.c_void_p, w.DWORD, w.DWORD, w.DWORD]
u.SetWinEventHook.restype = w.HANDLE
u.UnhookWinEvent.argtypes = [w.HANDLE]
u.PostThreadMessageW.argtypes = [w.DWORD, w.UINT, w.WPARAM, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.FindWindowExW.argtypes = [w.HWND, w.HWND, w.LPCWSTR, w.LPCWSTR]
u.FindWindowExW.restype = w.HWND
u.PeekMessageW.argtypes = [ctypes.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT]
u.TranslateMessage.argtypes = [ctypes.POINTER(w.MSG)]
u.DispatchMessageW.argtypes = [ctypes.POINTER(w.MSG)]

executable, root, directory, context, *urls = sys.argv[1:]
executable = str(Path(executable).resolve())
root = str(Path(root).resolve())
if context not in ('normal', 'private') or len(urls) > 1:
    raise ValueError('Explicit normal/private context and at most one destination are required')
library_path = Path(__file__).with_name('edge-startup-guard.dll')
for image in (Path(executable), library_path):
    with image.open('rb') as stream:
        stream.seek(0x3C)
        offset = struct.unpack('<I', stream.read(4))[0]
        stream.seek(offset)
        if stream.read(4) != b'PE\0\0' or stream.read(2) != b'\x64\x86':
            raise RuntimeError('The bundled startup guard requires x64 Edge and an x64 guard DLL')
if ctypes.sizeof(ctypes.c_void_p) != 8:
    raise RuntimeError('Run the x64 Edge startup guard with 64-bit Python')

key = hashlib.sha256(root.casefold().encode('utf-8')).hexdigest()
mutex = k.CreateMutexW(None, False, f'Local\\BrowserBridgeEdgeStartup_{key}')
if not mutex:
    raise ctypes.WinError(ctypes.get_last_error())
acquired = False
hook = None
mapping = None
stopped = None
process = Process()
resumed = False
state_format = '<9I4xQ'
fields = ('pid', 'thread', 'ready', 'error', 'slots', 'restored', 'blocked', 'events', 'mask', 'deadline')
state_size = struct.calcsize(state_format)
stop = threading.Event()

def read_stop():
    sys.stdin.readline()
    stop.set()

def pump():
    message = w.MSG()
    while u.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
        u.TranslateMessage(ctypes.byref(message))
        u.DispatchMessageW(ctypes.byref(message))

def state_values():
    return dict(zip(fields, struct.unpack(state_format, mapping[:]))) if mapping is not None else None

def verify_process(pid):
    handle = k.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        name = ctypes.create_unicode_buffer(32768)
        size = w.DWORD(len(name))
        if not k.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not Path(name.value).samefile(executable):
            raise RuntimeError('The user-data directory singleton belongs to a different executable')
    finally:
        k.CloseHandle(handle)

try:
    if k.WaitForSingleObject(mutex, 25000) not in (0, 0x80):
        raise RuntimeError('Another window-creation call still owns this Edge user-data directory')
    acquired = True
    singleton = u.FindWindowExW(w.HWND(-3), None, 'Chrome_MessageWindow', root)
    if singleton:
        pid = w.DWORD()
        if not u.GetWindowThreadProcessId(singleton, ctypes.byref(pid)):
            raise ctypes.WinError(ctypes.get_last_error())
        verify_process(pid.value)
        print(json.dumps({'ready': True, 'running': True, 'pid': pid.value}), flush=True)
        threading.Thread(target=read_stop, daemon=True).start()
        if not stop.wait(60):
            raise RuntimeError('Edge window-creation lease expired')
    else:
        startup = Startup()
        startup.cb = ctypes.sizeof(startup)
        startup.flags = 1
        startup.show = 4  # SW_SHOWNOACTIVATE, never minimize.
        arguments = [executable, f'--user-data-dir={root}', f'--profile-directory={directory}',
                     '--new-window', *(['--inprivate'] if context == 'private' else []), *urls]
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(arguments))
        if not k.CreateProcessW(executable, command, None, None, False, 4, None, None,
                                ctypes.byref(startup), ctypes.byref(process)):
            raise ctypes.WinError(ctypes.get_last_error())
        mapping = mmap.mmap(-1, state_size, tagname=f'Local\\BrowserBridgeStartupGuard_{process.pid}')
        mapping[:] = struct.pack(state_format, process.pid, 0, 0, 0, 0, 0, 0, 0, 0, k.GetTickCount64() + 40000)
        stopped = k.CreateEventW(None, True, False, f'Local\\BrowserBridgeStartupStopped_{process.pid}')
        if not stopped:
            raise ctypes.WinError(ctypes.get_last_error())
        library = ctypes.WinDLL(str(library_path))
        hook = u.SetWinEventHook(0x8000, 0x8000, library._handle,
                                ctypes.cast(library.StartupEventProc, ctypes.c_void_p), process.pid, 0, 4)
        if not hook:
            raise ctypes.WinError(ctypes.get_last_error())
        if k.ResumeThread(process.thread) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        resumed = True
        deadline = time.monotonic() + 10
        while True:
            pump()
            current = state_values()
            if current['error']:
                raise RuntimeError(f'Startup guard initialization failed: {current}; inspect process {process.pid}')
            if current['ready']:
                break
            if k.WaitForSingleObject(process.process, 0) == 0 or time.monotonic() >= deadline:
                raise RuntimeError(f'No guarded startup acknowledgement; inspect process {process.pid} before retrying')
            time.sleep(0.005)
        print(json.dumps({'ready': True, 'running': False, 'pid': process.pid, 'guard': current}), flush=True)
        threading.Thread(target=read_stop, daemon=True).start()
        deadline = time.monotonic() + 30
        while not stop.is_set():
            pump()
            if time.monotonic() >= deadline:
                raise RuntimeError('Edge startup guard lease expired; inspect the created window before retrying')
            time.sleep(0.005)
finally:
    release_error = None
    if hook and not u.UnhookWinEvent(hook):
        release_error = f'UnhookWinEvent: {ctypes.get_last_error()}'
    if resumed and process.process and k.WaitForSingleObject(process.process, 0) != 0:
        current = state_values()
        if current and current['thread']:
            if not u.PostThreadMessageW(current['thread'], 0, 0xB04C, 0) or k.WaitForSingleObject(stopped, 3000) != 0:
                release_error = 'The Edge UI thread did not acknowledge startup guard restoration'
            else:
                current = state_values()
                if current['error'] or current['slots'] != current['restored']:
                    release_error = f'Incomplete startup guard restoration: {current}'
    if process.process:
        if not resumed:
            k.TerminateProcess(process.process, 0)
            k.WaitForSingleObject(process.process, 3000)
        k.CloseHandle(process.thread)
        k.CloseHandle(process.process)
    result = state_values()
    if stopped:
        k.CloseHandle(stopped)
    if mapping is not None:
        mapping.close()
    if acquired:
        k.ReleaseMutex(mutex)
    k.CloseHandle(mutex)
    if release_error:
        raise RuntimeError(release_error)
print(json.dumps({'stopped': True, 'guard': result}), flush=True)
