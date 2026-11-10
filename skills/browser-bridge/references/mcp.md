# MCP installation and tools

Browser Bridge provides a local stdio MCP server implemented with the official TypeScript SDK. The AI client launches it as a child process and discovers its tools. The MCP layer calls the same Node.js client and guarded Windows helpers as the CLI; extensions continue connecting to the local HTTP service.

Use MCP for simple independent calls. Coordinated calls, programmatic request construction and request/result processing must use a saved script importing the [Node.js/Python clients](clients.md) directly. Do not orchestrate those workflows through MCP/CLI calls or embed JavaScript/Python in shell commands; save the script first, then invoke its file.

## Install from the repository URL

When the user asks to install from this repository, install the complete `skills/browser-bridge` directory into the active agent's supported skill directory. Keep `package.json`, `package-lock.json`, `scripts`, `references` and both extensions together. Resolve the installed directory and the actual Node.js executable yourself; the user does not need to supply a skill subdirectory or command.

MCP requires Node.js 20+ and npm. The HTTP service and non-MCP clients can still use their documented runtimes independently. If Node.js/npm is unavailable, explain that prerequisite rather than silently downloading a runtime.

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
2. Load the appropriate browser extension and grant the permissions described in [Setup](setup.md). Compute its absolute picker path from this installed skill. First-time extension loading and private-window permission remain user actions.
3. Call `browser_profile_list`, `browser_connection_list` or `browser_tab_find` to resolve the task's target. Pass profile, privacy and relevant window constraints on each operation. There is no current profile or client-bound browser.

The HTTP service is shared with other MCP clients, the CLI and extensions. It continues running when an MCP client exits. Stop it only through the existing service shutdown operation when authorized; MCP disconnect does not stop a service another client may be using. Startup logs use the HTTP launcher's existing session log path, returned by `bridge_service_start`.

By default both layers use `http://127.0.0.1:30003`. For a different existing Bridge address, set `BROWSER_BRIDGE_URL` in the MCP server's environment, and use the matching URL in extension options. Only loopback HTTP URLs are accepted. This is the extension service address, not an MCP HTTP endpoint. `bridge_service_start` uses its configured port when it needs to launch a service.

## Tools

MCP tool API 2.0 exposes 37 tools named by resource and action. It replaces the previous names and combined action tools. Reconnect the MCP client after updating the installed skill to discover the new tool list; no extension reload or HTTP service restart is needed for this change. Existing CLI commands, importable client functions and HTTP actions keep their names.

Each fixed action has its own input schema. Do not send `action` or `userscript_action`: the adapter supplies the fixed HTTP action. Only action-relevant fields are accepted. Chromium tab/window changes, debugging enable and userscript changes require `mode: authorized_mutation`; foreground tab activation also requires `allow_foreground: true`. Arbitrary JavaScript, CDP and Firefox APIs/packets remain native capabilities whose effects must respect task authorization.

| Tools | Purpose |
| --- | --- |
| `bridge_service_status`, `bridge_service_start` | Inspect or explicitly start/reuse the HTTP service |
| `browser_profile_list`, `browser_connection_list` | List extension profiles or existing extension/RDP connections |
| `browser_tab_find`, `browser_tab_list` | Reverse lookup target metadata or list one explicit profile/privacy/window |
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
| `edge_startup_profile_get` | Read Windows Edge's current installation/startup profile selection |
| `edge_window_create_background` | Guarded background Edge creation, including complete browser exit |
| `firefox_window_create_background` | Guarded background Firefox creation using an existing live native window |

Request fields retain the [operation contracts](operations.md), with fixed actions and their required fields expressed in each MCP schema. Firefox API tools require explicit profile/context and live extension `connection_id` each time. RDP deliberately has no automatic extension profile/privacy association; establish it from native metadata as described in [RDP](rdp.md). For guarded Windows tools, prepare the dependencies and native DLLs in [Windows operations](windows.md); exposing a tool does not remove those prerequisites. Close task-created temporary pages as soon as they are no longer needed unless the user explicitly authorizes keeping them open.

Results include the complete Bridge JSON in both text and `structuredContent`. Service errors and failed Bridge items set `isError`; original error details, job IDs and `outcome_unknown` are preserved when supplied. Inspect nested native API/actor results as well: a delivered packet is not proof its operation succeeded. Timeouts, cancellation and lost responses never authorize automatic mutation replay. MCP tool annotations describe intent; they do not sandbox JavaScript, CDP, privileged Firefox functions or raw packets.

Sources: [Official MCP SDK and stdio setup](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The Codex command above follows `codex mcp add --help`; other clients use their own MCP configuration format.
