# Browser Bridge MCP

Control Chrome, Edge and Firefox in the background through MCP tools and browser extensions. A shared local service accepts CLI/script HTTP requests and connects to extensions through WebSocket. Each operation selects its profile, normal/private context and window explicitly.

## Install with an AI agent

Tell your agent:

> Install the skill from https://github.com/ZHLONG321/browser-bridge-mcp

The repository URL is all you need to provide. The repository contains one skill: [browser-bridge](skills/browser-bridge/SKILL.md).

### Instructions for the installing agent

1. Install the sole skill from **`skills/browser-bridge`**, named **`browser-bridge`**. Resolve this path from the repository yourself; do not ask the user to supply a skill name, subdirectory or installation command.
2. Use your environment's skill installer when available, passing this repository and `skills/browser-bridge` as its selected path. Otherwise copy that entire directory into the active agent's supported user skill directory. Include `package.json`, `package-lock.json` and all bundled resources. Do not install the repository root as a skill. If a copy already exists, inspect it and preserve local changes before updating it.
3. Read the installed `SKILL.md` and [MCP installation guide](skills/browser-bridge/references/mcp.md). Install the locked dependencies with Node.js 20.9+/npm, keeping optional prebuilt packages enabled, then register the stdio MCP server in the current client using computed absolute paths. Resolve the skill location and configuration format yourself; the user need not supply extra installation parameters. Explain any client reload needed. Installing the skill and registering MCP do not require opening a browser or granting extension permissions.
4. When the user is ready to connect a browser, discover available browsers as the skill describes. Compute extension picker paths from the actual installed directory and give expanded, verified absolute paths. Browser extension loading and private-window permissions require user action; never claim they are granted by copying the skill.

Public repositories can be downloaded without GitHub credentials. While this repository is private, use existing credentials with access to `ZHLONG321/browser-bridge-mcp`; ask for access only if authentication fails. Do not change repository visibility.

## Contents

```text
skills/browser-bridge/
  SKILL.md
  package.json
  package-lock.json
  references/
  scripts/mcp/
  scripts/node/
  scripts/python/
  scripts/windows/
  extension/
  extension-firefox/
```

The MCP entry point is `scripts/mcp/server.mjs` inside the installed skill. It uses stdio for the AI client. The shared service uses HTTP for local clients and WebSocket for extensions; pinned dependencies provide WebSocket framing. MCP, CLI and scripts share browser connections without depending on one Codex session's lifetime.

- [MCP installation and tools](skills/browser-bridge/references/mcp.md)
- [Browser setup and connection](skills/browser-bridge/references/setup.md)
- [Node.js and Python clients](skills/browser-bridge/references/clients.md)
- [Operations and debugging control](skills/browser-bridge/references/operations.md)
- [Windows background window creation](skills/browser-bridge/references/windows.md)
- [Independent Node and Python Windows commands, screenshots and WinAPI](skills/browser-bridge/references/windows-desktop.md)
- [Firefox native APIs](skills/browser-bridge/references/firefox.md)

Run commands shown in the skill documentation from the installed `browser-bridge` directory, or from `skills/browser-bridge` in a checkout. Existing installed copies and this checkout are separate; repository updates do not automatically reload an installed skill, extension or running service.
