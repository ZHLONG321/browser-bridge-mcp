"""Microsoft Learn signatures and ctypes calls, independently of the Node implementation."""
from __future__ import annotations

import ctypes as c
import math
import re
from html.parser import HTMLParser
from os import environ
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, SecretStr

from ._native import Json, Record
from ._platform import integer, require_windows

HANDLES = {"HANDLE", "HWND", "HDC", "HGDIOBJ", "HBITMAP", "HMODULE", "HINSTANCE", "HICON", "HCURSOR",
           "HMENU", "HMONITOR", "HKL", "HHOOK", "HRGN", "HBRUSH", "HFONT", "HPALETTE", "HGLOBAL", "HLOCAL", "HKEY"}
WIDE = {"LPCWSTR", "PCWSTR", "LPCWCH", "const WCHAR *", "const wchar_t *"}
ANSI = {"LPCSTR", "PCSTR", "const CHAR *", "const char *"}
TYPES: dict[str, type[c._SimpleCData] | None] = {"void": None, "VOID": None}
for names, kind in [
    ("BOOL LONG INT HRESULT INT32 int long", c.c_int32), ("BOOLEAN BYTE UCHAR", c.c_uint8), ("CHAR", c.c_int8),
    ("WORD USHORT ATOM WCHAR", c.c_uint16), ("SHORT short", c.c_int16), ("DWORD DWORD32 UINT ULONG UINT32", c.c_uint32),
    ("UINT64 DWORD64 ULONGLONG", c.c_uint64), ("INT64 LONGLONG", c.c_int64),
    ("LONG_PTR INT_PTR LPARAM LRESULT SSIZE_T", c.c_ssize_t), ("UINT_PTR ULONG_PTR DWORD_PTR WPARAM SIZE_T", c.c_size_t),
    ("FLOAT float", c.c_float), ("DOUBLE double", c.c_double),
]:
    TYPES.update(dict.fromkeys(names.split(), kind))
TYPES.update({"unsigned int": c.c_uint32, "unsigned long": c.c_uint32, "unsigned short": c.c_uint16})


class Candidate(BaseModel):
    title: str
    url: str
    description: str | None = None


class SearchResults(BaseModel):
    results: list[Candidate]


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.metadata: dict[str, str] = {}
        self.blocks: list[str] = []
        self._pre = False
        self._code = False
        self._content: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "meta" and values.get("name") and values.get("content"):
            self.metadata[str(values["name"])] = str(values["content"])
        if tag == "pre":
            self._pre = True
        if tag == "code" and self._pre:
            self._code = True
            self._content = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "code" and self._code:
            self.blocks.append("".join(self._content).strip())
            self._code = False
        if tag == "pre":
            self._pre = False

    def handle_data(self, data: str) -> None:
        if self._code:
            self._content.append(data)


def native_type(name: str, *, input: bool = False) -> type[c._SimpleCData] | None:
    if name in HANDLES:
        return c.c_void_p
    if input and name in WIDE:
        return c.c_wchar_p
    if input and name in ANSI:
        return c.c_char_p
    if name not in TYPES:
        raise ValueError(f"Unsupported Win32 type {name}: use a saved ctypes script with the documented pointer/structure contract.")
    return TYPES[name]


def signature(api: str, syntax: str) -> tuple[str, list[tuple[str, str]]]:
    clean = re.sub(r"/\*.*?\*/|//[^\n]*", "", syntax, flags=re.DOTALL).strip()
    found = re.fullmatch(rf"([\w *]+?)\s+{re.escape(api)}\s*\((.*?)\)\s*;?", clean, flags=re.DOTALL)
    if found is None:
        raise ValueError("C signature is outside the supported scalar/handle/input-string subset.")
    canonical = lambda value: re.sub(r"\s*\*\s*", " *", re.sub(r"\s+", " ", value.strip())).strip()
    returns = canonical(found[1])
    native_type(returns)
    parameters: list[tuple[str, str]] = []
    body = found[2].strip()
    if body and body not in ("void", "VOID"):
        if re.search(r"\[[^\]]*\bout\b[^\]]*\]", body, flags=re.IGNORECASE):
            raise ValueError("Output and in/out parameters require a typed native script or a convenience operation.")
        for declaration in re.sub(r"\[[^\]]*\]", "", body).split(","):
            parameter = re.fullmatch(r"(.+?[\s*])([A-Za-z_]\w*)", declaration.strip())
            if parameter is None:
                raise ValueError("Parameter syntax is unsupported.")
            kind = canonical(parameter[1])
            if native_type(kind, input=True) is None:
                raise ValueError("void is not an input parameter type.")
            parameters.append((parameter[2], kind))
    return returns, parameters


