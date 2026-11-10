# Browser Bridge MCP

This repository owns the standalone browser extensions, loopback HTTP service, clients, Windows native guards and browser-bridge skill. Node.js and Python implement the same service protocol. The repository name does not imply an MCP stdio transport; there is currently no stdio entry point.

The GitHub owner is `ZHLONG321`, and the repository is private. Use `git@github.com:ZHLONG321/browser-bridge-mcp.git` for its remote. Confirm the authenticated account matches the intended owner before creating repositories; a successful Git credential lookup alone does not establish the intended identity.

Keep profile and privacy selection explicit on every browser call. Resolve all user-supplied target conditions against live candidates. Preserve window constraints and ask about ambiguity rather than selecting the first match. Do not introduce persistent current/default target state.

Discover available browsers before asking the user to choose. A single available browser or a target uniquely resolved from the user's conditions is sufficient for automatic selection. Distinguish Chromium browser products using process identity or candidate-page metadata when needed. Multiple profiles of one browser require target resolution, not another browser-choice prompt.

Background-only operations must not activate tabs, focus or minimize windows, or send desktop input. Windows native guard source and bundled x64 DLLs belong together; rebuild the affected DLL when changing its source. Refer to `references/windows.md` for the compiler commands and activation guards.

Chromium `debugging` supports read-only status and an authorized enable operation for an exact tab. Both server runtimes validate the same target, privacy, window and mutation contracts. The saved profile-wide enabled preference is separate from actual owned attachments. UI connection labels use live target checks, not the preference alone. A manual off/banner cancellation stops reconnection; enabling through a later authorized task is explicit. See `references/operations.md` for result and failure semantics.

Core servers and clients use standard libraries. Optional Windows Edge profile association uses the pinned dependency documented in `references/setup.md`. Keep browser profiles, credentials, connection state and generated artifacts out of Git. Temporary work belongs in `tmp/<session-id>/`.

The installed browser-bridge skill is a separate copy from this checkout. Repository changes do not automatically update an installed skill, reload extensions or restart a running service. Explain the applicable reload or installation step when changing those components.
