# MCP installation and tools

Browser Bridge provides a local stdio MCP server implemented with the official TypeScript SDK. The AI client launches it as a child process and discovers its tools. The MCP layer calls the same Node.js client and guarded Windows helpers as the CLI. A separate shared service accepts local HTTP calls and routes them over authenticated extension WebSockets.

Use MCP for simple independent calls. Coordinated calls, programmatic request construction and request/result processing must use a saved script importing the [Node.js/Python clients](clients.md) directly. Do not orchestrate those workflows through MCP/CLI calls or embed JavaScript/Python in shell commands; save the script first, then invoke its file.

## Install from the repository URL

When the user asks to install from this repository, install the complete `skills/browser-bridge` directory into the active agent's supported skill directory. Keep `package.json`, `package-lock.json`, `scripts`, `references` and both extensions together. Resolve the installed directory and the actual Node.js executable yourself; the user does not need to supply a skill subdirectory or command.

MCP requires Node.js 20.9+ and npm. The independent Windows desktop commands use Koffi/sharp prebuilt native dependencies with no Python requirement. Keep npm optional dependencies enabled and do not omit them. The HTTP service and non-MCP clients can still use their documented runtimes independently. If Node.js/npm is unavailable, explain that prerequisite rather than silently downloading a runtime.

From the installed skill directory, install the locked MCP dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

Use the current agent/client's MCP registration interface to add a stdio server named `browser-bridge`. Configure the resolved Node.js executable as `command` and the installed `scripts/mcp/server.mjs` absolute path as its only argument. These must be real absolute paths computed on the destination machine, without relying on the client's working directory or leaving placeholders in its settings. Preserve unrelated MCP entries and user changes. If the current client has no MCP support or its configuration is inaccessible, say which installation step could not be completed.

For Codex, the registration command is:

```sh
codex mcp add browser-bridge -- "<resolved-node-executable>" "<installed-skill>/scripts/mcp/server.mjs"
```

For clients using an `mcpServers` JSON configuration, the equivalent entry is:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "<resolved-node-executable>",
      "args": ["<installed-skill>/scripts/mcp/server.mjs"]
    }
  }
}
```

Resolve both placeholders before writing settings. On Windows, use JSON escaping or forward slashes for computed paths. Use the client's documented reload/reconnect procedure so it discovers the server. Do not run the MCP entry through `npm start`, a shell wrapper or an HTTP URL: stdio stdout carries protocol messages only. Human-readable startup messages go to stderr. No registry publication, API key or remote MCP endpoint is needed for this checkout-based installation.

## Connect the HTTP service and browser

1. Call `bridge_service_status` to inspect the service. If no listener exists, call `bridge_service_start`. It starts the bundled Node service without a console window or reuses a compatible existing Bridge. It never replaces another listener, launches a browser or grants extension permissions. Startup errors include the launcher output/log when available; inspect uncertain startup before trying again.
2. Check the extension and required permissions for the task-required profile under [Task-required profile setup](setup.md#task-required-profile-setup). Ask for loading only if needed there; other profiles need no installation. Compute its absolute picker path from this installed skill. First-time extension loading and private-window permission remain user actions.
3. Call `browser_profile_list`, `browser_connection_list` or `browser_tab_find` to resolve the task's target. Pass profile, privacy and relevant window constraints on each operation. There is no current profile or client-bound browser.

The HTTP service is shared with other MCP clients, the CLI and extensions. It continues running when an MCP client exits. Stop it only through the existing service shutdown operation when authorized; MCP disconnect does not stop a service another client may be using. Startup logs use the HTTP launcher's existing session log path, returned by `bridge_service_start`.

By default both layers use `http://127.0.0.1:30003`. For a different existing Bridge address, set `BROWSER_BRIDGE_URL` in the MCP server's environment, and use the matching URL in extension options. Only loopback HTTP URLs are accepted. This is the extension service address, not an MCP HTTP endpoint. `bridge_service_start` uses its configured port when it needs to launch a service.

## Tools

