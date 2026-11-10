# Browser Bridge MCP

Control Chrome, Edge and Firefox in the background through browser extensions and a local HTTP service. Each operation selects its profile, normal/private context and window explicitly.

## Install with an AI agent

Tell your agent:

> Install the skill from https://github.com/ZHLONG321/browser-bridge-mcp

The repository URL is all you need to provide. The repository contains one skill: [browser-bridge](skills/browser-bridge/SKILL.md).

### Instructions for the installing agent

1. Install the sole skill from **`skills/browser-bridge`**, named **`browser-bridge`**. Resolve this path from the repository yourself; do not ask the user to supply a skill name, subdirectory or installation command.
2. Use your environment's skill installer when available, passing this repository and `skills/browser-bridge` as its selected path. Otherwise copy that entire directory into the active agent's supported user skill directory. Keep `SKILL.md`, `references`, `scripts`, `extension` and `extension-firefox` together. Do not install the repository root as a skill. If a copy already exists, inspect it and preserve local changes before updating it.
3. Read the installed `SKILL.md` and [setup guide](skills/browser-bridge/references/setup.md). Follow their runtime and service instructions, and explain any agent restart needed to discover the installed skill. Installing the skill does not require opening a browser or granting extension permissions.
4. When the user is ready to connect a browser, discover available browsers as the skill describes. Compute extension picker paths from the actual installed directory and give expanded, verified absolute paths. Browser extension loading and private-window permissions require user action; never claim they are granted by copying the skill.

Public repositories can be downloaded without GitHub credentials. While this repository is private, use existing credentials with access to `ZHLONG321/browser-bridge-mcp`; ask for access only if authentication fails. Do not change repository visibility.

## Contents

```text
skills/browser-bridge/
  SKILL.md
  references/
  scripts/
  extension/
  extension-firefox/
```

The skill includes Node.js and Python services and clients, a Windows HTTP CLI, and Windows native helpers for creating browser windows without taking focus. The current transport is loopback HTTP; there is no MCP stdio entry point.

- [Setup and connection](skills/browser-bridge/references/setup.md)
- [Node.js and Python clients](skills/browser-bridge/references/clients.md)
- [Operations and debugging control](skills/browser-bridge/references/operations.md)
- [Windows background window creation](skills/browser-bridge/references/windows.md)
- [Firefox native APIs](skills/browser-bridge/references/firefox.md)

Run commands shown in the skill documentation from the installed `browser-bridge` directory, or from `skills/browser-bridge` in a checkout. Existing installed copies and this checkout are separate; repository updates do not automatically reload an installed skill, extension or running service.
