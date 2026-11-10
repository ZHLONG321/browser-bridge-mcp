# Native background video recording

Resolve the live browser, profile, privacy context, window and tab before recording. Every start/status/stop/result call repeats that selection and the caller's `session_id`. A recording ID identifies one job; it does not select a current browser. No tool searches, scrolls, activates a page, captures the desktop, or expands a scrolling document.

## Tools and lifecycle

| Tool | Result |
| --- | --- |
| `browser_recording_start` | A recording ID and acknowledged start state; returns without waiting for the video to finish |
| `browser_recording_status` | Current job state, original target, completed byte count and separate notification state |
| `browser_recording_stop` | Promptly requests one stop; use the result tool after saving finishes |
| `browser_recording_result` | Only the verified filename on success; otherwise the current state/error |

Start and stop require `mode: 'authorized_mutation'`. Start accepts optional `duration_ms` for automatic stop. Without a duration, the recording continues until an explicit stop; the AI must retain its job ID and arrange that stop. Do not leave a manual recording running merely because the conversation is ending. The native browser operation continues in the background, and a separate hidden Node worker handles the duration/stop request and file writing even if the MCP connection ends. The worker does not stop the shared Bridge service.

States are `starting`, `recording`, `saving`, `completed`, `unsupported` and `failed`. Resolve an uncertain start using the same job's status; never replay a timed-out start or native stop. Starting a second recorder while the browser already has one preserves the native busy error and does not stop the existing recording. A missing worker, lost connection, disabled debugging, changed window/privacy association or closed target is a failure, not proof that recording is unsupported. Failed jobs retain partial files and unread native stream handles for explicit recovery; no automatic retry, deletion or transcoding occurs.

Chromium support is established by the actual `Page.startScreenRecording` response. A missing native method or explicit missing native codec support returns `status: 'unsupported', supported: false` with the reason. Other errors retain their cause. The current Firefox Bridge has no equivalent native video-recording operation and returns `unsupported`; it does not substitute timed screenshots, desktop recording or a permission picker.

## Original video files

Videos go to `%TMP%/codex-<session_id>-browser-bridge/video/`, using the current environment's temporary directory. Native MP4/WebM bytes are copied directly from the browser's stream in bounded chunks. There is no second encoder, bitrate override, file-size cap or automatic quality reduction. Filename extension follows the actual native container. Optional `max_width`, `max_height` and `frame_rate` are passed to the browser's native encoder; omitted values use browser defaults, which do not promise original display resolution. `audio` defaults to false; enable target-tab playback audio only when authorized.

The worker first completes the native stop operation, reads the stream to EOF, finishes and closes the file, then verifies its existence, nonzero length and exact written byte count. Only then is the final filename exposed. This establishes completed stream/file transfer, not independent playback validation. A result lookup checks the file again before returning its filename; a missing or incomplete file errors. Base64 transport stays internal to the browser client. The AI reconstructs the directory plus filename when giving the user a file link.

Job requests, state and `worker.log` live under `video/.jobs/<recording_id>/`. Logs show startup, recording, saving, completion and notification status. They are local runtime artifacts, never source-controlled. Keeping a video does not authorize keeping task-created temporary browser tabs open after recording ends.

## Completion after Codex final

An ordinary completed MCP call cannot by itself promise that Codex will start another turn. To request delivery, pass `codex_notify: {app_server_url, thread_id}` at start. The address must be the **known existing loopback WebSocket App Server that owns the caller's loaded thread**, for example a host used by `codex --remote`; the ID is that caller's thread ID. Discover it from the actual client/host configuration. Never guess a port, create another Codex server, silently resume the thread elsewhere or alter the user's Codex settings to make a notification work. A normal standalone CLI session does not establish an accessible App Server endpoint merely by having a session ID.

The optional notification path uses Node's built-in WebSocket and requires Node.js 22+; recording itself retains Node.js 20+ support. The supplied endpoint must accept this local connection; authentication/connection failures are explicit notification failures, with the saved video retained. No new dependency or server is installed. Without a supplied destination, status says `notification.status: 'not_configured'`; the AI must get the result during an active turn or when the user returns. Do not promise an automatic message after final in that case.

After the file is verified, the worker sends `turn/start` with empty `input` and a standalone `browser_recording_result` tool output containing only the filename. This can start another turn after final, or queue the output on an active turn according to Codex's protocol. Acknowledgement is recorded as `notification.status: 'accepted'`, which means Codex accepted the result, not that a reply has already been displayed. Delivery is attempted once; a lost acknowledgement does not authorize replay. A notification failure never changes a completed video into a failed recording or discards its file.

Sources: [Native recording parameters and stream handles](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl), [Chromium native recorder](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/media_recorder.cc), [Codex App Server transports and standalone tool output](https://learn.chatgpt.com/docs/app-server), [Node WebSocket](https://nodejs.org/api/globals.html#class-websocket).
