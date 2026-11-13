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

## Jobs, WebSockets and reconnection

MCP stdio, CLI and importable clients submit requests to the shared loopback HTTP API. The service routes each request to the resolved extension through `/extension/ws` on the same port. Chromium's service worker and Firefox's persistent background connect directly; neither HTTP polling nor an offscreen worker executes transport. The service's `/probe` reports `extension_transport: websocket`, `extension_protocol: 2` and a process-specific `service_instance_id`. Profile inventory also reports the loaded `extension_version`.

An extension obtains the process secret from `GET /extension/bootstrap`, upgrades a WebSocket, then sends `hello` with protocol 2, the secret, its inventory and `accepted_job_ids`. The secret is in the authenticated message, never the URL. The service validates loopback Host, extension Origin when present, secret and protocol. `welcome` precedes `job` delivery. Application `ping`/`pong` exchanges occur every 20 seconds; 45 seconds without peer traffic ends an unhealthy connection. Retry starts with randomized 125–250ms delay and increases to at most 10 seconds. A Chrome alarm can wake a terminated worker; ordinary traffic keeps Chrome 116+ service workers alive.

`instance_id` identifies the extension execution context, not an individual socket. Replacing a socket in that same context preserves accepted work, Firefox subscriptions/handles and unacknowledged results. The receiver never waits for native execution. Chromium orders related operations by tab while allowing independent tabs and debugging status to proceed. Results are delivered after the job finishes and its updated inventory is published. Extension-side job-ID deduplication runs before execution; replaying a delivery within the same execution context cannot rerun that job. Retired execution contexts cannot replace the registered context with late inventory.

Completed results follow an updated inventory on the same ordered WebSocket. If another completion arrives while inventory is being collected, collect it again before flushing results. This keeps an immediately following request from rejecting a newly created tab or window against stale metadata. Chromium 1.1.1 and Firefox 1.2.1 include this ordering fix.

On reconnect, the service compares its dispatched IDs with the extension's accepted IDs. It sends only work that the same execution context has not accepted, using the same ID and original absolute deadline. If that deadline already expired and the same context confirms it never accepted the job, the service ends it as `expired_before_acceptance`, with `outcome_unknown: false`. Accepted operations are never automatically executed again. The extension resends completed results until `result_ack`; after a service restart the new service can import these unacknowledged results without restarting their browser operations. A browser/extension execution-context restart cannot recover an in-flight native Promise: pending work is reported as `EXTENSION_RESTARTED`, with unknown outcome for dispatched work. Confirmed results already held by a service remain queryable. Service records are process-local; a missing record after process loss never proves that an operation did not run.

`timeout_ms` sets an absolute execution deadline, including queue time. The HTTP service allows one additional second for the extension's deadline result; clients allow five seconds beyond the execution timeout for delivery. Expired jobs do not start browser actions. Cancellation fences subsequent work, including iframe and userscript helper commands; cleanup may still release resources on the original owned attachment. A late script-registration response triggers removal of that exact registration. An already-submitted browser call or page script cannot be undone by canceling the wait. Timeout does not detach a persistent debugger session used by recording or userscripts. An unfinished attach/close remains an explicit `DEBUGGER_RECOVERY_PENDING` state instead of an endless acquire wait; only confirmed native release permits a new attachment. `Debugger.enable` is sent only when the caller explicitly requests that CDP operation.

Each request has a UUID `job_id`. Node/Python clients generate it before submission and preserve it in errors even if the HTTP connection fails. Raw HTTP/CLI callers may supply their own UUID. A duplicate ID returns `JOB_ALREADY_EXISTS` and never creates another operation.

After a timeout, use MCP `browser_job_status`, Node/Python `job_status`, or CLI `job SELECTION.json` (`POST /job`). Repeat the exact original `profile_id`, `context`, optional `tab_id` and optional `window_id`, including originally omitted fields. This lookup works while the profile is disconnected. It returns `status`, last execution `phase`, `outcome_unknown`, `result_delivered`, and the retained `result` or service `error` when available. `completed` means a final result was received, so still inspect every per-item native status. A result marked `outcome_unknown` remains unknown after delivery.

```json
{"job_id":"00000000-0000-4000-8000-000000000000","profile_id":"resolved-profile-id","context":"private","tab_id":"chrome-tab:123","window_id":456}
```

