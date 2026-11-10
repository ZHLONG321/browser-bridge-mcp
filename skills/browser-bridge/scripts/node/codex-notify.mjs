// Deliver to an existing local Codex host. Never launch another agent/server or
// turn a tool result into a user-authored message.
export function validateCodexNotification({app_server_url, thread_id}) {
  const url = new URL(app_server_url);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('codex_notify.app_server_url must be an existing loopback ws:// host with no path, credentials or query.');
  }
  if (typeof thread_id !== 'string' || !thread_id) throw Error('codex_notify.thread_id must identify the caller thread on that Codex host.');
  if (typeof globalThis.WebSocket !== 'function') throw Error('Codex completion notification requires a Node.js runtime with built-in WebSocket (Node.js 22+). Recording itself needs Node.js 20+.');
}

export async function deliverToolOutput(destination, toolOutput) {
  validateCodexNotification(destination);
  const socket = new WebSocket(destination.app_server_url);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = message => {
    for (const task of pending.values()) {clearTimeout(task.timer); task.reject(Error(message));}
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('Codex connection closed; notification delivery may be unknown.'));
  socket.addEventListener('error', () => rejectPending('Codex WebSocket connection failed.'));
  socket.addEventListener('message', event => {
    let message;
    try {message = JSON.parse(event.data);} catch {return;}
    if (message.method) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(Object.assign(Error(message.error.message), {code: message.error.code}));
    else task.resolve(message.result);
  });
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(id); reject(Error(`Codex ${method} response timed out; do not replay an uncertain notification.`));}, 10000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Codex WebSocket connection timed out.')), 10000);
      socket.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once: true});
      socket.addEventListener('error', () => {clearTimeout(timer); reject(Error('Cannot connect to the supplied Codex host.'));}, {once: true});
    });
    await request('initialize', {clientInfo: {name: 'browser_bridge_completion', title: 'Browser Bridge completion', version: '1.0.0'}});
    socket.send(JSON.stringify({method: 'initialized', params: {}}));
    // Require an already-loaded thread on this host; do not resume it on a
    // different host, fork it or overwrite its model/settings.
    const current = await request('thread/read', {threadId: destination.thread_id});
    if (current.thread?.status?.type === 'notLoaded') throw Error('The target thread is not loaded on the supplied Codex host; notification was not submitted.');
    return await request('turn/start', {threadId: destination.thread_id, input: [], toolOutput});
  } finally {socket.close();}
}