class Catalog:
    def __init__(self, proxy_url: str | SecretStr | None) -> None:
        self.proxy = SecretStr(proxy_url) if isinstance(proxy_url, str) else proxy_url

    def fetch(self, url: str, *, params: dict[str, str] | None = None) -> httpx.Response:
        with httpx.Client(proxy=self.proxy.get_secret_value() if self.proxy else None,
                          trust_env=False, follow_redirects=True, timeout=20) as client:
            response = client.get(url, params=params)
            response.raise_for_status()
            return response

    def search(self, query: str, max_results: int) -> list[Record]:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be nonempty.")
        integer(max_results, "max_results", 1, 2**53 - 1)
        response = self.fetch("https://learn.microsoft.com/api/search", params={
            "search": f"{query} Win32 API", "locale": "en-us", "$filter": "(category eq 'Documentation')", "$top": str(max_results)})
        found = SearchResults.model_validate_json(response.content)
        result: list[Record] = []
        for item in found.results:
            if re.fullmatch(r"https://learn\.microsoft\.com/en-us/windows/win32/api/[^/]+/nf-[^/]+", item.url, re.IGNORECASE):
                name = re.match(r"^([A-Za-z_]\w*)\s+function\b", item.title, re.IGNORECASE)
                result.append({"api": name[1] if name else None, "title": item.title, "url": item.url, "description": item.description})
        return result[:max_results]

    def describe(self, api: str) -> Record:
        if not isinstance(api, str) or not re.fullmatch(r"[A-Za-z_]\w*", api):
            raise ValueError("api must be an exact Win32 export name.")
        exact = next((item for item in self.search(api, 30) if item["api"] == api), None)
        if exact is None:
            raise ValueError(f"Microsoft Learn did not return an exact function page for {api}.")
        page = Page()
        page.feed(self.fetch(str(exact["url"])).text)
        syntax = next((block for block in page.blocks if re.search(rf"\b{re.escape(api)}\s*\(", block)), None)
        if syntax is None:
            raise ValueError("The exact Learn page contains no matching C syntax block.")
        result: Record = {**exact, "syntax": syntax, "description": page.metadata.get("description") or exact["description"],
                          "dll": page.metadata.get("req.dll"), "header": page.metadata.get("req.header"), "library": page.metadata.get("req.lib")}
        try:
            returns, parameters = signature(api, syntax)
            result["return_type"] = returns
            result["parameters"] = [{"name": name, "type": kind} for name, kind in parameters]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+\.dll", str(result["dll"]), re.IGNORECASE):
                raise ValueError("The page does not identify one loadable Windows system DLL.")
            result["simple_raw_call_supported"] = True
        except ValueError as error:
            result.update(simple_raw_call_supported=False, unsupported_reason=str(error))
        return result


def value_for(kind: str, value: Json, name: str) -> str | bytes | int | float | None:
    native = native_type(kind, input=True)
    if kind in WIDE or kind in ANSI:
        if value is None:
            return None
        if not isinstance(value, str) or "\0" in value:
            raise ValueError(f"{name} must be a string without NUL, or null.")
        return value.encode("ascii") if kind in ANSI else value
    if native in (c.c_float, c.c_double):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number.")
        return value
    if value is None and kind in HANDLES:
        return None
    if kind in ("BOOL", "BOOLEAN") and isinstance(value, bool):
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?(?:\d+|0x[\da-f]+)", value, re.IGNORECASE):
        value = int(value, 16 if "x" in value.lower() else 10)
    if native is None or isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an exact integer.")
    bits = c.sizeof(native) * 8
    unsigned = kind in HANDLES or native(-1).value > 0
    minimum, maximum = (0, 2**bits - 1) if unsigned else (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
    if kind in HANDLES and -(2 ** (bits - 1)) <= value < 0:
        return value % (2**bits)
    return integer(value, name, minimum, maximum)


def raw_call(api: str, arguments: dict[str, Json], mode: Literal["read_only", "authorized_mutation"],
             allow_foreground: bool, proxy_url: str | SecretStr | None) -> Record:
    require_windows()
    if mode not in ("read_only", "authorized_mutation") or not isinstance(allow_foreground, bool):
        raise ValueError("Supply a valid authorization mode and boolean allow_foreground; mode is not a sandbox.")
    if not isinstance(arguments, dict):
        raise TypeError("arguments must be an object keyed by documented parameter names.")
    description = Catalog(proxy_url).describe(api)
    if not description["simple_raw_call_supported"]:
        raise ValueError(str(description["unsupported_reason"]))
    returns, parameters = signature(api, str(description["syntax"]))
    if {name for name, _ in parameters} != set(arguments):
        raise ValueError("Supply every documented parameter name exactly once, including optional NULL values.")
    focuses = api in {"SetForegroundWindow", "BringWindowToTop", "SetActiveWindow", "SetFocus", "SwitchToThisWindow"}
    if api in ("ShowWindow", "ShowWindowAsync"):
        focuses = int(str(arguments.get("nCmdShow"))) not in (0, 4, 7, 8)
    if api == "SetWindowPos":
        flags = str(arguments.get("uFlags"))
        focuses = not int(flags, 16 if flags.lower().startswith("0x") else 10) & 0x10
    if focuses and (mode != "authorized_mutation" or not allow_foreground):
        raise ValueError("This API may activate a window; explicit user permission, authorized_mutation and allow_foreground:true are required.")
    lib = c.WinDLL(str(Path(environ.get("SystemRoot", "C:/Windows")) / "System32" / str(description["dll"])), use_last_error=True)
    fn = getattr(lib, api)
    fn.restype = native_type(returns)
    fn.argtypes = [native_type(kind, input=True) for _, kind in parameters]
    values = [value_for(kind, arguments[name], name) for name, kind in parameters]
    c.set_last_error(0)
    result = fn(*values)
    last_error = c.get_last_error()
    value: Json = 0 if result is None and returns in HANDLES else result
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        value = str(value)
    return {"api": api, "value": value, "last_error": last_error, "return_type": returns,
            "syntax": description["syntax"], "documentation_url": description["url"],
            "interpretation": "Interpret the return value and last_error using this API documentation; last_error is not a universal success indicator."}
