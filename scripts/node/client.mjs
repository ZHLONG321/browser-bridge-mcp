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
export const discover = ({service_url = defaultUrl(), ...payload} = {}) => http('/discover', {url: service_url, payload, timeoutMs: (payload.wait_ms ?? 500) + 10000});
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

export function request(operation, {profile_id, context, service_url = defaultUrl(), ...payload}) {
  return http(`/request?${selectionQuery(profile_id, context)}`, {
    url: service_url, payload: {...payload, operation}, timeoutMs: (payload.timeout_ms ?? 30000) + 5000,
  });
}

export const javascript = fields => request('javascript', fields);
export const list_frames = fields => request('list_frames', fields);
export const cdp = fields => request('cdp', fields);
export const tab_control = fields => request('tab_control', fields);
export const window_control = fields => request('window_control', fields);
export const debugging = fields => request('debugging', fields);
export const userscript = fields => request('userscript', fields);
export const webextension = fields => request('webextension', fields);
