# Code composition

Coordinated calls, programmatic request construction and request/result processing must run in a saved `.mjs` or `.py` script that imports these clients directly. Do not orchestrate the workflow through MCP tools or CLI commands, including from inside a script. Save the script under the owning project's `tmp/<current session id>/`, then invoke the file. Never embed JavaScript/Python in shell commands with eval flags, here-documents/here-strings, or interpreter stdin. The examples below are script-file contents.

Run a saved file using the appropriate runner:

```sh
node tmp/<session-id>/browser-task.mjs
uv run python tmp/<session-id>/browser-task.py
```

Use the active environment's required Python runner when it differs. Resolve the installed client import path before writing the script.

Import clients by their installed paths. They use standard libraries and never start the service implicitly. Each call supplies its own `profile_id` and `context: normal / private`; include `window_id` when the user specifies a window. There is no bound client or current/default profile. Calls targeting different browsers can run concurrently.

Client and server runtimes are independent. Either server accepts both clients and the BAT/curl CLI; use an available runtime without installing another. On Windows, dynamic Node imports use `pathToFileURL` to turn a local path into a module URL.

## Node.js

```js
import {profiles, find_tabs, javascript} from '<skill>/scripts/node/client.mjs';

console.log(await profiles());
const found = await find_tabs({match: {context: 'private'}, query: 'example.com'});
if (found.matches.length !== 1) throw new Error('Refine the search or show candidates to the user.');
const target = found.matches[0];
console.log(await javascript({
  profile_id: target.profile_id, context: target.context,
  window_id: target.window_id, tab_id: target.tab_id,
  scripts: ['return {title: document.title, href: location.href};']
}));
```

Use ordinary JavaScript and `Promise.all` for independent operations. Every function takes an options object with snake_case browser fields. The optional `service_url` defaults to `BROWSER_BRIDGE_URL` or `http://127.0.0.1:30003`. The `url` field in a browser operation remains the page URL, including tab creation/navigation.

The Node client also exports `screenshot`. In a saved script, pass the already-resolved target and the active caller session ID:

```js
import {screenshot} from '<skill>/scripts/node/client.mjs';
import {screenshotDirectory} from '<skill>/scripts/node/screenshots.mjs';
import {join} from 'node:path';

const filename = await screenshot({
  ...resolvedTarget, session_id: callerSessionId, scope: 'rect',
  rect: {x: 0, y: 0, width: 50, height: 100, reference: 'viewport', unit: 'percent'},
  padding: 16,
});
console.log(filename);
// For a later local image-viewing call:
const imagePath = join(screenshotDirectory(callerSessionId), filename);
```

Resolve `resolvedTarget` and `callerSessionId` before this call; Firefox requires its live `connection_id` too. The helper verifies a complete nonempty file before returning its filename. Encoding preserves native dimensions; saved byte sizes go to stderr. See [Screenshots](screenshots.md) for full-page, viewport and element scopes, format compatibility and AI-controlled scrolling. Python retains its native CDP/WebExtension calls; this file-producing helper is a Node export.

## Python

Add `<skill>/scripts/python` to `sys.path`, then:

```python
from browser_bridge import find_tabs, javascript, profiles

print(profiles())
found = find_tabs(match={"incognito": True}, query="example.com")
if len(found["matches"]) != 1:
    raise RuntimeError("Refine the search or show candidates to the user.")
target = found["matches"][0]
print(javascript(
    profile_id=target["profile_id"], context=target["context"],
    window_id=target["window_id"], tab_id=target["tab_id"],
    scripts=["return document.title;"],
))
```

Use ordinary Python composition and standard executors for independent calls. Follow the active environment's Python runner rules.

Both modules expose `profiles`, `discover`, `find_tabs`, `tabs`, `request`, `javascript`, `list_frames`, `cdp`, `tab_control`, `userscript`, `webextension` and `rdp`. Python operations take keyword fields; Node operations take one object. Generic requests are `request(operation, payload, profile_id=..., context=...)` in Python and `request(operation, {profile_id, context, ...payload})` in Node. `tabs` requires `profile_id` and `context` and accepts `window_id`. Print only results relevant to the task.

