# Screenshots and scrolling

## When to capture and inspect

Use screenshots proactively for questions about rendered appearance and during authorized troubleshooting of unexpected visible states. Useful cases include missing content, blank panels, loading indicators, error banners, disabled controls, overlays, clipping and differences from the user's screenshot. Capture the relevant current state before another authorized action changes it, then open the saved image with the client's image-viewing tool. A filename or successful capture alone does not establish what the image shows.

Start with the scope that explains the issue: a viewport for context, an element/rectangle with padding for a local defect, or the full document for overall layout. Combine the visual evidence with DOM/computed styles, console errors and relevant network observations under [DevTools guidance](operations.md#devtools-and-network-observation). Resolve targets through discovery and DOM inspection first; screenshot capture itself performs no search. Screenshots and diagnostics remain within the task's existing inspection, mutation and testing authorization.

## Blank or incomplete captures

Distinguish an unreadable/empty image file, a blank region in a valid screenshot, and content that has not rendered in the browser. A successful request, document/iframe load event, elapsed delay or emulated focus is not proof that an embedded/native viewer has produced its content. Inspect the saved pixels and relevant DOM, request and browser errors before assigning a cause.

When an authorized native window capture is available, compare it with the browser capture on the same resolved target and relevant state; note whether the tab is selected, hidden or already displayed. A window capture of another selected tab does not establish what an inactive tab contains. Do not infer general background support or failure from a viewer that has already displayed successfully.

Keep recovery in the background. Do not ask the user to foreground the browser, leave it visible, and return to Codex to confirm. Separate unsupported native commands, request timeouts and missing rendered content. Diagnose alternative parameters/commands through their actual native responses under the task's testing authorization; do not present a different encoding, longer delay or reload as a proven fix. Reading or rendering the underlying document separately can inspect its content, but does not verify the original page's embedded preview. Temporary diagnostic pages must be closed when finished.

## Capture an already-resolved target

Resolve browser, profile, privacy context, window, tab, elements and frames before taking a screenshot. Screenshot tools do not search for targets, accept vague descriptions, scroll elements into view, expand hidden overflow, or decide whether application content is ready. Keep selection explicit on every call.

MCP exposes four file-producing tools:

| Tool | Area |
| --- | --- |
| `browser_screenshot_full_page` | Full scrollable width and height of the top document |
| `browser_screenshot_viewport` | Current visible page viewport at its current scroll position |
| `browser_screenshot_element` | Caller-resolved `element_rect`, optionally with surrounding `padding` |
| `browser_screenshot_rect` | Explicit `rect`, optionally with surrounding `padding` |

Every call requires `session_id` from the active caller session, not the shared HTTP service or MCP server process. Pass `profile_id`, `context`, `tab_id` and the resolved `window_id`; Firefox also requires its current extension `connection_id`, native control and site permissions.

For script composition, import `screenshot` from `scripts/node/client.mjs` and pass the same fields plus `scope: 'full_page' / 'viewport' / 'element' / 'rect'`. The Node helper uses existing CDP/WebExtension operations; either HTTP server runtime can serve it. There is no new HTTP operation or Python screenshot wrapper. Python scripts can continue using the native APIs when needed.

Rectangles contain `x`, `y`, `width`, `height`, optional `reference: 'page' / 'viewport'` (default `page`) and optional `unit: 'css_px' / 'percent' / 'ratio'` (default `css_px`). Percentages use 0..100 and ratios use 0..1 of the selected reference's width/height. For example, `{x: 0, y: 0, width: 50, height: 100, reference: 'viewport', unit: 'percent'}` captures the left half of the viewport. This also covers `vw`/`vh`-style requests after converting them to viewport percentages. These are layout coordinates, not physical screen coordinates or output image pixels.

`element_rect` uses the same rectangle contract. Supply the actual resolved element's bounds; iframe-local coordinates must be translated into top-document coordinates by the calling script first. The screenshot helper does not perform DOM lookup or guess frame offsets. An element with its own scrolling area shows only the content currently rendered inside it.

`padding: 16` includes 16 CSS pixels of existing surrounding page content on every side, stopping at document edges. An explicitly supplied base rectangle outside the document is an error; padding does not authorize changing layout or enlarging the document.

## Files, encoding and size

On Windows, screenshots go to `%TMP%/codex-<session_id>-browser-bridge/screen/`. Resolve `%TMP%` from the current environment. Other systems use their temporary directory when `TMP` is unset. Every successful call returns only a generated filename, for example `rect-<uuid>.webp`, after closing the writer and verifying that the file exists, is nonempty and has the complete byte length. A missing, empty, partial or failed write is an error. There is no Base64 image payload in the screenshot tool response and no automatic deletion.

Reconstruct the absolute path from that directory and the returned filename, then use the current client's local image-viewing tool. Confirm that the client can read WebP when compatibility is unknown; if it cannot, explicitly select `format: 'jpeg'`. Do not infer image support solely from the browser's encoder or the model API.

Every screenshot is encoded once at the selected quality. Default format is `webp`, default WebP quality is `100`; default JPEG quality is `90`. The optional `quality` range is the native 0..100 encoder range. Chromium's WebP quality 100 is lossless; Firefox uses its canvas encoder at maximum quality. Compression preserves native screenshot dimensions. There is no file-size threshold, adaptive quality loop, automatic downscaling or recapture to chase a target size. Encoders and browser surface dimensions still have their own limits; preserve their errors instead of shrinking or switching formats silently. Saved byte sizes are emitted as `screenshot_saved` diagnostics on stderr, not added to the filename-only response.

Chromium uses `Page.getLayoutMetrics` and `Page.captureScreenshot`; the helper converts CSS coordinates to the protocol's device-independent coordinate system. Chromium extension 1.0.5+ preserves screenshot image data without the ordinary text-result truncation. Other CDP text results retain their existing bounds. Firefox captures one PNG via `tabs.captureTab` and encodes that same bitmap through a detached `OffscreenCanvas` in an extension script; it does not insert a canvas, resize the page or scroll it. No image-processing package or Playwright connection is required.

## Let the AI handle complete scrolling containers

A complete scrolling-container capture is an AI-authored script workflow, not a built-in screenshot mode. Follow [script composition](clients.md): save the script file first, import the clients directly, and keep coordination and result/image processing out of shell one-liners and MCP call chains.

- Resolve the exact container separately. Record its original scroll offsets, native screenshot coordinates, visible dimensions and content bounds. Keep the resolved profile/privacy/window/tab on every call.
- Choose readiness checks for that actual page. A changed `scrollTop`, a `scrollend` event, a fixed delay, a quiet DOM, or two animation frames alone does not prove that virtualized rows, lazy-loaded images or application data are ready. Background animation frames may be paused. Inspect available page state and wait only for the segment being captured.
- Scroll to each needed position, inspect the actual resulting offset, then capture that visible region. Keep overlap where it helps detect duplicate/missing content or movement. Use actual offsets for the final partial segment instead of assuming every scroll moves one viewport.
- For changing lists, decide the intended end boundary from the user's task before collecting. Appended rows, inserted content, changing heights, sticky overlays and replaced virtualized rows can invalidate an offset-only stitch. Report a detected inconsistency or obtain the needed boundary; do not silently call an incomplete or mismatched image complete.
- Stitch and encode in the script without imposing a file-size cap or shrinking the result. Save the final screenshot in the session's `screen` directory too, check that its complete nonempty file exists, and return its filename. Keep helpers, logs and other non-image artifacts in the task's normal temporary workspace.
- Restore the original scroll positions in `finally`, including after failure. Do not focus the tab, expand the container, change application data or freeze page scripts without authorization. Close task-created temporary tabs when finished; preserve existing user tabs.

Sources: [Chromium screenshot parameters and coordinate types](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl), [Chromium image encoders](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/page_handler.cc), [Firefox captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab), [Firefox image details](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extensionTypes/ImageDetails), [OffscreenCanvas encoding](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob), [scrollend](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event), [background animation frames](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).
