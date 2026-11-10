# Setup and connection

For MCP installation, dependencies and client registration, read [MCP installation and tools](mcp.md). MCP needs Node.js 20+/npm and exposes tools over stdio. Its explicit `bridge_start_service` tool starts or reuses the same HTTP service described below; it does not load extensions or grant browser permissions. The standard-library runtime instructions below apply to the HTTP service and standalone clients, independently of MCP dependencies.

## Runtime and server

The Windows server launcher checks Node.js for built-in `fetch`, `util.parseArgs` and `AbortSignal.timeout`, then Python 3.10+, then the Windows `py -3` launcher. It uses only their standard libraries. It does not run package installers or download anything. Install a current LTS runtime yourself from [Node.js](https://nodejs.org/en/download) or [Python](https://www.python.org/downloads/windows/), or provide a portable runtime and make its executable discoverable on PATH. Reopen the terminal after changing PATH.

```bat
scripts\browser-bridge-server.bat --session <session-id> --port 30003
scripts\browser-bridge.bat status
scripts\browser-bridge.bat stop
```

`--session` is required. Logs go to `%TMP%/<session-id>/browser bridge/server.log`; the launcher reports its path and whether the service started. A server already occupying the requested port is reported, never killed or silently replaced. `stop` requests shutdown of the Bridge at the configured URL; use only for the service you intend to stop. There is no cwd initialization.

The client BAT requires curl with `--fail-with-body` support (7.76+). Windows 10/11 generally supplies curl. If unavailable, tell the user to install/update it from [curl for Windows](https://curl.se/windows/) and expose `curl.exe` on PATH. Do not bundle executables or download them automatically.

## Extension

Chrome/Edge use `extension/`; Firefox uses `extension-firefox/`. Both connect to either server runtime through the same loopback HTTP service. Neither discovers browser executable paths or starts a browser. Copy the whole skill directory to another computer, install an available runtime/curl as needed, then load the appropriate extension in each intended profile; no workstation path is embedded in the package.

1. Resolve this skill's `extension/` directory to an existing absolute path first. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose **Load unpacked** using that computed path. On Windows the usual root is `%USERPROFILE%/.agents/skills/browser-bridge`, but expand it before giving the picker input.
2. Repeat in each intended browser profile. Open extension options and set its service URL. No profile/account labels or default target are stored; every operation supplies its own profile and privacy context.
3. JS, frame, CDP and userscript operations need debugging. Either use **Enable debugging** in extension controls or let the agent call the authorized `debugging` enable operation for the resolved target. Listing profiles/tabs and querying debugging status work while debugging is off. The saved switch is separate from actual connections: the UI shows enabled/waiting after a restart until a page connects, and connected counts only for this extension's tracked sessions. No off/on cycle is required for an ordinary restart; page operations attach when needed.
4. For private windows, explicitly enable **Allow in Incognito / Allow in InPrivate** on the extension's Details page. The extension uses spanning mode and reports each tab/window's privacy state separately.
5. Run `profiles`, select the appropriate profile, then enumerate its `normal` or `private` tabs. No result means no currently visible connection/window, not proof that the profile or account does not exist.

For Firefox, resolve this skill's `extension-firefox/manifest.json` to an existing absolute path, then provide that computed file path for **about:debugging → This Firefox → Load Temporary Add-on**. Set the service URL and enable native control in Options; confirm the selected optional permissions yourself. Allow private browsing in the add-on's details when needed. Temporary installation ends on browser restart; permanent installation on release Firefox requires Mozilla signing. See [Firefox](firefox.md) for native calls, [Window operations](windows.md) for guarded Windows background creation and signing options, and [RDP](rdp.md) only when native debugger actors are needed. An extension connection alone does not require RDP setup or its confirmation dialog.

Do not disable another installed extension or restart a user's browser to repair a connection without authorization. If an older Bridge extension attaches a debugger to the same tab, explain the conflict and ask the user which extension should control it.

Server script changes require restarting the server; client/helper script changes load on the next new invocation. Extension changes require **Reload** on the extension card (Chromium) or `about:debugging` (Firefox); a service URL change reconnects automatically. Installing a new skill may require refreshing skill discovery in an existing agent session. Existing Chromium calls remain compatible; Firefox adds `discover`, `webextension` and `rdp` rather than changing Chromium method semantics.

Sources: [Chrome incognito modes](https://developer.chrome.com/docs/extensions/reference/manifest/incognito), [Edge extension access](https://support.microsoft.com/en-us/edge/change-site-access-permissions-for-extensions-in-microsoft-edge), [Node hidden subprocesses](https://nodejs.org/api/child_process.html), [curl HTTP/file requests](https://curl.se/docs/manpage.html).


Before giving Windows picker instructions, resolve the extension directory or Firefox manifest file using the actual user skill root and verify it exists. Give the resulting absolute filesystem path, not a relative path or an unexpanded `%USERPROFILE%` expression. For example, compute it with `Path(os.environ["USERPROFILE"]) / ".agents/skills/browser-bridge/extension-firefox/manifest.json"` and `.resolve()`, or use this skill's already resolved location. The directory/file distinction matters: Chrome/Edge picks a directory, Firefox picks `manifest.json`.

## Optional Windows Edge profile association

The guarded Edge window helper needs `uv`, Python, the architecture-matching native guard, and Google's `dfindexeddb` parser to read this Bridge extension's stored profile UUID in the explicitly selected physical profile. It does not inspect website credentials or other extensions' storage. Prepare the pinned dependency explicitly before calling the helper:

```bat
uv run --no-project --with "dfindexeddb @ https://github.com/google/dfindexeddb/archive/b65ff9bd6dedb61e7b288e1bdadf68ef6b1f56bb.zip" python -c "import dfindexeddb"
```

The helper uses `--offline` and never downloads that dependency during browser operation. Missing dependencies stop with the runner's error. The source pin uses upstream's relaxed Snappy dependency for newer Python versions; the published `20260210` package pins an older Snappy release with limited Windows wheel availability. See the upstream [parser and installation documentation](https://github.com/google/dfindexeddb) and [pinned dependency definition](https://github.com/google/dfindexeddb/blob/b65ff9bd6dedb61e7b288e1bdadf68ef6b1f56bb/pyproject.toml).

Keep `scripts/windows/foreground-guard.dll` and `edge-startup-guard.dll` beside their included source files and Python helpers. The bundled native components target x64; fully exited Edge startup also checks for 64-bit Python and x64 Edge before launch. It uses a process-scoped startup callback to open ordinary or InPrivate windows without minimizing or changing browser settings. Existing Edge processes use the thread guard and extension API. See [Windows operations](windows.md) for the method and compiler commands. Client/helper and native-component changes load on the next new call; these changes alone do not require an extension reload.
