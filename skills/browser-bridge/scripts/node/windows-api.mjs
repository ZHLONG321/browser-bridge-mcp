// Microsoft Learn is the signature source; unsupported pointers/structures are rejected.
import {join} from 'node:path';
import {fetch, ProxyAgent} from 'undici';
import {requireWindows} from './windows-platform.mjs';

const handles = new Set(['HANDLE', 'HWND', 'HDC', 'HGDIOBJ', 'HBITMAP', 'HMODULE', 'HINSTANCE', 'HICON', 'HCURSOR', 'HMENU', 'HMONITOR', 'HKL', 'HHOOK', 'HRGN', 'HBRUSH', 'HFONT', 'HPALETTE', 'HGLOBAL', 'HLOCAL', 'HKEY']);
const types = {
  void: 'void', VOID: 'void', BOOL: 'int32', BOOLEAN: 'uint8', BYTE: 'uint8', CHAR: 'int8', UCHAR: 'uint8',
  WORD: 'uint16', SHORT: 'int16', USHORT: 'uint16', ATOM: 'uint16', WCHAR: 'uint16',
  DWORD: 'uint32', DWORD32: 'uint32', UINT: 'uint32', ULONG: 'uint32', LONG: 'int32', INT: 'int32', HRESULT: 'int32',
  UINT32: 'uint32', INT32: 'int32', UINT64: 'uint64', INT64: 'int64', DWORD64: 'uint64', ULONGLONG: 'uint64', LONGLONG: 'int64',
  LONG_PTR: 'intptr_t', INT_PTR: 'intptr_t', LPARAM: 'intptr_t', LRESULT: 'intptr_t',
  UINT_PTR: 'uintptr_t', ULONG_PTR: 'uintptr_t', DWORD_PTR: 'uintptr_t', WPARAM: 'uintptr_t', SIZE_T: 'uintptr_t', SSIZE_T: 'intptr_t',
  int: 'int32', 'unsigned int': 'uint32', long: 'int32', 'unsigned long': 'uint32', short: 'int16', 'unsigned short': 'uint16',
  float: 'float', FLOAT: 'float', double: 'double', DOUBLE: 'double',
};
const wideStrings = new Set(['LPCWSTR', 'PCWSTR', 'LPCWCH', 'const WCHAR *', 'const wchar_t *']);
const ansiStrings = new Set(['LPCSTR', 'PCSTR', 'const CHAR *', 'const char *']);
const knownFocusApis = new Set(['SetForegroundWindow', 'BringWindowToTop', 'SetActiveWindow', 'SetFocus', 'SwitchToThisWindow']);

