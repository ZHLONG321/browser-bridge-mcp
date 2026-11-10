# Operations

The CLI returns the complete JSON response. `profiles` enumerates connected extensions with browser/connection IDs, debugging/private-access state, and visible windows separated by `incognito`. `tabs <profile-id> <normal|private>` reads that explicit context; it does not select a default for later calls. `status` probes this service; `stop` requests its shutdown.

`find MATCH.json` calls `POST /find-tabs` to search live extension snapshots. The body is `{"match":{"context":"private","browser":"chromium"},"query":"example.com"}`. Every `match` entry must equal a reported scalar metadata field; all conditions apply together. `query` is a case-insensitive substring across reported metadata, including URL and title. Either part may be omitted. Results are `{"status":"completed","matches":[...]}`; each candidate carries its `profile_id`, live `connection_id`, `context`, `incognito`, `window_id`, `tab_id`, URL, title and remaining tab metadata. Multiple candidates remain separate. Unknown fields match nothing. Search does not inspect page bodies, mutate tabs or set a current profile. Only currently connected extensions and their reported windows/tabs are covered; independent RDP connections have no automatic profile/privacy association.

Every operation requires its own `profile_id` and `context`. Optional `window_id` constrains the anchor to the requested window and privacy context; a mismatch returns `WINDOW_MISMATCH`. The extension rechecks the live window before execution. `GET /tabs` also accepts `window_id` to filter the inventory. For "same window as this page", find the page first, then pass its `profile_id`, `context`, `window_id` and `tab_id`; Chromium `tab_control` open creates an inactive tab in that anchor's window. Firefox native arguments must use the corresponding native `windowId`; a window anchor does not sandbox arbitrary privileged functions.

`discover` lists extension and existing RDP connections, including browser family, protocol and live connection IDs. `discover REQUEST.json` can describe a selected Firefox namespace (explicit `connection_id`, `profile_id`, `context`, `namespace`) or connect/inspect native RDP. `rdp REQUEST.json` exchanges/polls raw native packets. See [Firefox](firefox.md) and [RDP](rdp.md) for these contracts. The service does not find installed browser executables or disconnected profiles.

For other operations, write UTF-8 JSON and call:

```bat
scripts\browser-bridge.bat request <profile-id> <normal|private> "<request.json>"
```

`profile_id` and `context` are mandatory query parameters on `/tabs` and `/request`; no implicit server selection exists. Profile IDs are stable extension-generated UUIDs. Chromium tab IDs are `chrome-tab:<integer>` and Firefox IDs are `firefox-tab:<profile-id>:<integer>`. The server rejects a supplied anchor tab belonging to the other privacy context. Native Firefox API arguments remain the caller's responsibility; an anchor cannot sandbox arbitrary native functions. The following table applies to Chromium only.

| `operation` | Request fields |
| --- | --- |
| `debugging` | `action: status / enable`; enable requires exact `tab_id` and `mode: authorized_mutation`; status accepts an optional tab. Both require explicit profile/context and honor optional `window_id`. Available even while the saved debugging switch is off. |
| `javascript` | `tab_id`, `scripts: ["return document.title;"]`, optional `frame_id` |
| `list_frames` | `tab_id` |
| `cdp` | `tab_id`, `commands: [{method, params, session_id?}]`; optional `event_methods`, `collect_events_ms` |
| `tab_control` | `tab_id` (target, or anchor for open), `action: open / navigate / reload / close / activate`, optional `url`; `activate` requires `allow_foreground: true` |
| `window_control` | `action: create / close`; create takes optional HTTP(S) `url` and needs no existing tab/window; close requires exact `window_id`. The call's `context` controls whether the window is normal or private. Creation uses native `windows.create` with `focused: false`; private control requires extension private access. |
| `userscript` | `tab_id`, `userscript_action: inject / list / list_commands / invoke_command / remove`; `script_id` except list; `userscript_source` for inject; `command_id` for invoke |

All requests support `mode: read_only / authorized_mutation` (default read_only), positive `timeout_ms` (default 30000), and `allow_foreground` (default false). Mutating tab/window/user-script operations require authorized_mutation; script execution and raw CDP remain capable of effects, so the caller must honor the user's authorization rather than treating the label as a sandbox. No automatic mutation retries occur. Window creation returns the actual `window_id`, `incognito`, `focused` and tab identifiers. Closing a focused window requires explicit foreground authorization; only close windows within the user's requested scope.