MCP tool API 2.4 exposes 62 tools named by resource and action, including 15 independent `windows_*` commands. Reconnect the MCP client after updating the installed skill to discover the tool list. Service and extension prerequisites are maintained in [Setup](setup.md#connection-recovery). Existing CLI commands, importable client functions and HTTP actions keep their names.

On non-Windows systems, Windows tools and guarded Windows helpers return `WINDOWS_UNAVAILABLE` with the actual platform. They do not start native workers or suggest extension reloads; ordinary browser tools are unaffected. MCP implementation version 2.4.2 retains this platform handling and packages the independent Python Windows implementation alongside Node.

Each fixed action has its own input schema. Do not send `action` or `userscript_action`: the adapter supplies the fixed HTTP action. Only action-relevant fields are accepted. Chromium tab/window changes, debugging enable and userscript changes require `mode: authorized_mutation`; foreground tab activation also requires `allow_foreground: true`. Arbitrary JavaScript, CDP and Firefox APIs/packets remain native capabilities whose effects must respect task authorization.

| Tools | Purpose |
| --- | --- |
| `bridge_service_status`, `bridge_service_start` | Inspect or explicitly start/reuse the HTTP service |
| `browser_profile_list`, `browser_connection_list` | List extension profiles or existing extension/RDP connections |
| `browser_tab_find`, `browser_tab_list` | Reverse lookup target metadata or list one explicit profile/privacy/window |
| `browser_job_status` | Inspect an uncertain job by ID and its exact original selection without rerunning it |
| `browser_screenshot_full_page`, `browser_screenshot_viewport` | Capture the full top document or current viewport to a compressed image file |
| `browser_screenshot_element`, `browser_screenshot_rect` | Capture caller-resolved element bounds or an explicit rectangle, with optional padding |
| `browser_recording_start`, `browser_recording_status` | Start native background video recording or inspect one explicit job and its notification state |
| `browser_recording_stop`, `browser_recording_result` | Request stop/save, then retrieve only the completed video's verified filename |
| `chromium_javascript_execute`, `chromium_frame_list`, `chromium_cdp_execute` | Chromium page execution, frame discovery and native CDP |
| `chromium_tab_open` | Open an inactive tab in the existing anchor `tab_id`'s window; requires `url` |
| `chromium_tab_navigate` | Navigate the resolved `tab_id`; requires `url` |
| `chromium_tab_reload`, `chromium_tab_close`, `chromium_tab_activate` | Reload, close or explicitly activate the resolved tab |
| `chromium_window_create`, `chromium_window_close` | Native create/close; close requires `window_id`. Windows background creation uses the guarded tools below |
| `chromium_debugging_status`, `chromium_debugging_enable` | Read saved/actual debugging state or enable debugging on an exact authorized tab |
| `chromium_userscript_inject` | Inject a temporary userscript; requires `script_id` and `userscript_source` |
| `chromium_userscript_list`, `chromium_userscript_commands_list` | List temporary scripts or one script's commands; commands require `script_id` |
| `chromium_userscript_command_invoke`, `chromium_userscript_remove` | Invoke a command (`script_id`, `command_id`) or remove one script (`script_id`) |
| `firefox_api_call`, `firefox_api_describe` | Call a native WebExtension method or describe a namespace/handles; call requires `path`, with optional positional `args` |
| `firefox_api_event_subscribe`, `firefox_api_event_unsubscribe` | Register an event `path` with optional `args`, or remove its exact `subscription_id` |
| `firefox_api_events_read`, `firefox_api_handle_release` | Read events after a cursor or release a native `path: handles.<id>` |
| `firefox_rdp_connect`, `firefox_rdp_discover` | Connect/reuse a loopback `rdp_port`, or inspect an existing `connection_id`/actor/scope |
| `firefox_rdp_exchange`, `firefox_rdp_packets_read`, `firefox_rdp_disconnect` | Send native packets/bulk, read retained packets without sending, or disconnect an existing connection |
| `edge_startup_profile_get` | Read Windows Edge's installation, registered physical profile names and current startup selection; this does not establish running windows |
| `edge_profile_extension_status` | Read saved extension registration for one task-required Windows Edge physical profile and explicit privacy context; no launch, installation or live-connection claim |
| `edge_window_create_background` | Guarded background Edge creation, including complete browser exit |
| `firefox_window_create_background` | Guarded background Firefox creation using an existing live native window |
| `windows_list_windows`, `windows_find_windows`, `windows_get_window` | Discover native HWNDs/titles/processes and inspect one actual window |
| `windows_get_foreground_window`, `windows_get_window_rect`, `windows_get_client_rect` | Inspect the existing foreground window or physical-pixel native bounds without focus changes |
| `windows_get_window_process`, `windows_list_processes`, `windows_get_process` | Resolve HWND ownership or inspect live Windows processes |
| `windows_capture_window`, `windows_capture_foreground`, `windows_capture_region` | Native PrintWindow/visible-desktop capture to compressed, verified screenshot files |
| `windows_search_api`, `windows_describe_api`, `windows_raw_call` | Find Microsoft documentation, inspect exact signatures and invoke the supported raw WinAPI subset |

Request fields retain the [operation contracts](operations.md), with fixed actions and their required fields expressed in each MCP schema. Firefox API tools require explicit profile/context and live extension `connection_id` each time. RDP deliberately has no automatic extension profile/privacy association; establish it from native metadata as described in [RDP](rdp.md). For guarded Windows tools, prepare the dependencies and native DLLs in [Windows operations](windows.md); exposing a tool does not remove those prerequisites. Close task-created temporary pages as soon as they are no longer needed unless the user explicitly authorizes keeping them open.

Browser operation results include the complete Bridge JSON in both text and `structuredContent`. Successful screenshot tools and completed `browser_recording_result` calls return only the saved filename as text, after verifying that its complete nonempty file exists. Pass the caller's `session_id` and reconstruct its session media directory; see [Screenshots](screenshots.md) for image coordinates/encoding and [Recording](recording.md) for background jobs, video files and optional Codex notification. Recording start/status/stop calls return job state; an unfinished result call returns that state rather than a filename. Service errors and failed Bridge items set `isError`; original error details, job IDs and `outcome_unknown` are preserved when supplied. Inspect nested native API/actor results as well: a delivered packet is not proof its operation succeeded. Timeouts, cancellation and lost responses never authorize automatic mutation replay. MCP tool annotations describe intent; they do not sandbox JavaScript, CDP, privileged Firefox functions or raw packets.

MCP Windows tools use Node; the skill also ships the same 15 operations as an independent Python library and `windows-python` CLI, with no Node dependency. Windows desktop tools are independent of the HTTP service and extension: use them to diagnose/continue authorized work when browser calls fail. See [Windows desktop commands](windows-desktop.md) for exact schemas, capture files, worker timeouts, process-local handle lifetime and the browser-related authorization boundary. Windows captures also return only verified filenames. Native calls may require foreground permission; background operation remains the default without repeated announcements to the user. Updating these Node/MCP files requires MCP reconnect, not extension reload or shared-service restart.

Sources: [Official MCP SDK and stdio setup](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The Codex command above follows `codex mcp add --help`; other clients use their own MCP configuration format.
