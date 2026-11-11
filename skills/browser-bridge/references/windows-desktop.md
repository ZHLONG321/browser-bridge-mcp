# Windows desktop commands

On non-Windows systems, all 15 operations (including documentation search/description) immediately report `WINDOWS_UNAVAILABLE` with `details.platform`; they do not start a worker, load Win32 libraries, create screenshot files or make documentation requests. MCP returns an error result, CLI prints the structured error and exits nonzero, and direct Node calls throw an error with the same code/details. Guarded Windows browser helpers use the same platform error. This does not disable the other browser tools.

Use these commands when browser calls fail or Windows evidence is needed to continue the authorized browser task. They run directly in Node.js on Windows and require neither Python/BO nor a live Bridge service/extension. Install the locked dependencies as described in [MCP installation](mcp.md); Node.js 20.9+ is required. Koffi and sharp use platform-specific prebuilt optional npm packages. Do not omit optional dependencies. Supported prebuilt combinations follow [Koffi](https://koffi.dev/) and [sharp](https://sharp.pixelplumbing.com/install/); do not silently install a compiler or Python on a machine lacking a matching binary.

This command family is separate from the older guarded browser-creation helpers in [Windows operations](windows.md), which still require their Python/native prerequisites. Native desktop commands do not establish a logged-in profile or bypass browser access controls.

## Authorization and targets

Background execution is the default; do not repeatedly announce it. Without separate user authorization, WinAPI may act only on browsers and programs/windows directly related to the browser task. Listing windows/processes is discovery, not permission to act on arbitrary applications. Resolve a live HWND/PID and its executable/title before acting. HWNDs and PIDs may be reused after closure; rediscover stale targets. A native HWND is not a Bridge `window_id`; correlate it with live browser metadata and retain the user's profile, privacy and same-window constraints.

When foreground interaction is necessary, obtain explicit permission unless already given, then perform it through the Windows commands yourself. Do not ask the user to keep a page visible and return to Codex. `raw_call` requires `mode: read_only / authorized_mutation`; this records intent and does not sandbox arbitrary API effects. Foreground effects require permission and `allow_foreground: true`; known activation APIs are additionally checked by the adapter. Other native APIs can also affect focus, so the caller must assess their documented effects. Windows foreground restrictions can still refuse activation. Inspect actual return values and foreground state. No operation automatically retries, restores a minimized window or falls back to a foreground screenshot.

## Interfaces

For a simple call, use `windows_<operation>` in MCP, or run from the installed skill directory:

```bat
scripts\browser-bridge.bat windows list-windows
scripts\browser-bridge.bat windows find-windows --title Edge --match contains
scripts\browser-bridge.bat windows get-window-process --hwnd <resolved-hwnd>
scripts\browser-bridge.bat windows capture-window --hwnd <resolved-hwnd> --session-id <caller-session-id>
scripts\browser-bridge.bat windows describe-api --api SetForegroundWindow --proxy-url <proxy-url>
scripts\browser-bridge.bat windows raw-call --json "<saved-request.json>"
```

Hyphens/underscores in operation/flag names are equivalent. Each flag requires a value; values parse as JSON when possible, otherwise as plain strings. `--json` loads an options object from a file; duplicate/unknown fields fail. Nested `arguments` belongs in that file rather than shell-embedded code. A successful capture prints only its filename; other commands print JSON. Errors print JSON to stderr with a nonzero exit code. The equivalent direct Node command is `node scripts/node/windows-command.mjs <operation> ...`.

For coordinated requests/result processing, save a `.mjs` file and import the direct functions:

```js
import * as desktop from '<installed-skill>/scripts/node/desktop.mjs';

const candidates = await desktop.find_windows({title: 'Edge', match: 'contains'});
if (candidates.length !== 1) throw new Error('Resolve the target HWND from the task conditions before acting.');
const target = candidates[0];
console.log(await desktop.get_window_process({hwnd: target.hwnd}));
```

Resolve the import to the actual installed path. Each direct function takes an options object and returns its value, with no `.run()` or saved current target. Browser functions remain in `client.mjs`; guarded browser creation remains in `windows.mjs`. The independent Windows functions are in `desktop.mjs`.

MCP/CLI calls use a dedicated Node child process per operation, with no console window, and `timeout_ms` defaulting to 30000. This keeps synchronous native calls such as PrintWindow from blocking the MCP event loop. A timeout terminates only that worker; a raw call may already have changed state, so inspect before replaying it. A timed-out capture may leave a partial file and never returns its filename. Direct `desktop.mjs` functions execute in the caller process and can block on native calls. To isolate a single operation from a script, import `windows_call(operation, options)` from `scripts/node/windows-runner.mjs`.

HWNDs/PIDs can identify targets across calls. Handles returned by OpenProcess, GDI allocations and similar APIs are **local to their owning process**. They cannot be passed from one MCP/CLI worker to another. Compose such operations in one saved Node script importing `desktop.mjs`, and release acquired handles/resources in `finally`. Do not return a process-local handle from an isolated worker expecting it to remain usable.

## Operations

Every MCP/CLI operation accepts optional `timeout_ms`; it belongs to the worker runner, not the direct native function. There is no implicit browser/profile selection.

| Operation / MCP suffix | Fields and result |
| --- | --- |
| `list_windows` | `include_invisible=false`, `limit=500`; live windows with title/class, HWND, PID/thread, visibility/minimized/maximized, bounds and executable path |
| `find_windows` | Required `title`; `match=contains / exact / regex`, `include_invisible=false`, `limit=100`; all matching candidates up to the requested limit |
| `get_foreground_window` | No target; current foreground window metadata, or null if none; does not activate it |
| `get_window` | Required `hwnd`; one live window's metadata |
| `get_window_rect` | Required `hwnd`; full native-window bounds in physical desktop pixels |
| `get_client_rect` | Required `hwnd`; physical-pixel client bounds relative to the client origin, without caption/borders |
| `get_window_process` | Required `hwnd`; PID, thread and executable path |
| `list_processes` | `limit=5000`; live PID, parent PID, thread count, executable name/path |
| `get_process` | Required `process_id`; one live process |
| `capture_window` | Exactly one of `hwnd` or `title`; `title_match=exact / contains / regex` (default exact), plus capture fields below |
| `capture_foreground` | Captures the existing foreground window without switching focus; capture fields below |
| `capture_region` | Required integer `x`, `y`, positive integer `width`, `height`, in physical desktop pixels; capture fields below |
| `search_api` | Required `query`; `max_results=10`, optional explicit `proxy_url`; Microsoft Learn function candidates |
| `describe_api` | Required exact `api`, optional `proxy_url`; exact C signature, DLL, types, documentation URL and raw-call support/reason |
| `raw_call` | Required exact `api`, `arguments` object keyed by documented names, `mode`; optional `proxy_url`, `allow_foreground=false`; native value and signature/source |

MCP list results use `{items: [...]}`; no-foreground uses `{window: null}`. Direct Node/CLI functions return arrays/null directly. Executable paths that cannot be read remain `path: null` with `path_error`; access denial does not mean the process is absent. No command silently launches/stops a process as inspection or repairs a browser by clearing data.

## Captures and coordinates

All captures require the active caller's `session_id`. Optional `format` is `webp` (default) or `jpeg`; `quality` is 1–100, default 100 for WebP and 90 for JPEG. Confirm the client can read WebP before using it; choose JPEG otherwise. Encode every capture, preserve native dimensions, and impose no file-size cap or automatic quality reduction. Store under `%TMP%/codex-<session_id>-browser-bridge/screen/`. The return value is **only the filename**, after the file is fully written, flushed, closed and checked for the expected nonzero byte count. Dimensions and saved byte count go to stderr. Inspect the image with the client's local image viewer using the reconstructed absolute path.

Window capture uses PrintWindow without activating/restoring it. Minimized targets fail; hardware-accelerated, protected or native PDF content may be blank even when PrintWindow succeeds. This is evidence to compare with browser capture, not proof that native capture fixes every blank page. Foreground capture only captures whichever application is already foreground: confirm that this target is authorized. Region capture uses the visible virtual desktop and includes whatever overlaps it; it does not reveal covered windows. Keep the captured region within the authorized task and avoid unrelated application content.

Coordinates are physical pixels with per-monitor DPI awareness, not CSS pixels or percentages. Desktop `x/y` can be negative on monitors left/above the primary monitor. Regions must fit the virtual desktop; monitor gaps may contain no display content. Native client rectangles start at their client origin; they are not desktop coordinates. Browser `rect` captures keep their separate CSS/unit contract in [Screenshots](screenshots.md).

## Raw WinAPI

Search or inspect unfamiliar functions before calling them. The catalog searches Microsoft Learn, requires an exact function name/signature and identifies its Windows system DLL; raw calls do not guess types or load arbitrary DLL paths. Each supplied `arguments` key must match a documented parameter, including explicit null values for optional parameters. Supported types are fixed-width Win32 scalars, pointer-sized integers/handles and input strings. Use decimal/hex strings for integers beyond JavaScript's safe integer range. Unicode uses the explicit W export; ANSI input currently supports ASCII only. Input/output pointers, structures, arrays and callbacks outside the convenience operations fail explicitly; use a saved Node/Koffi script with the actual Microsoft type definitions for those signatures.

After explicit user foreground permission, a saved raw-call request for one resolved browser HWND can contain:

```json
{
  "api": "SetForegroundWindow",
  "arguments": {"hWnd": "<resolved-browser-hwnd>"},
  "mode": "authorized_mutation",
  "allow_foreground": true
}
```

Replace the HWND with live evidence, and add `proxy_url` when required by the local network route. Documentation network calls use only the supplied HTTP(S) proxy, not implicit environment proxy selection. Native operations themselves need no network. `raw_call` returns `value`, `last_error`, signature and documentation URL; interpret success/failure according to that API. GetLastError is not universal success detection and some APIs do not set it. Mode and tool annotations never replace task authorization. Do not use WinAPI to click browser consent or bypass denied permissions.

Sources: [Koffi callbacks and calling conventions](https://koffi.dev/callbacks), [Koffi output parameters](https://koffi.dev/output), [PrintWindow and blocking behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow), [Physical DPI context](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext), [Process snapshots](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w), [SetForegroundWindow restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).