Node/Python clients acknowledge a result only after parsing it. A query's `terminal` field also permits acknowledgement of a terminal service error, such as an unaccepted expired job or an extension-context restart. An HTTP wait timeout for still-dispatched work is not terminal and cannot be acknowledged. Every final result or terminal error includes a `receipt_id`; a late final result replaces a prior service-error receipt with a new one. `POST /job-ack` requires that received `receipt_id` plus the exact original selection. A mismatched receipt returns `JOB_RECEIPT_MISMATCH` and preserves the newer result; query it before another acknowledgement. A matching acknowledgement releases the received payload and script bodies, retaining a small completion/error receipt and unknown-outcome information to prevent reruns. Failed acknowledgement preserves the payload and never changes the browser operation's result. CLI/raw HTTP consumers copy the received `receipt_id` into their acknowledgement JSON and call `job-ack SELECTION.json` after saving their result or terminal error. No timer silently evicts unreceived results. A later lookup of an acknowledged result reports `result_delivered: true`; the receiving caller owns the full result. Logs contain job/profile IDs and native phases, without script bodies, page contents or the transport secret.

For recovery, inspect the job before inspecting the target and deciding on another authorized action. An online socket establishes transport health; the recorded execution phase distinguishes queued work from an unreturned native command. Do not prescribe an extension reload for a normal reconnect or a waiting native call. Version upgrades require matching service/extension versions once; see [Setup](setup.md#connection-recovery).

Iframe discovery retains ownership until its cleanup finishes. If a timed-out native cleanup has not returned, another discovery on that tab fails promptly with `FRAME_RECOVERY_PENDING`, rather than letting the old cleanup detach a newer job's child sessions. Confirmed root detach or tab removal clears that ownership; other tabs remain independent. Already-submitted native commands are still subject to the unknown-outcome rule above.

## DevTools and network observation

Use developer-tool evidence proactively when it helps explain the reported behavior. A screenshot shows the rendered state; DOM, computed styles, console exceptions and network events can explain its cause. Choose the relevant evidence for the symptom instead of repeatedly extracting the same page text. Keep all inspection on the resolved task profile/privacy/window/tab, in the background. The existing CDP interface provides developer-tool access without opening the visible DevTools UI.

For Chromium network observation, request the relevant exact `event_methods`, such as `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFailed` and `Network.loadingFinished`, and send `Network.enable` before the action being observed. Correlate events by request ID and, when present, child `session_id`; inspect URLs, HTTP status, timing and native failure details. Read a specific response body with `Network.getResponseBody` only when necessary and still available; preserve buffer/session errors rather than treating them as empty responses. An HTTP error response and a transport loading failure are different observations. Narrow results to task-related requests and avoid exposing credentials or unrelated payloads.

For console evidence, enable `Runtime` and collect `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`; `Log.enable` with `Log.entryAdded` can provide browser log entries. Inspect DOM geometry and computed styles for hidden, clipped or obstructed elements. Use the actual native errors and capabilities rather than assuming every browser supports Chromium methods. Firefox uses the advertised WebExtension/RDP APIs; do not silently substitute CDP or request extra permissions.

Event capture is **per request**, not a persistent subscription or a historical network log. The extension installs the requested event listener before executing the call's commands, collects during execution and optional `collect_events_ms`, then removes the listener before returning. `collect_events_ms` is milliseconds of additional collection after commands, within the request deadline; elapsed time alone does not prove application completion. Capture can be bounded/truncated, so an absent event does not prove that no request happened.

Chromium serializes operations on the same tab. To observe an authorized reproduction, put domain enable commands and its trigger in the **same CDP call**, followed by the needed collection interval. For example, send `Network.enable`, then an already-authorized `Runtime.evaluate` action or `Page.reload`, with the requested Network event methods. Starting a long collection call and queuing a separate click/reload on that tab would execute the action after collection ends. Coordinated capture and result filtering belong in a saved script importing the clients. Set mutation mode when the trigger changes the page, and honor the user's testing and reproduction authorization; observation guidance does not authorize reloads, submissions, request replay, cache changes or application writes by itself.

Sources: [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/), [CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/). Bridge event lifecycle and ordering are implemented in `extension/service-worker.js` and described above.

## Chromium debugging control

The extension settings checkbox only saves the profile-wide debugging preference. It succeeds even when no ordinary web page is open and does not select or attach an arbitrary tab. With the switch enabled, the next authorized page operation attaches to its resolved target automatically, including a page opened later. Switching off detaches owned sessions and blocks automatic attachment until debugging is explicitly enabled again.

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