`focused: false` expresses the browser API's creation request, not a guarantee about Windows foreground events. For background-only window creation on Windows, follow the guarded helper requirements and startup limits in [Window operations](windows.md).

Example page query:

```json
{"operation":"javascript","tab_id":"chrome-tab:123","scripts":["return {title: document.title, href: location.href};"]}
```

Example background tab creation, anchored in the selected tab's window:

```json
{"operation":"tab_control","tab_id":"chrome-tab:123","action":"open","url":"https://example.com/","mode":"authorized_mutation"}
```

Results carry `job_id`, `tab_id`, per-item `results` with `status`, `frames`, and collected `events`. An item may fail even if HTTP succeeds; check every requested item. Existing extension result/event capture bounds may return `type: result_truncated` plus a preview; narrow the page query or retrieve the required content in parts instead of assuming the preview is complete. Chromium extension 1.0.5+ exempts `Page.captureScreenshot` image results from the ordinary text-result bound so image bytes arrive intact. Prefer the [file-producing screenshot helper/tools](screenshots.md) when taking screenshots; their successful response is only the verified filename.

Expected HTTP errors: 400 malformed request/unsupported operation, 403 forbidden origin, missing authorization/private permission or foreground operation, 404 profile/tab absent, 409 debugging disabled/context mismatch/extension restart, 504 deadline exceeded with `outcome_unknown` after dispatch. Connection loss is not an instruction to repeat a write.

## Chromium debugging control

Use the existing `/request?profile_id=...&context=...` route, Node/Python `debugging` client, or the CLI `request` command. `status` is read-only and may omit `tab_id` to inspect the requested context/window. `enable` requires an exact existing tab, validates its current privacy/window again in the extension, persists the profile-wide enabled preference, and attaches only that tab. It performs a read-only debugger command to confirm the connection, with no tab/window activation. It does not grant installation, site, enterprise-policy or private-window permissions.

```json
{"operation":"debugging","action":"enable","tab_id":"chrome-tab:123","window_id":456,"mode":"authorized_mutation"}
```

An item's `value` contains `enabled` (saved profile-wide preference), `attached` (at least one matching owned attachment), `attached_tab_ids` (matching Bridge tab IDs), `state` (`disabled`, `waiting`, `connected`), `profile_id`, `context`, and the supplied `window_id` if any. For an exact tab query, `attached` refers only to that tab. A successful enable item has `status: exited` and `attached: true`; connection failures are failed items with the original debugger error. Explicit API enable saves the preference independently of that target's attachment outcome; a failed connection must not be reported as connected or disable other authorized sessions. Query status to distinguish the enabled preference from a failed target. Target enables can run concurrently; manual controls or browser-banner cancellation supersede pending enables and stop reconnection.

Reissuing explicit enable for an already connected target reuses its attachment. After a dispatched timeout, query status before deciding whether enabling is still needed; do not replay the page mutation. Normal page operations establish their own attachment while the preference is enabled. The UI checks actual tracked sessions against `chrome.debugger.getTargets()` and separately shows disabled, enabled/waiting and connected counts. Browser restart can legitimately leave the preference enabled with no session. A worker that lost its attachment map may adopt its own surviving attachment only after a debugger command proves ownership; another debugger's attachment is never treated as this extension's session.

Update both server and Chromium extension (version 1.0.3+) before using this operation. Restart the service and reload the unpacked extension. It is not a Firefox `webextension` native-control switch. Sources: [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger), [extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

Firefox adds 409 for a stale/mismatched live connection, 403 for a new RDP connection without explicit prompt permission, and 502 with `outcome_unknown` after an interrupted RDP send. WebExtension native errors are per-result `status: failed`/`error`; RDP actor errors remain unchanged inside packets. Inspect both transport and native result.

## Local HTTP boundary

The service binds only `127.0.0.1`. CLI/SDK requests use `X-Browser-Bridge-Client: 1`, with no browser Origin. This prevents ordinary web pages from issuing those requests through cross-origin fetch; it is not authentication against other programs on the user's machine. Extension transport uses a per-process secret obtained through its loopback bootstrap. No cookies or login credentials are copied to the server configuration.
