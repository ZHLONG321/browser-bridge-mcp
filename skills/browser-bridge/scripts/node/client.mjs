import {randomUUID} from 'node:crypto';

export const defaultUrl = () => process.env.BROWSER_BRIDGE_URL || 'http://127.0.0.1:30003';

export async function http(path, {url = defaultUrl(), payload, timeoutMs = 35000} = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('Use a loopback HTTP service URL with no path or credentials.');
  const response = await fetch(new URL(path, url), {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {'X-Browser-Bridge-Client': '1', 'Content-Type': 'application/json'},
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message || `HTTP ${response.status}`), {status: response.status, details: body});
  return body;
}

export const profiles = ({service_url = defaultUrl()} = {}) => http('/profiles', {url: service_url});
export const discover = ({service_url = defaultUrl(), ...payload} = {}) => typeof payload.connection_id === 'string' && payload.connection_id.startsWith('browser-extension:')
  ? request('webextension', {...payload, service_url, action: 'describe', path: payload.namespace ?? ''})
  : http('/discover', {url: service_url, payload, timeoutMs: (payload.wait_ms ?? 500) + 10000});
export const rdp = ({service_url = defaultUrl(), ...payload}) => http('/rdp', {url: service_url, payload, timeoutMs: (payload.wait_ms ?? 500) + 10000});

function selectionQuery(profile_id, context) {
  if (!profile_id || !['normal', 'private'].includes(context)) throw new Error('Explicit profile_id and normal/private context are required on every call.');
  return new URLSearchParams({profile_id, context});
}

export function tabs({profile_id, context, window_id, service_url = defaultUrl()}) {
  const query = selectionQuery(profile_id, context);
  if (window_id !== undefined) query.set('window_id', String(window_id));
  return http(`/tabs?${query}`, {url: service_url});
}
export const find_tabs = ({match = {}, query = '', service_url = defaultUrl()} = {}) => http('/find-tabs', {url: service_url, payload: {match, query}});

export async function request(operation, {profile_id, context, service_url = defaultUrl(), ...payload}) {
  const query = selectionQuery(profile_id, context);
  const job_id = payload.job_id ?? randomUUID();
  try {
    const result = await http(`/request?${query}`, {
      url: service_url, payload: {...payload, job_id, operation}, timeoutMs: (payload.timeout_ms ?? 30000) + 5000,
    });
    await acknowledge({profile_id, context, job_id, tab_id: payload.tab_id, window_id: payload.window_id, receipt_id: result.receipt_id}, service_url);
    return result;
  } catch (error) {
    error.details = {...(!error.status ? {code: 'TRANSPORT_ERROR', outcome_unknown: true} : error.status >= 500 ? {outcome_unknown: true} : {}), ...error.details, job_id};
    if (error.details.terminal === true) await acknowledge({profile_id, context, job_id, tab_id: payload.tab_id, window_id: payload.window_id, receipt_id: error.details.receipt_id}, service_url);
    throw error;
  }
}

async function acknowledge(selection, service_url) {
  // Receipt only: failure retains the server's result, never fails or replays an operation.
  try {await http('/job-ack', {url: service_url, payload: selection, timeoutMs: 3000});} catch {}
}
export async function job_status({profile_id, context, job_id, tab_id, window_id, service_url = defaultUrl()}) {
  selectionQuery(profile_id, context);
  const fields = {profile_id, context, job_id, tab_id, window_id};
  const value = await http('/job', {url: service_url, payload: fields});
  if (value.result || value.terminal && value.error) await acknowledge({...fields, receipt_id: value.receipt_id}, service_url);
  return value;
}

export const javascript = fields => request('javascript', fields);
export const list_frames = fields => request('list_frames', fields);
export const cdp = fields => request('cdp', fields);
export const tab_control = fields => request('tab_control', fields);
export const window_control = fields => request('window_control', fields);
export const debugging = fields => request('debugging', fields);
export const userscript = fields => request('userscript', fields);
export const webextension = fields => request('webextension', fields);

// Keep the core transport dependency-free; file media helpers load on demand.
export const screenshot = async fields => (await import('./screenshots.mjs')).screenshot(fields);
export const recording_start = async fields => (await import('./recordings.mjs')).recording_start(fields);
export const recording_status = async fields => (await import('./recordings.mjs')).recording_status(fields);
export const recording_stop = async fields => (await import('./recordings.mjs')).recording_stop(fields);
export const recording_result = async fields => (await import('./recordings.mjs')).recording_result(fields);
