import {windows_call} from '../node/windows-runner.mjs';
import {windowsSchemas} from '../node/windows-schema.mjs';

const descriptions = {
  list_windows: 'List live Windows windows with HWND, title, process, visibility and physical-pixel bounds. No Bridge connection needed.',
  find_windows: 'Find live Windows windows by title (contains/exact/regex). Resolve ambiguity before acting; no focus changes.',
  get_foreground_window: 'Inspect the current foreground Windows window without activating anything. Discovery is not authorization to modify unrelated applications.',
  get_window: 'Inspect one live native HWND, title, class, process, visibility and bounds.',
  get_window_rect: 'Read a native window rectangle in physical desktop pixels, including nonclient frame.',
  get_client_rect: 'Read native client-area bounds in physical pixels relative to the client origin.',
  get_window_process: 'Resolve an exact live HWND to its Windows PID, thread and executable path.',
  list_processes: 'List live Windows processes with PID, parent PID, executable name/path. Inaccessible paths retain their Win32 errors.',
  get_process: 'Inspect one live Windows process by PID. Does not launch, stop or focus anything.',
  capture_window: 'Capture exactly one HWND or uniquely matched title with PrintWindow, without activation/restoration. Save compressed WebP/JPEG and return only a verified filename; may be blank for protected/native rendering.',
  capture_foreground: 'Capture the existing foreground window without changing focus. Ensure capturing this application is within user authorization. Return only a verified screenshot filename.',
  capture_region: 'Capture a rectangle of the visible virtual desktop in physical pixels; negative monitor coordinates are allowed. May include overlapping applications; stay within task authorization. Return only a verified filename.',
  search_api: 'Search Microsoft Learn for Win32 function documentation; optional explicit proxy_url. Does not call native APIs.',
  describe_api: 'Read the exact Win32 function signature, DLL, documented types and supported raw-call subset from Microsoft Learn.',
  raw_call: 'Invoke a documented WinAPI scalar/handle/input-string signature with exact named arguments. No Python or Bridge needed. Without separate user authorization, act only on browsers and related processes/windows. Foreground effects require explicit user permission and allow_foreground:true. Mode records intent, not a sandbox; inspect the documented return value. Process-local handles cannot be reused across separate MCP calls.',
};

export function registerWindowsTools(server) {
  for (const [operation, description] of Object.entries(descriptions)) {
    const fileOutput = operation.startsWith('capture_');
    const readOnly = operation !== 'raw_call' && !fileOutput;
    server.registerTool(`windows_${operation}`, {description: `${description} Unavailable on non-Windows platforms (WINDOWS_UNAVAILABLE).`, inputSchema: windowsSchemas[operation],
      annotations: {readOnlyHint: readOnly, destructiveHint: operation === 'raw_call', idempotentHint: readOnly, openWorldHint: true},
    }, async args => {
      try {
        const value = await windows_call(operation, args);
        if (typeof value === 'string') return {content: [{type: 'text', text: value}]};
        const structuredContent = Array.isArray(value) ? {items: value} : value === null ? {window: null} : value;
        return {content: [{type: 'text', text: JSON.stringify(structuredContent)}], structuredContent};
      } catch (error) {
        const structuredContent = {error: {code: error.code || 'WINDOWS_OPERATION_FAILED', message: error.message,
          ...(error.details ? {details: error.details} : {})},
          recovery: error.code === 'WINDOWS_UNAVAILABLE'
            ? 'Windows commands are unavailable on this OS. Do not retry them, install Windows dependencies or reload the browser extension to resolve this platform limitation.'
            : 'Inspect the actual HWND/PID, authorization and native error. Do not replay uncertain mutations. Windows commands do not require restarting Bridge or reloading an extension.'};
        return {content: [{type: 'text', text: JSON.stringify(structuredContent)}], structuredContent, isError: true};
      }
    });
  }
}
