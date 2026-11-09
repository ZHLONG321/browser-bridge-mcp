# Background windows on Windows

Use the appropriate window operation for authorized creation. Keep the profile and normal/private context explicit on every call, including creating the first window of a context. Do not infer a current/default target from a previous call.

Chromium client example:

```javascript
const created = await window_control({profile_id, context: 'private',
  action: 'create', mode: 'authorized_mutation', url: authorizedUrl});
// Inspect per-item errors, then retain the returned native window and tab IDs.
```

The Chromium operation uses `chrome.windows.create({incognito, focused: false})`. That browser option alone does not guarantee no Windows activation, including when Edge has no browser window. Private access must be enabled by the user in extension details. It never silently substitutes a normal window. Closing takes the exact returned `window_id` and the same explicit profile/context. Close only the windows owned by the authorized operation.

For Edge, the Windows Node module exports `edge_defaults()` and `create_edge_window()`. First reverse lookup every condition the user supplied. Ask which browser to use if none was specified. Resolve Edge's startup profile afresh only when no existing target determines a profile; `edge_defaults()` reads the installed executable, user-data directory and `Local State` startup selection. The selected directory may differ from `Default`.

```javascript
import {edge_defaults, create_edge_window} from '<resolved-skill-root>/scripts/node/windows.mjs';

// Use this default only after resolving the user's target conditions.
const installation = await edge_defaults();
const created = await create_edge_window({
  executable: installation.executable,
  user_data_dir: installation.user_data_dir,
  profile_directory: installation.default_profile_directory,
  context: 'private', url: authorizedUrl,
});
// Later calls still pass created.value.profile_id, context and window/tab IDs.
```

The selected profile must have this skill's extension installed; InPrivate also requires the user's permission. The helper reads only this extension's stored `bridgeProfileId` to associate the physical profile with its live Bridge connection. See [Setup](setup.md) for the optional read-only LevelDB parser dependency. It saves no selected profile or default target. Every later call still carries the returned profile/context and any required window/tab identifiers.

When Edge is running, the helper locates Chromium's message-only singleton for the explicit user-data directory and verifies its executable. It installs the thread guard before loading the selected profile without a window, then creates the requested normal/InPrivate window through the extension API. When Edge has completely exited, it creates the ordinary Edge process suspended, registers a process-specific `EVENT_OBJECT_CREATE` in-context callback, and resumes it. The callback runs on that new process's UI thread before its browser window is shown. It installs the thread guard and temporarily redirects the activation-related entries in `msedge.dll`'s normal and delay-load import tables. This intercepts Chromium's explicit `ShowWindow`, `SetWindowPos` and `SetForegroundWindow` calls as well as related activation APIs. The new window is displayed normally behind the foreground application. Neither minimizing nor activating and switching back is part of the method.

The startup helper is `scripts/windows/edge_startup.py`, with x64 source/DLL `edge-startup-guard.c` and `edge-startup-guard.dll` beside it. It requires 64-bit Python and x64 Edge, checks PE architecture before launch, and verifies the essential import entries at runtime. To rebuild from the skill root with MinGW x64, use `x86_64-w64-mingw32-gcc -shared -O2 -Wall -Wextra -Werror -o scripts/windows/edge-startup-guard.dll scripts/windows/edge-startup-guard.c -luser32`. Unsupported architecture, native policy or import-layout failures are explicit errors; inspect any reported process/window before retrying a startup that has resumed.

Startup protection is confined to the newly created Edge PID; it does not inject into the foreground application or install a desktop-wide hook. A named mutex serializes this helper's startup/window-creation calls for the same user-data directory; concurrent calls still carry independent profile/context arguments. Once the live inventory identifies the result, the wrapper requests restoration on the browser UI thread, checks that every redirected import was restored, removes the hooks and releases the mutex. The callback DLL stays mapped until that browser process exits so an in-flight call cannot return into unloaded code; its activation wrappers stop suppressing after the bounded lease even if the caller disappears. It adds no keep-alive flag, does not change Edge's own exit behavior or settings, and installs no service.

The returned value includes the live `profile_id`, `context`, `connection_id`, `window_id`, tab metadata, and `native_process_id` for a cold launch. The process ID is ownership evidence for that launch, not a replacement for a bridge window ID. Several matching startup windows produce an ambiguity error rather than selecting the first. Normal startup with a show flag alone is insufficient; `--no-startup-window` also does not ensure that a process stays alive when background running is disabled. Do not fall back to an unguarded launch after a native error.

Firefox's native `windows.create` has not handled the `focused` creation option reliably. A direct call with `focused: false` can activate a new window transiently. On Windows, use the bundled native guard through the Node helper instead:

```javascript
import {create_firefox_window} from '<resolved-skill-root>/scripts/node/windows.mjs';

const created = await create_firefox_window({
  profile_id, connection_id, context: 'private',
  native_window_handle: nativeHwnd,
  anchor_window_id: bridgeWindowId,
  url: authorizedUrl,
});
if (created.status !== 'completed' || created.error) throw new Error(created.error);
// The guard has been released when the promise resolves.
// Retain created.value.id, incognito and tabs for subsequent explicit calls.
```