## Find a target from incomplete information

`find_tabs(match={...}, query="...")` in Python and `find_tabs({match: {...}, query: '...'})` in Node read current extension snapshots. Exact scalar `match` fields combine with a case-insensitive substring `query`. Match URL, title, browser, privacy context, window ID, tab ID or other reported metadata. Returned candidates include their routing identifiers. Multiple matches stay separate.

For vague descriptions, interpret live metadata against the user's intent, including aliases, partial wording, approximate names and purpose. The literal `query` parameter does not perform semantic matching. Broaden or omit it when it would hide plausible candidates; keep explicit profile/privacy/window constraints. If metadata cannot uniquely identify the target, show meaningful candidates and ask for the missing distinction. Do not inspect unrelated accounts or guess from array order. A workspace name alone does not establish a native window ID.

For "the same window as this page", find the anchor first, then pass its `profile_id`, `context`, `window_id` and `tab_id` to the operation. Chromium `tab_control` with `action: open` creates an inactive tab in that anchor's window.

## Chromium debugging

Once the requested browser is started and its extension has connected, reverse lookup all target conditions. For Edge on Windows, use the guarded startup helper in [Windows operations](windows.md); it returns the new window/tab and resolved profile IDs. Then explicitly enable debugging on an eligible HTTP(S) page, or query status first. Do not use an internal new-tab/settings page as the debugging target.

```js
import {debugging} from './scripts/node/client.mjs';

const result = await debugging({
  profile_id: '<resolved-profile-id>', context: 'private',
  window_id: 456, tab_id: 'chrome-tab:123',
  action: 'enable', mode: 'authorized_mutation',
});
const item = result.results?.[0];
if (item?.status !== 'exited' || item.value?.attached !== true) {
  throw new Error(item?.error || result.error || 'Debugging did not connect.');
}
```

Python exposes the same operation as `browser_bridge.debugging(profile_id=..., context='normal', tab_id=..., action='enable', mode='authorized_mutation')`. To query without changing the saved switch, use `action='status'` and omit mutation mode. The CLI uses a JSON request with `operation: debugging`; no extra runtime is needed. Saved `enabled` is profile-wide, while actual attachment results respect the explicit context, optional window and optional tab. No client saves a current selection. Inspect status after an interrupted enable before deciding whether another enable call is necessary.

## Firefox

Use `discover()` for live connection IDs and advertised capabilities. Every `webextension` call supplies its own current `connection_id`, `profile_id` and `context`. Include `window_id` when specified and use that same native `windowId` in native API arguments.

```python
from browser_bridge import discover, webextension

print(discover())
print(webextension(
    profile_id=profile_id, context="private", connection_id=connection_id,
    window_id=window_id, path="tabs.query", args=[{"windowId": window_id}],
))
```

Native RDP calls carry an explicit `connection_id` on every call. RDP has no automatic extension/profile/privacy association. A stale connection ID does not revive a prior native session. See [Operations](operations.md), [Firefox](firefox.md), [RDP](rdp.md) and [profile association](firefox-profiles.md) for the relevant contracts.


For Chromium windows, both clients also export `window_control`: pass `profile_id`, `context`, `action: create / close`, and `mode: authorized_mutation`. Creation needs no tab anchor; close requires the exact `window_id`. The browser's `focused: false` option alone does not guarantee no Windows activation.

Windows background creation uses separate Node helpers in `scripts/node/windows.mjs`. `create_firefox_window` takes explicit profile/context/connection, native HWND and bridge anchor window on every call. `create_edge_window` takes explicit executable, user-data directory, physical profile directory and context. It handles both an existing Edge process and a fully exited browser, opening a normally displayed normal/InPrivate window behind the foreground application. `edge_defaults()` performs read-only installation/startup-profile discovery; use that default only after reverse lookup of the user's conditions. The helpers release their native guards before returning and never save a current browser/profile selection. Raw Firefox `windows.create({focused: false})` can also activate transiently. See [Background windows](windows.md) for native components, architecture requirements and examples.
