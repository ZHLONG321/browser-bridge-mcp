import * as z from 'zod/v4';

const int = z.number().int().safe();
const hwnd = z.union([int.positive(), z.string().regex(/^(?:0x[0-9a-f]+|[0-9]+)$/i)]).describe('Native Windows HWND from live discovery; not a browser window_id.');
const limit = int.positive().optional();
const match = z.enum(['contains', 'exact', 'regex']);
const timeout = {timeout_ms: int.positive().max(2147483647).optional().describe('Worker timeout, default 30000 ms; no automatic replay.')};
const capture = {
  session_id: z.string().regex(/^[A-Za-z0-9_-]+$/).describe('Current caller Codex session ID for the screenshot directory.'),
  format: z.enum(['webp', 'jpeg']).optional(), quality: int.min(1).max(100).optional(),
  return_image: z.boolean().optional().describe('Save first, then include the same image bytes in the response; defaults to false.'),
};
const windowRect = z.strictObject({x: int.min(0), y: int.min(0), width: int.positive(), height: int.positive()})
  .describe('Crop within the native window in physical pixels, relative to its top-left including frame. Prefer the smallest useful area.');
const proxy_url = z.string().url().optional().describe('Explicit HTTP(S) proxy for Microsoft Learn only. No implicit proxy environment or browser service.');
const api = z.string().regex(/^[A-Za-z_]\w*$/).describe('Exact documented Win32 export, including A/W suffix when present.');
const definitions = {
  list_windows: {include_invisible: z.boolean().optional(), limit},
  find_windows: {title: z.string(), match: match.optional(), include_invisible: z.boolean().optional(), limit},
  get_foreground_window: {}, get_window: {hwnd}, get_window_rect: {hwnd}, get_client_rect: {hwnd}, get_window_process: {hwnd},
  list_processes: {limit}, get_process: {process_id: int.min(0).max(0xffffffff)},
  capture_window: {...capture, hwnd: hwnd.optional(), title: z.string().optional(), title_match: match.optional(), rect: windowRect.optional()},
  capture_foreground: {...capture, rect: windowRect.optional()}, capture_region: {...capture, x: int, y: int, width: int.positive(), height: int.positive()},
  search_api: {query: z.string().min(1), max_results: limit, proxy_url}, describe_api: {api, proxy_url},
  raw_call: {api, arguments: z.record(z.string(), z.unknown()), proxy_url,
    mode: z.enum(['read_only', 'authorized_mutation']).describe('Caller authorization/intent, not an effect sandbox.'),
    allow_foreground: z.boolean().optional().describe('Set true only after explicit user authorization for foreground operations.')},
};
export const windowsSchemas = Object.fromEntries(Object.entries(definitions).map(([name, fields]) => [name, z.strictObject({...fields, ...timeout})]));
