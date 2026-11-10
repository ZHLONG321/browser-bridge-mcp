# MCP installation and tools

Browser Bridge provides a local stdio MCP server implemented with the official TypeScript SDK. The AI client launches it as a child process and discovers its tools. The MCP layer calls the same Node.js client and guarded Windows helpers as the CLI; extensions continue connecting to the local HTTP service.

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

1. Call `bridge_status` to inspect the service. If no listener exists, call `bridge_start_service`. It starts the bundled Node service without a console window or reuses a compatible existing Bridge. It never replaces another listener, launches a browser or grants extension permissions. Startup errors include the launcher output/log when available; inspect uncertain startup before trying again.
2. Load the appropriate browser extension and grant the permissions described in [Setup](setup.md). Compute its absolute picker path from this installed skill. First-time extension loading and private-window permission remain user actions.
3. Call `browser_profiles`, `browser_discover` or `browser_find_tabs` to resolve the task's target. Pass profile, privacy and relevant window constraints on each operation. There is no current profile or client-bound browser.

The HTTP service is shared with other MCP clients, the CLI and extensions. It continues running when an MCP client exits. Stop it only through the existing service shutdown operation when authorized; MCP disconnect does not stop a service another client may be using. Startup logs use the HTTP launcher's existing session log path, returned by `bridge_start_service`.

By default both layers use `http://127.0.0.1:30003`. For a different existing Bridge address, set `BROWSER_BRIDGE_URL` in the MCP server's environment, and use the matching URL in extension options. Only loopback HTTP URLs are accepted. This is the extension service address, not an MCP HTTP endpoint. `bridge_start_service` uses its configured port when it needs to launch a service.

## Tools

| Tools | Purpose |
| --- | --- |
| `bridge_status`, `bridge_start_service` | Inspect or explicitly start/reuse the HTTP service |
| `browser_profiles`, `browser_discover` | Inventory extension profiles, live connections and Firefox native capabilities |
| `browser_find_tabs`, `browser_tabs` | Reverse lookup target metadata or list one explicit profile/privacy/window |
| `browser_javascript`, `browser_list_frames`, `browser_cdp` | Chromium page execution, frame discovery and native CDP |
| `browser_tab_control`, `browser_window_control` | Chromium tab/window operations; Windows background creation uses the guarded tools below |
| `browser_debugging`, `browser_userscript` | Chromium debugging status/authorized enable and userscripts |
| `browser_webextension`, `browser_rdp` | Firefox native APIs, events, handles and accepted RDP connections |
| `browser_edge_defaults` | Read Windows Edge's current installation/startup profile selection |
| `browser_create_edge_window` | Guarded background Edge creation, including complete browser exit |
| `browser_create_firefox_window` | Guarded background Firefox creation using an existing live native window |

Request fields retain the [operation contracts](operations.md). RDP deliberately has no automatic extension profile/privacy association; establish it from native metadata as described in [RDP](rdp.md). For guarded Windows tools, prepare the dependencies and native DLLs in [Windows operations](windows.md); exposing a tool does not remove those prerequisites.

Results include the complete Bridge JSON in both text and `structuredContent`. Service errors and failed Bridge items set `isError`; original error details, job IDs and `outcome_unknown` are preserved when supplied. Inspect nested native API/actor results as well: a delivered packet is not proof its operation succeeded. Timeouts, cancellation and lost responses never authorize automatic mutation replay. MCP tool annotations describe intent; they do not sandbox JavaScript, CDP, privileged Firefox functions or raw packets.

Sources: [Official MCP SDK and stdio setup](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The Codex command above follows `codex mcp add --help`; other clients use their own MCP configuration format.
