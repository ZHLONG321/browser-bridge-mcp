import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {windowsSchemas} from './windows-schema.mjs';
import {requireWindows} from './windows-platform.mjs';

export const operations = Object.freeze([
  'list_windows', 'find_windows', 'get_foreground_window', 'get_window', 'get_window_rect', 'get_client_rect',
  'get_window_process', 'list_processes', 'get_process', 'capture_window', 'capture_foreground', 'capture_region',
  'search_api', 'describe_api', 'raw_call',
]);

let captureWorker;
let captureQueue = Promise.resolve();
process.once('exit', () => captureWorker?.kill());

function createWorker(reuse) {
  const worker = fork(fileURLToPath(new URL('./windows-worker.mjs', import.meta.url)), [], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', execArgv: [],
  });
  const forget = () => { if (captureWorker === worker) captureWorker = undefined; };
  worker.on('error', forget);
  worker.once('exit', forget);
  if (reuse) {
    captureWorker = worker;
    // An idle capture helper must not keep a CLI or disconnected MCP host alive.
    worker.unref();
    worker.channel?.unref();
    worker.once('disconnect', () => { forget(); worker.kill(); });
  }
  return worker;
}

// Isolate blocking native calls. Reuse one serialized PrintWindow worker so repeated
// screenshots do not reload Koffi/Sharp; other operations retain per-call isolation.
export function windows_call(operation, options = {}) {
  requireWindows();
  if (!operations.includes(operation)) throw new TypeError('Unknown Windows operation.');
  const {timeout_ms = 30000, ...args} = windowsSchemas[operation].parse(options);
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms <= 0 || timeout_ms > 2147483647) throw new TypeError('timeout_ms must be a positive 32-bit timer duration.');
  const reuse = operation === 'capture_window' || operation === 'capture_foreground';
  if (!reuse) return callWorker(operation, args, timeout_ms, false);
  const request = captureQueue.then(() => callWorker(operation, args, timeout_ms, true));
  captureQueue = request.then(() => {}, () => {});
  return request;
}

function callWorker(operation, args, timeout_ms, reuse) {
  return new Promise((resolve, reject) => {
    const worker = (reuse && captureWorker) || createWorker(reuse);
    let settled = false;
    const discard = () => {
      if (captureWorker === worker) captureWorker = undefined;
      worker.kill();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      worker.removeListener('error', onError);
      worker.removeListener('message', onMessage);
      worker.removeListener('exit', onExit);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      discard();
      finish(Object.assign(new Error('Windows operation timed out. No operation is retried; inspect actual state before repeating a mutation.'), {
        code: 'WINDOWS_TIMEOUT', details: {outcome_unknown: operation === 'raw_call', operation},
      }));
    }, timeout_ms);
    const onError = error => { discard(); finish(error); };
    const onMessage = message => {
      if (message.error) finish(Object.assign(new Error(message.error.message), message.error));
      else finish(null, message.value);
    };
    const onExit = (code, signal) => {
      if (!settled) finish(Object.assign(new Error(`Windows worker exited before returning (${signal || code}).`), {
        code: 'WINDOWS_WORKER_EXIT', details: {outcome_unknown: operation === 'raw_call', operation},
      }));
    };
    worker.on('error', onError);
    worker.on('message', onMessage);
    worker.on('exit', onExit);
    worker.send({operation, args, reuse}, error => { if (error) { discard(); finish(error); } });
  });
}