function text(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, entity => {
    const fixed = {'&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'"};
    if (fixed[entity]) return fixed[entity];
    return String.fromCodePoint(entity.startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10));
  }).trim();
}
function metadata(page, name) {
  for (const tag of page.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w.-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), text(m[2])]));
    if (attrs.name === name) return attrs.content || null;
  }
  return null;
}
async function download(url, proxy_url, json = false) {
  const dispatcher = proxy_url ? new ProxyAgent(proxy_url) : undefined;
  try {
    const response = await fetch(url, {dispatcher, signal: AbortSignal.timeout(20000), headers: {Accept: json ? 'application/json' : 'text/html'}});
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Microsoft Learn returned HTTP ${response.status}.`); }
    return await (json ? response.json() : response.text());
  } finally { await dispatcher?.close(); }
}

export async function search_api({query, max_results = 10, proxy_url} = {}) {
  requireWindows();
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be nonempty.');
  if (!Number.isSafeInteger(max_results) || max_results < 1) throw new TypeError('max_results must be a positive integer.');
  const url = new URL('https://learn.microsoft.com/api/search');
  url.search = new URLSearchParams({search: `${query} Win32 API`, locale: 'en-us', '$filter': "(category eq 'Documentation')", '$top': String(max_results)});
  const data = await download(url.href, proxy_url, true);
  if (!Array.isArray(data.results)) throw new Error('Microsoft Learn search returned no results array.');
  return data.results.filter(item => /^https:\/\/learn\.microsoft\.com\/en-us\/windows\/win32\/api\/[^/]+\/nf-[^/]+$/i.test(item.url || ''))
    .map(item => ({api: item.title?.match(/^([A-Za-z_]\w*)\s+function\b/i)?.[1] ?? null, title: item.title, url: item.url, description: item.description})).slice(0, max_results);
}

function canonical(type) { return type.trim().replace(/\s+/g, ' ').replace(/\s*\*\s*/g, ' *').trim(); }
function mapped(type, input = false) {
  if (handles.has(type)) return 'uintptr_t';
  if (input && wideStrings.has(type)) return 'str16';
  if (input && ansiStrings.has(type)) return 'str';
  const found = types[type];
  if (!found) throw new Error(`Unsupported Win32 type ${type}: use a saved native script with the documented structure/pointer contract.`);
  return found;
}
function parse(api, syntax) {
  const clean = syntax.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  const match = clean.match(new RegExp(`^([\\w *]+?)\\s+${api}\\s*\\(([\\s\\S]*?)\\)\\s*;?$`));
  if (!match) throw new Error('C signature is outside the supported scalar/handle/input-string subset.');
  const return_type = canonical(match[1]);
  mapped(return_type);
  const parameters = [];
  const body = match[2].trim();
  if (body && body !== 'void' && body !== 'VOID') {
    // Remove SAL [in, optional] groups before splitting parameter commas.
    for (const declaration of body.replace(/\[[^\]]*\]/g, sal => /\bout\b/i.test(sal) ? '__OUTPUT__ ' : '').split(',')) {
      if (/__OUTPUT__/.test(declaration)) throw new Error('Output and in/out parameters require a typed native script or a convenience operation.');
      const parameter = declaration.trim().match(/^(.+?[\s*])([A-Za-z_]\w*)$/);
      if (!parameter) throw new Error('Parameter syntax is unsupported.');
      const type = canonical(parameter[1]);
      if (mapped(type, true) === 'void') throw new Error('void is not an input parameter type.');
      parameters.push({name: parameter[2], type});
    }
  }
  return {return_type, parameters};
}

export async function describe_api({api, proxy_url} = {}) {
  requireWindows();
  if (typeof api !== 'string' || !/^[A-Za-z_]\w*$/.test(api)) throw new TypeError('api must be an exact Win32 export name.');
  const candidates = await search_api({query: api, max_results: 30, proxy_url});
  const exact = candidates.find(item => item.api === api);
  if (!exact) throw new Error(`Microsoft Learn did not return an exact function page for ${api}.`);
  const page = await download(exact.url, proxy_url);
  const syntax = [...page.matchAll(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi)]
    .map(match => text(match[1])).find(code => new RegExp(`\\b${api}\\s*\\(`).test(code));
  if (!syntax) throw new Error('The exact Learn page contains no matching C syntax block.');
  const description = {...exact, description: metadata(page, 'description') || exact.description,
    syntax, dll: metadata(page, 'req.dll'), header: metadata(page, 'req.header'), library: metadata(page, 'req.lib')};
  try {
    Object.assign(description, parse(api, syntax));
    if (!/^[A-Za-z0-9_.-]+\.dll$/i.test(description.dll || '')) throw new Error('The page does not identify one loadable Windows system DLL.');
    description.simple_raw_call_supported = true;
  } catch (error) { description.simple_raw_call_supported = false; description.unsupported_reason = error.message; }
  return description;
}

function valueFor(k, type, value, name) {
  const ffiType = mapped(type, true);
  if (ffiType === 'str' || ffiType === 'str16') {
    if (value === null) return null;
    if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${name} must be a string without NUL, or null.`);
    if (ffiType === 'str' && /[^\x00-\x7f]/.test(value)) throw new TypeError('ANSI input strings currently support ASCII only; use the W export for Unicode.');
    return value;
  }
  if (['float', 'double'].includes(ffiType)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
    return value;
  }
  if (value === null && handles.has(type)) return 0;
  if ((type === 'BOOL' || type === 'BOOLEAN') && typeof value === 'boolean') return Number(value);
  if (!(typeof value === 'string' && /^-?(?:\d+|0x[\da-f]+)$/i.test(value)) && !Number.isSafeInteger(value) && typeof value !== 'bigint') {
    throw new TypeError(`${name} must be an exact integer; use a decimal/hex string for large values.`);
  }
  const integer = typeof value === 'string' && value.startsWith('-0x') ? -BigInt(value.slice(1)) : BigInt(value);
  const bits = BigInt(k.sizeof(ffiType) * 8), unsigned = ffiType.startsWith('u');
  const minimum = unsigned ? 0n : -(1n << (bits - 1n));
  const maximum = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
  // Negative pseudo-handles such as HWND_TOPMOST and INVALID_HANDLE_VALUE have pointer-sized bit patterns.
  if (handles.has(type) && integer < 0n && integer >= -(1n << (bits - 1n))) return BigInt.asUintN(Number(bits), integer);
  if (integer < minimum || integer > maximum) throw new RangeError(`${name} exceeds ${type}.`);
  return integer;
}

export async function raw_call({api, arguments: args = {}, proxy_url, mode, allow_foreground = false} = {}) {
  requireWindows();
  if (!['read_only', 'authorized_mutation'].includes(mode)) throw new TypeError('raw_call requires mode: read_only or authorized_mutation. This records caller intent; it is not a sandbox.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('arguments must be an object keyed by documented parameter names.');
  const description = await describe_api({api, proxy_url});
  if (!description.simple_raw_call_supported) throw new Error(description.unsupported_reason);
  const names = description.parameters.map(item => item.name);
  if (names.length !== Object.keys(args).length || names.some(name => !Object.hasOwn(args, name))) throw new TypeError('Supply every documented parameter name exactly once, including optional NULL values.');
  const mayFocus = knownFocusApis.has(api) || (api === 'ShowWindow' || api === 'ShowWindowAsync') && ![0, 4, 7, 8].includes(Number(args.nCmdShow)) ||
    api === 'SetWindowPos' && !(Number(args.uFlags) & 0x10);
  if (mayFocus && (allow_foreground !== true || mode !== 'authorized_mutation')) throw new Error('This API may activate a window; explicit user foreground authorization, authorized_mutation and allow_foreground:true are required.');
  const {default: k} = await import('koffi');
  const system32 = join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const library = k.load(join(system32, description.dll));
  const kernel = k.load(join(system32, 'kernel32.dll'));
  const getError = kernel.func('__stdcall', 'GetLastError', 'uint32', []);
  const clearError = kernel.func('__stdcall', 'SetLastError', 'void', ['uint32']);
  const fn = library.func('__stdcall', api, mapped(description.return_type), description.parameters.map(p => mapped(p.type, true)));
  const values = description.parameters.map(p => valueFor(k, p.type, args[p.name], p.name));
  clearError(0);
  const result = fn(...values), last_error = getError();
  return {api, value: typeof result === 'bigint' ? String(result) : result ?? null, last_error,
    return_type: description.return_type, syntax: description.syntax, documentation_url: description.url,
    interpretation: 'Interpret the return value and last_error using this API documentation; last_error is not a universal success indicator.'};
}
