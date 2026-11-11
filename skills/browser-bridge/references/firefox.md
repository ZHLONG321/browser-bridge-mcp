# Firefox WebExtension APIs

On Windows, resolve this skill's `extension-firefox/manifest.json` to an existing absolute path before giving the user the picker input for `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**. It lasts until Firefox restarts. Permanent installation on standard release Firefox requires Mozilla signing; renaming ZIP to XPI does not sign it. Reload after extension changes and let the user approve Firefox's permission-update prompt when shown. Set the loopback service URL and **Enable native browser control** in Options. Desktop API and website permissions are requested by the manifest at installation/update. Private windows separately require **Run in Private Windows → Allow** in the add-on's details when needed.

The MV2 background page exposes the granted native `browser.*` APIs. It uses neither Chromium debugger nor offscreen APIs. Broad desktop permissions exclude `browsingData`; do not clear browser data through another API as a workaround. `permissions.getAll` reports actual grants; Options also shows private-window access. Extension privileges do not override Firefox's protected-page rules, supply OS access, install a native-messaging host or remove native user-gesture requirements. The MV2 `user_scripts` manifest key retains the legacy API; Firefox's newer optional-only `userScripts` permission belongs to its MV3 API and must not be substituted here. Follow [manual consent](setup.md#browser-permissions-and-manual-consent) only when the current task encounters a specific gate.

## Select and call

`discover()` returns browser family, extension `profile_id`, live `connection_id` and windows. Each Firefox call supplies its own `profile_id`, `connection_id` and `context`, plus `window_id` when the user specifies a window. The persistent profile ID survives extension restarts. A WebSocket reconnect within the same background execution context preserves the connection ID, subscriptions and native handles; a background-context restart replaces them. `tabs({profile_id, context})` returns `firefox-tab:<profile-id>:<native-id>` and `browser_tab_id`. Native browser methods take that numeric native ID, not the bridge ID.

```javascript
import {discover, webextension} from '<skill>/scripts/node/client.mjs';
const inventory = await discover();
// Supply the target explicitly on each call, independently of other calls.
console.log(await webextension({profile_id, connection_id, context: 'normal', action: 'describe', path: 'scripting'}));
console.log(await webextension({
  profile_id, connection_id, context: 'normal', window_id,
  path: 'scripting.executeScript', tab_id: bridgeTabId,
  args: [{target: {tabId: nativeTabId}, world: 'MAIN',
          func: {$function: '() => ({title: document.title, href: location.href})'}}]
}));
```

Use `request PROFILE normal/private REQUEST.json` for the same payload with `operation: "webextension"` and `connection_id`. `/request` still requires explicit profile/context. A supplied `tab_id` is checked against that context by both server and extension. Native API arguments themselves remain native and can be profile-wide: select a window from the context's inventory, use `tabs.query` with its `windowId`, and keep callbacks/listeners within that context. Firefox's `tabs.query` does not accept an `incognito` filter. An anchor does not sandbox arbitrary function arguments or native methods.

| `action` | Fields and result |
| --- | --- |
| `call` (default) | `path`, native positional `args: []`; returns `value` or native error |
| `describe` | `path` namespace, empty for top-level; returns members, method/event kinds and actual grants |
| `watch` | event `path`, `args` following the listener in native `addListener`; returns `subscription_id`, `next_cursor` |
| `events` | `after` exclusive cursor (default 0), `wait_ms` 0..15000 (default 0); returns events, cursors and `gap` |
| `unwatch` | `subscription_id`; removes that listener |
| `release` | `path: "handles.<id>"`; drops a native object reference, without undoing its operation |

Every result has `status: completed/failed`; inspect `error` even when HTTP succeeds. `mode` records caller intent, not a native-method sandbox. Known tab/window activation calls require `allow_foreground: true`. Background tab creation must specify `active: false` and the resolved native `windowId`. Firefox can activate a new window transiently even with `focused: false`; Windows background creation must use the guarded `create_firefox_window` helper described in [Window operations](windows.md). Do not substitute a direct `webextension` call or a raw function for that helper under background-only authorization. Raw functions and unclassified APIs retain the same user-authorization requirement.

Nested `{"$function":"() => ..."}` supplies an extension-privileged function; nested `{"$base64":"..."}` supplies an ArrayBuffer for APIs accepting one. Page `scripting.executeScript.args` must still be JSON-serializable: pass integer arrays/base64 and reconstruct bytes inside the page function. Check each InjectionResult's `error` as well as its `result`.

Returned objects with methods have `$handle` and `methods`. Call `handles.<id>.<method>` with native arguments; describe `handles` to list them. Unregister/close native registrations before releasing their handle when needed. A background-context restart or disabling control clears managed listeners and handles, without undoing prior browser changes. A transport reconnect preserves them. Never replay an uncertain mutation.

Example event watch: `path: "tabs.onUpdated", args: [{tabId: nativeTabId, properties: ["status"]}]`. For `webRequest`, host patterns omit TCP ports; add the selected `tabId`. Managed observation listeners do not supply blocking return values. Explicit function callbacks retain the native API's own return and lifetime rules. A completed navigation request does not prove the new page finished loading; inspect its expected URL/document and status before using it.

Events retain 1 MiB per extension. `gap`/`oldest_cursor` report overwritten data. Native results use the HTTP transport's complete JSON response, with no inherited BO WebSocket frame limit. Prefer native paging for large data.

Sources: [WebExtension APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API), [private browsing](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito), [temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).


Before giving Windows picker instructions, resolve the extension directory or Firefox manifest file using the actual user skill root and verify it exists. Give the resulting absolute filesystem path, not a relative path or an unexpanded `%USERPROFILE%` expression. For example, compute it with `Path(os.environ["USERPROFILE"]) / ".agents/skills/browser-bridge/extension-firefox/manifest.json"` and `.resolve()`, or use this skill's already resolved location. The directory/file distinction matters: Chrome/Edge picks a directory, Firefox picks `manifest.json`.
