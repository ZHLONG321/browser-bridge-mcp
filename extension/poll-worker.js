"use strict";

const instanceId = crypto.randomUUID();
const pendingRpc = new Map();
const completed = new Map();
let sequence = 0;
let current = null;
let publishing = false;
let publishAgain = false;

function rpc(request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pendingRpc.delete(id); reject(new Error(`Extension RPC timed out: ${request.type}`)); }, timeoutMs);
    pendingRpc.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
    self.postMessage({type: 'extension_request', id, request});
  });
}

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'extension_response') {
    const call = pendingRpc.get(message.id);
    if (!call) return;
    pendingRpc.delete(message.id);
    if (message.response?.ok) call.resolve(message.response.value);
    else call.reject(new Error(message.response?.error || 'Extension request failed'));
  } else if (message?.type === 'tabs_changed') {
    void publish();
  } else if (message?.type === 'config_changed') {
    current = null;
  }
});

async function http(path, {base, secret}, body, timeoutMs = 20000) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json', ...(secret ? {'X-Browser-Bridge-Secret': secret} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `HTTP ${response.status}`);
  return value;
}

async function snapshot() {
  return {...await rpc({type: 'snapshot_tabs'}), instance_id: instanceId};
}

async function publish() {
  if (!current) return;
  if (publishing) { publishAgain = true; return; }
  publishing = true;
  try {
    do {
      publishAgain = false;
      const connection = current;
      if (!connection) break;
      const inventory = await snapshot();
      await http('/extension/snapshot', connection, inventory);
      await setStatus('connected', '', inventory.tabs.length);
    } while (publishAgain);
  } catch {
    // The polling loop reports connection failures and reconnects; do not replay jobs here.
  } finally { publishing = false; }
}

async function setStatus(status, error = '', tabCount = 0) {
  try { await rpc({type: 'set_status', status, error, tabCount}); } catch { /* Status does not own transport recovery. */ }
}

async function run() {
  while (true) {
    try {
      if (!current) {
        const config = await rpc({type: 'get_config'});
        const address = new URL(config.bridgeBaseUrl);
        if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('Use a loopback HTTP service URL with no path or credentials.');
        const base = address.origin;
        const bootstrap = await http('/extension/bootstrap', {base});
        current = {base, secret: bootstrap.secret};
      }
      const connection = current;
      const inventory = await snapshot();
      const response = await http('/extension/poll', connection, {...inventory, results: [...completed.values()]});
      for (const id of response.acknowledged || []) completed.delete(id);
      await setStatus('connected', '', inventory.tabs.length);
      for (const job of response.jobs || []) {
        if (completed.has(job.job_id)) continue;
        const remaining = Math.max(1, job.deadline_at - Date.now());
        try {
          const value = await rpc({type: 'execute_jobs', jobs: [job], timeout_ms: remaining}, remaining + 2000);
          const result = value.results?.[0];
          if (!result) throw new Error('Extension returned no job result.');
          completed.set(job.job_id, result);
        } catch (error) {
          completed.set(job.job_id, {job_id: job.job_id, tab_id: job.tab_id, error: error.message, outcome_unknown: true, results: [], frames: [], events: []});
        }
      }
    } catch (error) {
      current = null;
      await setStatus('disconnected', error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

setInterval(() => self.postMessage({type: 'worker_heartbeat', at: Date.now()}), 5000);
setInterval(() => { void publish(); }, 10000);
self.postMessage({type: 'worker_heartbeat', at: Date.now()});
void run();
