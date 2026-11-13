# Windows desktop commands

On non-Windows systems, both implementations immediately report `WINDOWS_UNAVAILABLE` with `details.platform` for all 15 operations, including documentation search/description. They do not start a worker, load Win32 libraries, create screenshot files or make documentation requests. MCP returns an error result, CLI prints the structured error and exits nonzero, and direct Node/Python functions raise an error with the same code/details. Guarded Windows browser helpers use the same platform error. This does not disable the other browser tools.

Use these commands when browser calls fail or Windows evidence is needed to continue the authorized browser task. The skill ships two independent implementations of the same 15 operations. Neither invokes the other or needs BO, another skill, the Bridge service or an extension. MCP uses Node; choose either implementation for CLI or saved scripts according to the prepared runtime. Do not switch implementations to replay a mutation with an unknown outcome.

| Implementation | Requirements | CLI | Saved-script import |
| --- | --- | --- | --- |
| Node | Node.js 20.9+, locked Koffi/sharp npm dependencies | `scripts/browser-bridge.bat windows <operation>` | `scripts/node/desktop.mjs` |
| Python | uv, Python 3.12+, pinned `scripts/python/windows-requirements.txt` | `scripts/browser-bridge.bat windows-python <operation>` | `browser_bridge_windows` from `scripts/python` |