Resolve both window identifiers from live evidence for the selected profile. `anchor_window_id` is Firefox's WebExtension window ID; `native_window_handle` is its Win32 HWND. They are different namespaces. Enumerate native windows with `EnumWindows`, select `MozillaWindowClass`, and compare the title with `windows.get(anchor_window_id).title`. The helper verifies an exact title match and refuses an association that matches several Firefox UI threads/processes. If titles do not uniquely identify the selected process, establish the profile/process association first; do not guess. The anchor may be normal while the new window is private. Private creation still requires the user's extension permission.

The helper requires Windows, Node.js, `uv` with Python, the connected Firefox extension with native control enabled, and a native guard DLL matching Firefox's architecture. The bundled DLL is x64; architecture or policy errors stop before window creation if the target cannot acknowledge loading it. Source is included at `scripts/windows/foreground-guard.c`. Rebuild with a suitable Windows compiler when needed; for MinGW x64, use `x86_64-w64-mingw32-gcc -shared -O2 -Wall -Wextra -Werror -o scripts/windows/foreground-guard.dll scripts/windows/foreground-guard.c -luser32` from the skill root. Do not silently install tools or change browser security settings.

The private runner marks existing windows of the selected browser UI thread, installs a thread-specific `WH_CBT` hook and waits for a `WH_GETMESSAGE` acknowledgement from that target thread. Only then does the wrapper request creation. The callback returns 1 for `HCBT_ACTIVATE` on newly created `MozillaWindowClass` or `Chrome_WidgetWin_1` windows, preventing activation. It permits existing windows to behave normally, reads no keyboard input or page content, and does not install a global focus lock. A final message-queue acknowledgement precedes hook removal. The wrapper removes hooks and window properties in `finally`; a bounded lease also ends the guard if its owner disappears. During that brief lease, other newly created browser windows on the same UI thread also cannot activate. Concurrent guards for the same thread are refused; calls do not store a selected profile or window.

Inspect an unknown creation outcome before retrying. If association, loading or acknowledgement fails, the helper does not request a window; do not fall back to unguarded creation. If the bridge times out after dispatch, creation may have happened. Guard-release errors are reported explicitly. Do not try `state: minimized` as a presumed fix: Firefox applies that state after startup, so it does not establish no activation during creation.

Use `tabs.create` with the resolved native `windowId` and `active: false` for Firefox background tabs. Include the matching bridge profile, connection, context and window identifiers on the outer call.

Check the resulting live inventory and reverse lookup. Creation acknowledgements and a `focused` field alone do not establish that OS focus stayed unchanged. For a background-only trial, observe OS foreground events continuously through creation and closure; before/after equality can miss a transient activation. On Windows, an out-of-context `SetWinEventHook` for `EVENT_SYSTEM_FOREGROUND` supplies a read-only observation when its thread runs a message loop. If focus changes, report the failure and stop that method. Do not restore focus by activating another window or turn the failed method into a background recipe.

Do not use Firefox command-line `--new-window` / `--private-window` as a background-only substitute. Windows `STARTF_USESHOWWINDOW` and `SW_SHOWMINNOACTIVE` do not establish that Firefox will honor no-activation at startup. A disconnected browser needs user setup before native bridge calls can run; do not change settings, load extensions through visible UI, or launch/restart it merely to complete a background test.

When the task calls for finding installed Firefox on Windows, inspect the registered `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe` under HKCU/HKLM (and the applicable registry view). Confirm the resolved executable exists. Read `%APPDATA%/Mozilla/Firefox/profiles.ini` for registered profile names and paths: respect `IsRelative`, and distinguish an installation's `Install.../Default` from a profile section's `Default`. Multiple installations/profiles need target evidence; the INI does not prove which profile a live extension connection belongs to. Use the profile-association reference when that mapping is required. Do not read account credentials to identify a profile.

Firefox temporary extensions disappear after restart. For installation that survives restart on release Firefox, Mozilla supports signing an unlisted, self-distributed add-on: use an AMO developer account, submit the extension package as “On your own”, then install the signed XPI from a local file. This still uploads code to Mozilla and is subject to validation/review; it is not an offline local signature. Do not upload or publish a package without authorization. Remote-code execution and broad permissions must be checked against add-on policies; signing acceptance cannot be assumed. See [Signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/), [Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/) and [Add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).

Sources: [Chrome windows API](https://developer.chrome.com/docs/extensions/reference/api/windows), [Firefox windows.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create), [Firefox command line](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html), [Firefox window implementation](https://github.com/mozilla-firefox/firefox/blob/main/browser/components/extensions/parent/ext-windows.js), [Windows CBT callback](https://learn.microsoft.com/en-us/windows/win32/winmsg/cbtproc), [Windows hook installation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexw), [Windows process/event hooks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook), [Synchronous in-context callbacks](https://learn.microsoft.com/en-us/windows/win32/winauto/in-context-hook-functions), [PE import tables](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format), [Chromium Windows activation implementation](https://github.com/chromium/chromium/blob/main/ui/views/win/hwnd_message_handler.cc).
