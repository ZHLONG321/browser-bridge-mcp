# Firefox native RDP

RDP is Firefox's own TCP debugger protocol, separate from WebExtension APIs, the Bridge HTTP port and WebDriver BiDi's `--remote-debugging-port`. It exposes actual native actors for tabs, extensions, processes, workers, console, DOM/CSS, debugger execution, resources and profiling. Discover traits/forms/methods from the running browser; there is no actor/method allowlist or translation to CDP.

## Setup and permission

The intended Firefox must have `devtools.debugger.remote-enabled=true`; browser/process access also needs `devtools.chrome.enabled=true`. The user starts its loopback TCP listener with `--start-debugger-server <port>`. Keep loopback restriction and native connection confirmation enabled. The bridge never edits preferences, scans ports, launches/restarts Firefox, or accepts prompts. Visible settings and a new incoming-connection dialog require explicit user permission. Do not disable `devtools.debugger.prompt-connection` to avoid this boundary.

Find a known listener through read-only process/socket inventory when needed, not arbitrary port scans. On Windows, `Get-Process -Name firefox` and `Get-NetTCPConnection -OwningProcess <pid> -State Listen` identify candidates. A listener is not proof of RDP or the intended profile. Do not require the user to know an internal port/UUID. Establish the listener/profile relationship from actual process metadata and accepted RDP metadata; see [profile association](firefox-profiles.md).

## Discover and exchange

```javascript
import {discover, rdp} from '<skill>/scripts/node/client.mjs';
console.log(await discover()); // Existing connections only; opens no listener.
// Only after permission for the possible Firefox native confirmation dialog:
const first = await discover({rdp_port: port, allow_foreground: true, scope: 'tabs'});
const connectionId = first.connection_id;
// If connecting, let the user accept and reuse this same connection ID.
const found = await discover({connection_id: connectionId, scope: 'tabs'});
let result = await rdp({connection_id: connectionId,
  packets: [{to: actorFromNativeResponse, type: nativeMethod}],
  after: found.next_cursor, wait_ms: 500});
result = await rdp({connection_id: connectionId, after: result.next_cursor, wait_ms: 500});
```

Python exports `discover(**fields)` and `rdp(**fields)` with the same snake_case wire fields. BAT uses `discover [REQUEST.json]` and `rdp REQUEST.json`; both return complete JSON. HTTP routes are GET/POST `/discover` and POST `/rdp`, with the existing client header.

`discover` fields: `connection_id` **or** `rdp_port` (1..65535), optional `rdp_host` (`127.0.0.1`, `::1`, `localhost`; default 127.0.0.1), `actor`, `scope` (`tabs` default, `addons`, `workers`, `processes`, `service_workers`), optional exclusive `after`, `wait_ms` 0..15000 (default 500). `allow_foreground: true` is required only when opening a new listener connection, after permission. Reuse accepted connections. A pending native prompt keeps the same connection ID and sends no actor requests before its greeting.

Native discovery sends `requestTypes`, `getRoot`, and the selected root list; `actor` sends only that actor's `requestTypes`. Results expose method names and runtime forms/traits, not complete argument schemas. Read the matching official actor spec for exact fields/events and one-way calls; do not invent `protocolDescription` support. Actor and descriptor lifetimes can change on navigation.

`rdp` fields: required `connection_id`, `action: exchange` (default) or `disconnect`, ordered native `packets: [{to,type,...}]` (default empty), optional outgoing `bulk: {actor,type,data_base64}`, optional exclusive `after`, `wait_ms` 0..15000 (default 500), `mode: read_only/authorized_mutation`. `disconnect` accepts no packets/bulk and releases that session's actors. Shutdown closes all owned native connections.

RDP has no universal response ID. `wait_ms` is a collection window, never proof of command completion. Preserve wire order, correlate using the selected actor's documented contract, and poll from `next_cursor` for delayed replies/events. Coordinate callers sharing one session. Never automatically replay on disconnect, deadline or uncertain send. A transport success and a native actor's successful completion are separate facts.

Stream entries have `sequence`, `kind: json/bulk`. JSON `packet` is unchanged. Incoming bulk has `transfer_id`, actor/type, byte `length`, `offset`, base64 data and `final`; outgoing bulk follows packets under one send lock. Frames and retained stream are bounded to 8 MiB per connection; bulk is chunked at 64 KiB. `oldest_cursor` and `gap` explicitly report overwritten entries. A gap invalidates a complete bulk reconstruction. Poll promptly and use native paging/bulk APIs for large data. Old IDs/cursors never transfer to a newly opened connection.

RDP has no automatically selected extension profile or normal/private filter. Before page work, establish the intended target using [profile association](firefox-profiles.md) and native descriptors. Do not infer it from ordinary URLs, foreground state or tab order.

Sources: [RDP transport and actor ordering](https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html), [actor hierarchy](https://firefox-source-docs.mozilla.org/devtools/backend/actor-hierarchy.html), [native actor specs](https://searchfox.org/mozilla-release/source/devtools/shared/specs), [Firefox command line](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html).