Prepare Node as described in [MCP installation](mcp.md). Koffi and sharp use platform-specific prebuilt optional npm packages; do not omit optional dependencies. Supported binary combinations follow [Koffi](https://koffi.dev/) and [sharp](https://sharp.pixelplumbing.com/install/). Python uses stdlib ctypes for Win32, Pillow for encoding, and httpx/Pydantic for the documentation catalog. Prepare it explicitly from the skill directory:

```sh
uv run --no-project --python ">=3.12" --with-requirements scripts/python/windows-requirements.txt python --version
```

The Python BAT uses `--offline` and never downloads dependencies or a runtime while operating a browser. If the selected implementation is missing prerequisites, stop with preparation instructions; do not silently install compilers or switch runtimes after dispatching a mutation. [Pillow's Windows installation documentation](https://pillow.readthedocs.io/en/stable/installation/basic-installation.html) describes supported wheels.

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
scripts\browser-bridge.bat windows-python list-windows
scripts\browser-bridge.bat windows-python capture-window --hwnd <resolved-hwnd> --session-id <caller-session-id>
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

For Python, save a `.py` file, resolve the installed skill path, and add its `scripts/python` directory to `sys.path` before importing. For example, with `skill_root` already resolved:

```python
import sys

sys.path.insert(0, str(skill_root / "scripts" / "python"))
import browser_bridge_windows as desktop

candidates = desktop.find_windows("Edge", match="contains")
if len(candidates) != 1:
    raise ValueError("Resolve the target HWND from the task conditions before acting.")
print(desktop.get_window_process(candidates[0]["hwnd"]))
```

Run the saved file through `uv run --offline --no-project --python ">=3.12" --with-requirements <installed-skill>/scripts/python/windows-requirements.txt python -B <script.py>`. Python exposes the operation names in the table below as synchronous functions: target/query arguments may be positional, other fields are keyword arguments. `desktop.call("get_window", hwnd=resolved_hwnd)` provides named dispatch without keeping a current target. The direct Python CLI is `uv run --offline --no-project --python ">=3.12" --with-requirements scripts/python/windows-requirements.txt python -B scripts/python/browser_bridge_windows_cli.py <operation> ...`.

Node MCP/CLI window and foreground captures reuse one hidden, isolated PrintWindow worker per caller process. Requests run serially, keeping Koffi/Sharp loaded between captures without continuous background sampling. Other Node operations and all Python CLI operations retain per-call workers. `timeout_ms` defaults to 30000 and starts when the queued operation begins executing. A timeout terminates only that worker and fails the request without replay; a later independent capture creates a new worker. The reusable worker exits with its parent and does not keep a completed CLI alive. A raw call may already have changed state, so inspect before repeating it. A timed-out capture may leave a partial file and never returns its filename. Direct Node/Python functions execute in the caller process and can block on native calls. To isolate a Node operation from a script, import `windows_call(operation, options)` from `scripts/node/windows-runner.mjs`.

HWNDs/PIDs can identify targets across calls. Handles returned by OpenProcess, GDI allocations and similar APIs are **local to their owning process**. They cannot be passed from one MCP/CLI worker to another, or between the Python and Node processes. Compose such operations in one saved script importing `desktop.mjs` or `browser_bridge_windows`, and release acquired handles/resources in `finally`. Do not return a process-local handle from an isolated worker expecting it to remain usable.

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

MCP list results use `{items: [...]}`; no-foreground uses `{window: null}`. Direct Node/CLI functions return arrays/null directly; Python returns lists/None. Both implementations use the same fields, physical-pixel coordinates, capture policy and supported raw-signature subset; image encoder output bytes need not be identical. Executable paths that cannot be read remain `path: null` with `path_error`; access denial does not mean the process is absent. No command silently launches/stops a process as inspection or repairs a browser by clearing data.

## Captures and coordinates

All captures require the active caller's `session_id`. Optional `format` is `webp` (default) or `jpeg`; `quality` is 1–100, default 100 for WebP and 90 for JPEG. Confirm client compatibility or select JPEG explicitly. Encode once, preserve captured dimensions, and impose no file-size cap or automatic quality reduction. Store under `%TMP%/codex-<session_id>-browser-bridge/screen/`, returning only a filename after the complete nonempty write is closed and checked. Node/MCP captures additionally accept `return_image: true`: Node returns `{filename, image}`, and MCP returns filename text plus native image content from the same saved bytes, avoiding a separate image-viewing call. False/omitted preserves filename-only behavior. Python retains its filename-only contract. Saved dimensions/byte count go to stderr.

Prefer the smallest necessary rectangle with enough context, avoiding unrelated pixels and image tokens. Node/MCP `capture_window` and `capture_foreground` accept optional `rect: {x, y, width, height}` in physical pixels relative to the captured window's top-left **including its frame**. The rectangle must fit inside that window; the PrintWindow bitmap is cropped before encoding/saving/returning, with no scaling. `capture_region` continues to use desktop-absolute `x/y/width/height`, including negative monitor coordinates. Python window captures retain whole-window behavior. `browser_action_screenshot` reuses these Node/MCP captures after the browser action and delay; see [capture selection](screenshots.md#action-followed-by-delayed-capture).

Window capture uses PrintWindow to capture the window's own contents, including when another window covers it, without activating/restoring it. This is the selected backend for on-demand window interaction; there is no automatic WGC fallback. Minimized targets fail; hardware-accelerated, protected or native PDF content may be blank even when PrintWindow succeeds. This is evidence to compare with browser capture, not proof that native capture fixes every blank page. Node window WebP encoding uses Sharp `effort: 0` to favor lower CPU and latency; this can produce larger files while preserving the requested quality parameter and full pixel dimensions. JPEG, desktop-region and independent Python encoding retain their existing policies. Foreground capture only captures whichever application is already foreground: confirm that this target is authorized. Region capture uses the visible virtual desktop and includes whatever overlaps it; it does not reveal covered windows. Keep the captured region within the authorized task and avoid unrelated application content.

Coordinates are physical pixels with per-monitor DPI awareness, not CSS pixels or percentages. Desktop `x/y` can be negative on monitors left/above the primary monitor. Regions must fit the virtual desktop; monitor gaps may contain no display content. Native client rectangles start at their client origin; they are not desktop coordinates. Browser `rect` captures keep their separate CSS/unit contract in [Screenshots](screenshots.md).

## Raw WinAPI

Search or inspect unfamiliar functions before calling them. The catalog searches Microsoft Learn, requires an exact function name/signature and identifies its Windows system DLL; raw calls do not guess types or load arbitrary DLL paths. Each supplied `arguments` key must match a documented parameter, including explicit null values for optional parameters. Supported types are fixed-width Win32 scalars, pointer-sized integers/handles and input strings. Use decimal/hex strings for integers beyond JavaScript's safe integer range. Unicode uses the explicit W export; ANSI input currently supports ASCII only. Input/output pointers, structures, arrays and callbacks outside the convenience operations fail explicitly; use a saved Node/Koffi or Python/ctypes script with the actual Microsoft type definitions for those signatures.

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

Sources: [ctypes calling conventions and type declarations](https://docs.python.org/3/library/ctypes.html), [Pillow encoding options](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html), [Koffi callbacks and calling conventions](https://koffi.dev/callbacks), [Koffi output parameters](https://koffi.dev/output), [PrintWindow and blocking behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow), [Physical DPI context](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext), [Process snapshots](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w), [SetForegroundWindow restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).
