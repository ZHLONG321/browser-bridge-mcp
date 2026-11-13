// Direct Win32 operations. No browser service, Python, shell or foreground activation.
import {join} from 'node:path';
import {mkdir, open, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {screenshotDirectory} from './screenshots.mjs';
import {requireWindows} from './windows-platform.mjs';
export {search_api, describe_api, raw_call} from './windows-api.mjs';

let nativePromise;
async function native() {
  requireWindows();
  return nativePromise ??= import('koffi').then(({default: k}) => {
    const system32 = join(process.env.SystemRoot || 'C:/Windows', 'System32');
    const u = k.load(join(system32, 'user32.dll'));
    const g = k.load(join(system32, 'gdi32.dll'));
    const kernel = k.load(join(system32, 'kernel32.dll'));
    const rect = k.struct({left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'});
    const entry = k.struct({
      dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32', dwFlags: 'uint32', szExeFile: k.array('uint16', 260),
    });
    const callback = k.proto('__stdcall', 'int32', ['uintptr_t', 'intptr_t']);
    const bind = (lib, name, ret, args) => lib.func('__stdcall', name, ret, args);
    return {
      k, entry,
      EnumWindows: bind(u, 'EnumWindows', 'int32', [k.pointer(callback), 'intptr_t']),
      GetWindowTextLengthW: bind(u, 'GetWindowTextLengthW', 'int32', ['uintptr_t']),
      GetWindowTextW: bind(u, 'GetWindowTextW', 'int32', ['uintptr_t', 'void *', 'int32']),
      GetClassNameW: bind(u, 'GetClassNameW', 'int32', ['uintptr_t', 'void *', 'int32']),
      IsWindow: bind(u, 'IsWindow', 'int32', ['uintptr_t']),
      IsWindowVisible: bind(u, 'IsWindowVisible', 'int32', ['uintptr_t']),
      IsIconic: bind(u, 'IsIconic', 'int32', ['uintptr_t']),
      IsZoomed: bind(u, 'IsZoomed', 'int32', ['uintptr_t']),
      GetForegroundWindow: bind(u, 'GetForegroundWindow', 'uintptr_t', []),
      GetWindowThreadProcessId: bind(u, 'GetWindowThreadProcessId', 'uint32', ['uintptr_t', k.out(k.pointer('uint32'))]),
      GetWindowRect: bind(u, 'GetWindowRect', 'int32', ['uintptr_t', k.out(k.pointer(rect))]),
      GetClientRect: bind(u, 'GetClientRect', 'int32', ['uintptr_t', k.out(k.pointer(rect))]),
      OpenProcess: bind(kernel, 'OpenProcess', 'uintptr_t', ['uint32', 'int32', 'uint32']),
      QueryFullProcessImageNameW: bind(kernel, 'QueryFullProcessImageNameW', 'int32', ['uintptr_t', 'uint32', 'void *', k.inout(k.pointer('uint32'))]),
      CloseHandle: bind(kernel, 'CloseHandle', 'int32', ['uintptr_t']),
      CreateToolhelp32Snapshot: bind(kernel, 'CreateToolhelp32Snapshot', 'uintptr_t', ['uint32', 'uint32']),
      Process32FirstW: bind(kernel, 'Process32FirstW', 'int32', ['uintptr_t', k.inout(k.pointer(entry))]),
      Process32NextW: bind(kernel, 'Process32NextW', 'int32', ['uintptr_t', k.inout(k.pointer(entry))]),
      GetLastError: bind(kernel, 'GetLastError', 'uint32', []),
      SetLastError: bind(kernel, 'SetLastError', 'void', ['uint32']),
      SetThreadDpiAwarenessContext: bind(u, 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']),
      GetDC: bind(u, 'GetDC', 'uintptr_t', ['uintptr_t']),
      ReleaseDC: bind(u, 'ReleaseDC', 'int32', ['uintptr_t', 'uintptr_t']),
      PrintWindow: bind(u, 'PrintWindow', 'int32', ['uintptr_t', 'uintptr_t', 'uint32']),
      CreateCompatibleDC: bind(g, 'CreateCompatibleDC', 'uintptr_t', ['uintptr_t']),
      CreateDIBSection: bind(g, 'CreateDIBSection', 'uintptr_t', ['uintptr_t', 'void *', 'uint32', k.out(k.pointer('void *')), 'uintptr_t', 'uint32']),
      SelectObject: bind(g, 'SelectObject', 'uintptr_t', ['uintptr_t', 'uintptr_t']),
      DeleteObject: bind(g, 'DeleteObject', 'int32', ['uintptr_t']),
      DeleteDC: bind(g, 'DeleteDC', 'int32', ['uintptr_t']),
      GdiFlush: bind(g, 'GdiFlush', 'int32', []),
      GetSystemMetrics: bind(u, 'GetSystemMetrics', 'int32', ['int32']),
      BitBlt: bind(g, 'BitBlt', 'int32', ['uintptr_t', 'int32', 'int32', 'int32', 'int32', 'uintptr_t', 'int32', 'int32', 'uint32']),
    };
  });
}

function integer(value, name, min = -2147483648, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in [${min}, ${max}].`);
  return value;
}

function handle(value) {
  if (!(typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) && !(Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('hwnd must be a positive integer or decimal/hexadecimal string.');
  }
  const result = BigInt(value);
  const bits = process.arch === 'ia32' ? 32 : 64;
  if (result <= 0n || result >= 1n << BigInt(bits)) throw new RangeError('hwnd exceeds the native handle range.');
  return result;
}

function fail(n, api) {
  const error = new Error(`${api} failed (Win32 error ${n.GetLastError()}).`);
  error.code = 'WINDOWS_API_FAILED';
  throw error;
}

function requireWindow(n, hwnd) {
  const h = handle(hwnd);
  if (!n.IsWindow(h)) throw new Error('The requested HWND no longer identifies a window. Discover it again.');
  return h;
}

function withDpi(n, fn) {
  const previous = n.SetThreadDpiAwarenessContext(-4);
  if (!previous) fail(n, 'SetThreadDpiAwarenessContext');
  try { return fn(); } finally { n.SetThreadDpiAwarenessContext(previous); }
}

function rectangle(n, h, client = false) {
  const r = {};
  if (!(client ? n.GetClientRect(h, r) : n.GetWindowRect(h, r))) fail(n, client ? 'GetClientRect' : 'GetWindowRect');
  return {...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, unit: 'physical_pixel', reference: client ? 'client' : 'desktop'};
}

function processPath(n, pid) {
  const h = n.OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return {path: null, path_error: n.GetLastError()};
  try {
    const size = [32768]; // Windows extended path limit, in WCHARs.
    const data = Buffer.alloc(size[0] * 2);
    if (!n.QueryFullProcessImageNameW(h, 0, data, size)) return {path: null, path_error: n.GetLastError()};
    return {path: data.toString('utf16le', 0, size[0] * 2)};
  } finally { n.CloseHandle(h); }
}

function windowInfo(n, h) {
  const text = Buffer.alloc((n.GetWindowTextLengthW(h) + 1) * 2);
  const length = n.GetWindowTextW(h, text, text.length / 2);
  const classBuffer = Buffer.alloc(512);
  const classLength = n.GetClassNameW(h, classBuffer, 256);
  const pid = [0];
  const thread_id = n.GetWindowThreadProcessId(h, pid);
  if (!thread_id) fail(n, 'GetWindowThreadProcessId');
  return {
    hwnd: String(h), title: text.toString('utf16le', 0, length * 2), class_name: classBuffer.toString('utf16le', 0, classLength * 2),
    process_id: pid[0], thread_id, visible: !!n.IsWindowVisible(h), minimized: !!n.IsIconic(h), maximized: !!n.IsZoomed(h),
    rect: rectangle(n, h), ...processPath(n, pid[0]),
  };
}

function matcher(title, match) {
  if (typeof title !== 'string') throw new TypeError('title must be a string.');
  if (match === 'regex') { const re = new RegExp(title, 'i'); return value => re.test(value); }
  if (match === 'exact') return value => value.toLowerCase() === title.toLowerCase();
  if (match === 'contains') return value => value.toLowerCase().includes(title.toLowerCase());
  throw new TypeError('match must be contains, exact or regex.');
}

async function enumerateWindows({include_invisible = false, limit, title, match = 'contains'}) {
  requireWindows();
  integer(limit, 'limit', 1, Number.MAX_SAFE_INTEGER);
  if (typeof include_invisible !== 'boolean') throw new TypeError('include_invisible must be boolean.');
  const matches = title === undefined ? () => true : matcher(title, match);
  const n = await native();
  return withDpi(n, () => {
    const windows = [];
    let callbackError;
    n.SetLastError(0);
    const ok = n.EnumWindows(h => {
      try {
        if (!include_invisible && !n.IsWindowVisible(h)) return 1;
        // A window may disappear during enumeration; do not silently discard other errors.
        if (!n.IsWindow(h)) return 1;
        const info = windowInfo(n, h);
        if (matches(info.title)) windows.push(info);
        return windows.length < limit ? 1 : 0;
      } catch (error) { callbackError = error; return 0; }
    }, 0);
    if (callbackError) throw callbackError;
    if (!ok && windows.length < limit) fail(n, 'EnumWindows');
    return windows;
  });
}

export function list_windows({include_invisible = false, limit = 500} = {}) { return enumerateWindows({include_invisible, limit}); }
export function find_windows({title, match = 'contains', include_invisible = false, limit = 100} = {}) {
  requireWindows();
  matcher(title, match);
  return enumerateWindows({title, match, include_invisible, limit});
}
export async function get_window({hwnd} = {}) {
  const n = await native();
  return withDpi(n, () => windowInfo(n, requireWindow(n, hwnd)));
}
export async function get_foreground_window() {
  const n = await native();
  const h = n.GetForegroundWindow();
  return h ? withDpi(n, () => windowInfo(n, h)) : null;
}
export async function get_window_rect({hwnd} = {}) {
  const n = await native();
  return withDpi(n, () => rectangle(n, requireWindow(n, hwnd)));
}
export async function get_client_rect({hwnd} = {}) {
  const n = await native();
  return withDpi(n, () => rectangle(n, requireWindow(n, hwnd), true));
}
export async function get_window_process({hwnd} = {}) {
  const n = await native();
  const h = requireWindow(n, hwnd), pid = [0];
  const thread_id = n.GetWindowThreadProcessId(h, pid);
  if (!thread_id) fail(n, 'GetWindowThreadProcessId');
  return {hwnd: String(h), process_id: pid[0], thread_id, ...processPath(n, pid[0])};
}

async function processes(limit, requestedPid) {
  const n = await native();
  const snapshot = n.CreateToolhelp32Snapshot(2, 0);
  if (BigInt.asIntN(process.arch === 'ia32' ? 32 : 64, BigInt(snapshot)) === -1n) fail(n, 'CreateToolhelp32Snapshot');
  const result = [], data = {dwSize: n.k.sizeof(n.entry)};
  try {
    let ok = n.Process32FirstW(snapshot, data);
    while (ok) {
      if (requestedPid === undefined || data.th32ProcessID === requestedPid) {
        const end = data.szExeFile.indexOf(0);
        result.push({process_id: data.th32ProcessID, parent_process_id: data.th32ParentProcessID, threads: data.cntThreads,
          name: String.fromCharCode(...Array.from(data.szExeFile).slice(0, end < 0 ? undefined : end)), ...processPath(n, data.th32ProcessID)});
        if (result.length >= limit || requestedPid !== undefined) break;
      }
      ok = n.Process32NextW(snapshot, data);
    }
    if (!ok && n.GetLastError() !== 18) fail(n, 'Process32FirstW/Process32NextW'); // ERROR_NO_MORE_FILES
    return result;
  } finally { n.CloseHandle(snapshot); }
}
export function list_processes({limit = 5000} = {}) {
  requireWindows();
  return processes(integer(limit, 'limit', 1, Number.MAX_SAFE_INTEGER));
}
export async function get_process({process_id} = {}) {
  requireWindows();
  integer(process_id, 'process_id', 0, 0xffffffff);
  const found = await processes(1, process_id);
  if (!found.length) throw new Error('The requested process no longer exists. Discover it again.');
  return found[0];
}

function bitmap(n, {hwnd, x, y, width, height}) {
  const window = hwnd === undefined ? undefined : requireWindow(n, hwnd);
  if (window !== undefined && n.IsIconic(window)) throw new Error('Cannot capture a minimized window without restoring it. Restoration needs foreground authorization.');
  if (window !== undefined) ({width, height} = rectangle(n, window));
  integer(width, 'width', 1); integer(height, 'height', 1);
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Bitmap exceeds the safe buffer range.');
  if (window === undefined) {
    integer(x, 'x'); integer(y, 'y');
    const left = n.GetSystemMetrics(76), top = n.GetSystemMetrics(77);
    if (x < left || y < top || x + width > left + n.GetSystemMetrics(78) || y + height > top + n.GetSystemMetrics(79)) {
      throw new RangeError('Region must fit within the physical virtual desktop.');
    }
  }
  const source = n.GetDC(0);
  if (!source) fail(n, 'GetDC');
  let dc = 0, dib = 0, old = 0;
  try {
    dc = n.CreateCompatibleDC(source);
    if (!dc) fail(n, 'CreateCompatibleDC');
    const header = Buffer.alloc(44); // BITMAPINFOHEADER + one RGBQUAD, 32-bit top-down BI_RGB.
    header.writeUInt32LE(40, 0); header.writeInt32LE(width, 4); header.writeInt32LE(-height, 8);
    header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
    const bits = [null];
    dib = n.CreateDIBSection(source, header, 0, bits, 0, 0);
    if (!dib || !bits[0]) fail(n, 'CreateDIBSection');
    old = n.SelectObject(dc, dib);
    if (!old || BigInt.asIntN(process.arch === 'ia32' ? 32 : 64, BigInt(old)) === -1n) fail(n, 'SelectObject');
    const ok = window === undefined ? n.BitBlt(dc, 0, 0, width, height, source, x, y, 0x40cc0020) : n.PrintWindow(window, dc, 2);
    if (!ok) fail(n, window === undefined ? 'BitBlt' : 'PrintWindow');
    if (!n.GdiFlush()) fail(n, 'GdiFlush');
    // Copy before the DIB is released in finally; Buffer.from(ArrayBuffer) would share freed memory.
    const rgba = Buffer.from(new Uint8Array(n.k.view(bits[0], bytes)));
    for (let i = 0; i < rgba.length; i += 4) {
      const blue = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = blue; rgba[i + 3] = 255;
    }
    return {rgba, width, height};
  } finally {
    if (old) n.SelectObject(dc, old);
    if (dib) n.DeleteObject(dib);
    if (dc) n.DeleteDC(dc);
    n.ReleaseDC(0, source);
  }
}

async function capture({session_id, format = 'webp', quality = format === 'jpeg' ? 90 : 100, return_image = false, rect, ...area}) {
  requireWindows();
  const directory = screenshotDirectory(session_id);
  if (!['webp', 'jpeg'].includes(format)) throw new TypeError('format must be webp or jpeg.');
  integer(quality, 'quality', 1, 100);
  if (typeof return_image !== 'boolean') throw new TypeError('return_image must be a boolean.');
  const n = await native();
  const {rgba, width, height} = withDpi(n, () => bitmap(n, area));
  const {default: sharp} = await import('sharp');
  const image = sharp(rgba, {raw: {width, height, channels: 4}, limitInputPixels: false}).removeAlpha();
  if (rect !== undefined) {
    if (area.hwnd === undefined) throw new TypeError('rect is a window-relative crop; desktop capture uses x/y/width/height.');
    integer(rect.x, 'rect.x', 0); integer(rect.y, 'rect.y', 0);
    integer(rect.width, 'rect.width', 1); integer(rect.height, 'rect.height', 1);
    if (rect.x + rect.width > width || rect.y + rect.height > height) throw new RangeError('Window crop must fit inside the captured window.');
    image.extract({left: rect.x, top: rect.y, width: rect.width, height: rect.height});
  }
  const encoded = await (format === 'webp' ? image.webp({quality}) : image.jpeg({quality})).toBuffer();
  const filename = `windows-${randomUUID()}.${format === 'jpeg' ? 'jpg' : 'webp'}`;
  await mkdir(directory, {recursive: true});
  const path = join(directory, filename);
  const file = await open(path, 'wx');
  try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
  const saved = await stat(path);
  if (!saved.isFile() || !saved.size || saved.size !== encoded.length) throw new Error('Screenshot file is missing or incomplete.');
  console.error(`Windows screenshot: ${rect?.width ?? width}x${rect?.height ?? height}, ${saved.size} bytes (${format}).`);
  return return_image ? {filename, image: {type: 'image', data: encoded.toString('base64'), mimeType: `image/${format}`}} : filename;
}

export async function capture_window({hwnd, title, title_match = 'exact', ...options} = {}) {
  requireWindows();
  if ((hwnd === undefined) === (title === undefined)) throw new TypeError('Supply exactly one of hwnd or title.');
  if (title !== undefined) {
    const found = await find_windows({title, match: title_match});
    if (found.length !== 1) throw new Error(`Window title matched ${found.length} visible windows; resolve an exact HWND first.`);
    hwnd = found[0].hwnd;
  }
  return capture({...options, hwnd});
}
export async function capture_foreground(options = {}) {
  const n = await native(), hwnd = n.GetForegroundWindow();
  if (!hwnd) throw new Error('There is no foreground window to capture.');
  return capture({...options, hwnd: String(hwnd)});
}
export function capture_region({x, y, width, height, ...options} = {}) { return capture({...options, x, y, width, height}); }
