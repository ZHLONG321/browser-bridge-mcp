import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {windowsSchemas} from './windows-schema.mjs';
import {requireWindows} from './windows-platform.mjs';

export const operations = Object.freeze([
  'list_windows', 'find_windows', 'get_foreground_window', 'get_window', 'get_window_rect', 'get_client_rect',
  'get_window_process', 'list_processes', 'get_process', 'capture_window', 'capture_foreground', 'capture_region',
  'search_api', 'describe_api', 'raw_call',
]);

// Isolate potentially blocking PrintWindow and native calls from the MCP event loop.
export function windows_call(operation, options = {}) {
  requireWindows();
  if (!operations.includes(operation)) throw new TypeError('Unknown Windows operation.');
  const {timeout_ms = 30000, ...args} = windowsSchemas[operation].parse(options);
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms <= 0 || timeout_ms > 2147483647) throw new TypeError('timeout_ms must be a positive 32-bit timer duration.');
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL('./windows-worker.mjs', import.meta.url)), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', execArgv: [],
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      worker.kill();
      finish(Object.assign(new Error('Windows operation timed out. No operation is retried; inspect actual state before repeating a mutation.'), {
        code: 'WINDOWS_TIMEOUT', details: {outcome_unknown: operation === 'raw_call', operation},
      }));
    }, timeout_ms);
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    worker.on('error', error => finish(error));
    worker.on('message', message => {
      if (message.error) finish(Object.assign(new Error(message.error.message), message.error));
      else finish(null, message.value);
    });
    worker.on('exit', (code, signal) => {
      if (!settled) finish(Object.assign(new Error(`Windows worker exited before returning (${signal || code}).`), {
        code: 'WINDOWS_WORKER_EXIT', details: {outcome_unknown: operation === 'raw_call', operation},
      }));
    });
    worker.send({operation, args}, error => { if (error) { worker.kill(); finish(error); } });
  });
}
