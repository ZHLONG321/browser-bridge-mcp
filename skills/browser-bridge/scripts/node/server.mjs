import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { RdpManager, NativeError } from './rdp.mjs';
import { extensionSockets } from './extension-socket.mjs';

const SERVICE = 'browser-bridge-skill';
const options = parseArgs({options: {session: {type: 'string'}, port: {type: 'string', default: '30003'}, serve: {type: 'boolean', default: false}}}).values;
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1..65535.');
if (!options.session || options.session === '.' || options.session === '..' || basename(options.session) !== options.session || /[\\/:\0]/.test(options.session)) throw new Error('Supply --session with one session-directory name.');

if (!options.serve) {
  const directory = join(tmpdir(), options.session, 'browser bridge');
  mkdirSync(directory, {recursive: true});
  const log = join(directory, 'server.log');
  const descriptor = openSync(log, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', '--session', options.session, '--port', String(port)], {
    detached: true, windowsHide: true, stdio: ['ignore', descriptor, descriptor, 'ipc'],
  });
  closeSync(descriptor);
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({error: 'Startup acknowledgement timed out; inspect the log before starting another process.'}), 5000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); resolve({error: error.message}); });
    child.once('exit', code => { clearTimeout(timer); resolve({error: `Server exited (${code}); inspect the log.`}); });
  });
  if (child.connected) child.disconnect();
  child.unref();
  console.log(JSON.stringify({...outcome, log}));
  if (outcome.error) process.exitCode = 1;
} else {
  const secret = randomBytes(32).toString('hex');
  const profiles = new Map();
  const pending = new Map();
  const rdp = new RdpManager();
  class Failure extends Error {
    constructor(status, code, message, extra = {}) { super(message); Object.assign(this, {status, code, extra: {...extra, ...(extra.terminal ? {receipt_id: randomUUID()} : {})}}); }
  }
  const fail = (status, code, message, extra) => { throw new Failure(status, code, message, extra); };
  const send = (response, status, body) => {
    response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(JSON.stringify(body));
  };
  const log = (event, values = {}) => console.log(JSON.stringify({at: new Date().toISOString(), event, ...values}));
  const live = profile => profile.socket?.readyState === 1 && Date.now() - profile.seen < 45000;
  const selected = url => {
    const id = url.searchParams.get('profile_id');
    const context = url.searchParams.get('context');
    if (!id || !['normal', 'private'].includes(context)) fail(400, 'SELECTION_REQUIRED', 'Explicit profile_id and normal/private context are required.');
    const profile = profiles.get(id);
    if (!profile || !live(profile)) fail(404, 'PROFILE_NOT_CONNECTED', 'The selected profile is not connected. Enumerate profiles again.');
    return {profile, context, id};
  };
  const tokenValid = value => typeof value === 'string' && value.length === secret.length && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  function snapshot(body) {
    if (typeof body.profile_id !== 'string' || typeof body.instance_id !== 'string' || !Array.isArray(body.tabs) || !Array.isArray(body.windows)) fail(400, 'INVALID_SNAPSHOT', 'Invalid extension inventory.');
    let profile = profiles.get(body.profile_id);
    if (!profile || profile.instance !== body.instance_id) {
      const retired = new Set(profile?.retired || []);
      if (retired.has(body.instance_id)) fail(409, 'STALE_EXECUTION_CONTEXT', 'A retired extension execution context cannot replace the current one.');
      if (profile) {
        retired.add(profile.instance);
        for (const jobId of profile.active) {
          const entry = pending.get(jobId);
          if (!entry || entry.finished || entry.error) continue;
          entry.error = new Failure(409, 'EXTENSION_RESTARTED', 'The extension execution context restarted; inspect dispatched work before repeating it.', {job_id: entry.job.job_id, outcome_unknown: entry.dispatched, terminal: true});
          entry.reject?.(entry.error);
        }
        profile.socket?.close(1000, 'Execution context replaced');
      }
      profile = {identity: body.profile_id, instance: body.instance_id, socket: null, retired, active: new Set()};
      profiles.set(body.profile_id, profile);
    }
    Object.assign(profile, {seen: Date.now(), tabs: body.tabs, windows: body.windows, browser: body.browser || 'chromium', extension_version: body.extension_version, private_allowed: body.private_allowed === true, debugging_enabled: body.debugging_enabled === true});
    return profile;
  }
  const extensionInventory = () => [...profiles.entries()].filter(([, p]) => live(p)).map(([id, p]) => ({profile_id: id, connection_id: `browser-extension:${p.instance}`, browser: p.browser, protocol: p.browser === 'firefox' ? 'webextension' : 'cdp', capabilities: p.browser === 'firefox' ? ['webextension'] : ['javascript', 'list_frames', 'cdp', 'tab_control', 'window_control', 'userscript', 'debugging'], connected: true, extension_transport: 'websocket', extension_protocol: 2, extension_version: p.extension_version, private_allowed: p.private_allowed, debugging_enabled: p.debugging_enabled, windows: p.windows}));
  const inventory = () => ({status: 'completed', connections: [...extensionInventory(), ...rdp.inventory()]});
  function findTabs(body) {
    const match = body.match === undefined ? {} : body.match;
    const query = body.query === undefined ? '' : body.query;
    if (!match || typeof match !== 'object' || Array.isArray(match) || Object.values(match).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)) || typeof query !== 'string') fail(400, 'INVALID_MATCH', 'match must contain scalar metadata values; query must be a string.');
    const needle = query.toLowerCase();
    const matches = [];
    for (const [id, profile] of profiles) {
      if (!live(profile)) continue;
      for (const tab of profile.tabs) {
        const row = {...tab, profile_id: id, connection_id: `browser-extension:${profile.instance}`, browser: profile.browser, context: tab.incognito ? 'private' : 'normal'};
        if (Object.entries(match).every(([key, value]) => Object.hasOwn(row, key) && row[key] === value) && Object.values(row).some(value => String(value).toLowerCase().includes(needle))) matches.push(row);
      }
    }
    return {status: 'completed', matches};
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) fail(403, 'HOST_FORBIDDEN', 'Use the configured loopback address.');
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const extensionRoute = url.pathname.startsWith('/extension/');
      const origin = request.headers.origin;
      if (extensionRoute) {
        if (origin && !/^(chrome-extension:\/\/[a-p]+|moz-extension:\/\/[a-f0-9-]+)$/i.test(origin)) fail(403, 'ORIGIN_FORBIDDEN', 'Only extension origins may use this route.');
        if (url.pathname !== '/extension/bootstrap' && !tokenValid(request.headers['x-browser-bridge-secret'])) fail(401, 'INVALID_SECRET', 'Reconnect the extension.');
      } else if (origin || (url.pathname !== '/probe' && request.headers['x-browser-bridge-client'] !== '1')) fail(403, 'CLIENT_HEADER_REQUIRED', 'Use the CLI or client module.');
      if (request.method === 'GET' && url.pathname === '/probe') return send(response, 200, {service: SERVICE, version: 1, pid: process.pid, extension_transport: 'websocket', extension_protocol: 2, service_instance_id: transport.serviceInstance});
      if (request.method === 'GET' && url.pathname === '/extension/bootstrap') return send(response, 200, {secret, protocol: 2});
      if (request.method === 'GET' && url.pathname === '/profiles') return send(response, 200, {profiles: extensionInventory()});
      if (request.method === 'GET' && url.pathname === '/discover') return send(response, 200, inventory());
      if (request.method === 'GET' && url.pathname === '/tabs') {
        const {profile, context, id} = selected(url);
        const windowId = url.searchParams.has('window_id') ? Number(url.searchParams.get('window_id')) : undefined;
        if (windowId !== undefined && !Number.isSafeInteger(windowId)) fail(400, 'INVALID_WINDOW', 'window_id must be an integer.');
        return send(response, 200, {profile_id: id, context, tabs: profile.tabs.filter(tab => tab.incognito === (context === 'private') && (windowId === undefined || tab.window_id === windowId))});
      }
      if (request.method !== 'POST') fail(404, 'NOT_FOUND', 'Unknown service route.');
      let text = '';
      request.setEncoding('utf8');
      for await (const chunk of request) text += chunk;
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'INVALID_JSON', 'Provide UTF-8 JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'The request body must be an object.');
      if (url.pathname === '/job' || url.pathname === '/job-ack') {
        const entry = pending.get(body.job_id);
        if (!entry) fail(404, 'JOB_NOT_FOUND', 'This service has no record of the job. Do not infer that it did not execute.');
        const job = entry.job;
        if (['profile_id', 'context', 'tab_id', 'window_id'].some(key => body[key] !== job[key])) fail(409, 'JOB_SELECTION_MISMATCH', 'Repeat the exact original profile, privacy, tab and window selection.');
        if (url.pathname === '/job-ack') {
          if (!entry.finished && !entry.error) fail(409, 'JOB_NOT_COMPLETE', 'Only a final result or terminal service error can be acknowledged.');
          const receipt = entry.finished ? entry.receiptId : entry.error.extra.receipt_id;
          if (body.receipt_id !== receipt) fail(409, 'JOB_RECEIPT_MISMATCH', 'Acknowledge only the receipt_id you actually received. Query the current result before another acknowledgement.');
          entry.result = null; entry.delivered = true;
          entry.resolve = null; entry.reject = null;
          entry.job = Object.fromEntries(['job_id', 'profile_id', 'context', 'tab_id', 'window_id', 'kind', 'deadline_at'].filter(key => job[key] !== undefined).map(key => [key, job[key]]));
          return send(response, 200, {job_id: job.job_id, acknowledged: true});
        }
        const unknown = entry.finished ? entry.outcomeUnknown : entry.error?.extra?.outcome_unknown ?? entry.dispatched;
        return send(response, 200, {job_id: job.job_id, phase: entry.phase,
          status: entry.finished ? (unknown ? 'outcome_unknown' : 'completed') : entry.error ? 'failed' : entry.dispatched ? 'dispatched' : 'queued',
          outcome_unknown: unknown,
          terminal: entry.finished === true || Boolean(entry.error),
          ...(entry.finished || entry.error ? {receipt_id: entry.finished ? entry.receiptId : entry.error.extra.receipt_id} : {}),
          result_delivered: entry.delivered === true,
          ...(entry.result ? {result: entry.result} : {}), ...(entry.error ? {error: {code: entry.error.code, message: entry.error.message, ...entry.error.extra}} : {})});
      }
      if (url.pathname === '/find-tabs') return send(response, 200, findTabs(body));
      if (url.pathname === '/rdp') return send(response, 200, await rdp.execute(body));
      if (url.pathname === '/discover') {
        if (typeof body.connection_id === 'string' && body.connection_id.startsWith('browser-extension:')) {
          url.pathname = '/request';
          url.searchParams.set('profile_id', body.profile_id || '');
          url.searchParams.set('context', body.context || '');
          body = {...body, operation: 'webextension', action: 'describe', path: body.namespace || ''};
        } else if (body.connection_id || body.rdp_port !== undefined || body.actor) return send(response, 200, await rdp.discover(body));
        else return send(response, 200, inventory());
      }
      if (url.pathname === '/shutdown') {
        // Flush the acknowledgement before disconnecting shared transports.
        response.once('finish', () => server.closeAllConnections());
        send(response, 200, {stopping: true});
        transport.close();
        for (const entry of pending.values()) if (!entry.finished && !entry.error) entry.reject?.(new Failure(409, 'SERVER_STOPPING', 'Service stopping; inspect dispatched work before repeating it.', {job_id: entry.job.job_id, outcome_unknown: entry.dispatched}));
        rdp.close();
        server.close();
        return;
      }
      if (url.pathname === '/extension/snapshot' || url.pathname === '/extension/poll') fail(409, 'EXTENSION_UPGRADE_REQUIRED', 'This service requires extension WebSocket protocol 2. Load the matching extension version once.');
      if (url.pathname !== '/request') fail(404, 'NOT_FOUND', 'Unknown service route.');
      const {profile, context, id} = selected(url);
      const operation = body.operation;
      const native = operation === 'webextension';
      if (native && (profile.browser !== 'firefox' || body.connection_id !== `browser-extension:${profile.instance}`)) fail(409, 'CONNECTION_MISMATCH', 'Use the selected live Firefox extension connection_id from discover.');
      if (!native && profile.browser === 'firefox') fail(400, 'UNSUPPORTED_OPERATION', 'Use Firefox webextension or its separate RDP connection; Chromium operations do not apply.');
      const tab = profile.tabs.find(item => item.tab_id === body.tab_id);
      if ((!native && !['window_control', 'debugging'].includes(operation) || operation === 'debugging' && body.action === 'enable' || body.tab_id !== undefined) && !tab) fail(404, 'TAB_NOT_FOUND', 'The tab is not visible in this profile. Enumerate tabs again.');
      if (tab && tab.incognito !== (context === 'private')) fail(409, 'CONTEXT_MISMATCH', 'The tab belongs to the other window privacy context.');
      if (body.window_id !== undefined) {
        if (!Number.isSafeInteger(body.window_id)) fail(400, 'INVALID_WINDOW', 'window_id must be an integer.');
        if (!profile.windows.some(window => window.window_id === body.window_id && window.incognito === (context === 'private')) || tab && tab.window_id !== body.window_id) fail(409, 'WINDOW_MISMATCH', 'The target does not belong to the requested window and privacy context.');
      }
      if (!['javascript', 'list_frames', 'cdp', 'tab_control', 'window_control', 'userscript', 'webextension', 'debugging'].includes(operation)) fail(400, 'UNKNOWN_OPERATION', 'Use a documented browser operation.');
      if (operation === 'debugging') {
        if (!['status', 'enable'].includes(body.action)) fail(400, 'INVALID_ACTION', 'Use debugging action status or enable.');
        if (body.action === 'enable' && context === 'private' && !profile.private_allowed) fail(403, 'PRIVATE_ACCESS_REQUIRED', 'Enable Allow in Incognito / Allow in InPrivate for the selected extension.');
      }
      if (operation === 'window_control') {
        if (!['create', 'close'].includes(body.action)) fail(400, 'INVALID_ACTION', 'Use window action create or close.');
        if (body.action === 'close' && body.window_id === undefined) fail(400, 'INVALID_WINDOW', 'Closing a window requires an exact window_id.');
        if (context === 'private' && !profile.private_allowed) fail(403, 'PRIVATE_ACCESS_REQUIRED', 'Enable Allow in Incognito / Allow in InPrivate for the selected extension.');
      }
      if (native) {
        const action = body.action ?? 'call';
        if (!['call', 'describe', 'watch', 'unwatch', 'events', 'release'].includes(action)) fail(400, 'INVALID_ACTION', 'Unknown WebExtension action.');
        if (body.path !== undefined && typeof body.path !== 'string') fail(400, 'INVALID_PATH', 'path must be a string.');
        if (['call', 'watch', 'release'].includes(action) && (typeof body.path !== 'string' || !body.path)) fail(400, 'INVALID_PATH', 'This action requires path.');
        if (body.args !== undefined && !Array.isArray(body.args)) fail(400, 'INVALID_ARGS', 'args must be positional arguments in an array.');
        if (action === 'unwatch' && typeof body.subscription_id !== 'string') fail(400, 'INVALID_SUBSCRIPTION', 'unwatch requires subscription_id.');
        if (body.after !== undefined && (!Number.isSafeInteger(body.after) || body.after < 0)) fail(400, 'INVALID_CURSOR', 'after must be a nonnegative integer.');
        if (body.wait_ms !== undefined && (!Number.isInteger(body.wait_ms) || body.wait_ms < 0 || body.wait_ms > 15000)) fail(400, 'INVALID_WAIT', 'wait_ms must be 0..15000.');
        body.action = action;
      }
      if (!['tab_control', 'window_control', 'debugging'].includes(operation) && !profile.debugging_enabled) fail(409, 'DEBUGGING_DISABLED', 'Use debugging action enable with authorized_mutation for the resolved target, or enable debugging in extension controls.');
      if (operation === 'javascript' && (!Array.isArray(body.scripts) || !body.scripts.length || body.scripts.some(script => typeof script !== 'string'))) fail(400, 'INVALID_SCRIPTS', 'scripts must be a nonempty array of strings.');
      if (operation === 'cdp' && (!Array.isArray(body.commands) || !body.commands.length || body.commands.some(command => typeof command?.method !== 'string' || !command.method))) fail(400, 'INVALID_COMMANDS', 'commands must contain CDP method/params objects.');
      const mode = body.mode ?? 'read_only';
      if (!['read_only', 'authorized_mutation'].includes(mode)) fail(400, 'INVALID_MODE', 'Use read_only or authorized_mutation.');
      if (body.allow_foreground !== undefined && typeof body.allow_foreground !== 'boolean') fail(400, 'INVALID_FOREGROUND_FLAG', 'allow_foreground must be a boolean.');
      if ((['tab_control', 'window_control'].includes(operation) || operation === 'debugging' && body.action === 'enable' || operation === 'userscript' && !['list', 'list_commands'].includes(body.userscript_action)) && mode !== 'authorized_mutation') fail(403, 'MUTATION_NOT_AUTHORIZED', 'This operation requires authorized_mutation.');
      const timeout = body.timeout_ms ?? 30000;
      if (!Number.isFinite(timeout) || timeout <= 0) fail(400, 'INVALID_TIMEOUT', 'timeout_ms must be positive.');
      const jobId = body.job_id ?? randomUUID();
      if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) fail(400, 'INVALID_JOB_ID', 'job_id must be a UUID.');
      if (pending.has(jobId)) fail(409, 'JOB_ALREADY_EXISTS', 'Inspect this job with /job; it will not be executed again.', {job_id: jobId});
      const job = {...body, kind: operation, mode, job_id: jobId, profile_id: id, context, deadline_at: Date.now() + timeout};
      if (operation === 'tab_control') job.tab_control = {...body, target_tab_id: body.tab_id, context};
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = pending.get(jobId);
          if (!entry) return;
          const error = new Failure(504, 'DEADLINE_EXCEEDED', 'The wait expired. Query this job before repeating any dispatched work.', {job_id: jobId, phase: entry.phase, outcome_unknown: entry.dispatched, terminal: !entry.dispatched});
          if (!entry.dispatched) {entry.error = error; profile.active.delete(jobId);}
          entry.reject(error);
        }, timeout + 1000); // Deliver the extension's deadline result before expiring the HTTP wait.
        const finish = callback => value => { clearTimeout(timer); callback(value); };
        pending.set(jobId, {profile: id, dispatched: false, phase: 'queued', job, resolve: finish(resolve), reject: finish(reject)});
        profile.active.add(jobId);
        transport.submit(profile);
      });
      log('completed', {job_id: jobId, profile_id: id, operation});
      send(response, 200, result);
    } catch (error) {
      if (!(error instanceof Failure || error instanceof NativeError)) log('request_failed', {type: error?.name || 'Error'});
      if (!response.headersSent && !response.destroyed) send(response, error.status || 500, {code: error.code || 'INTERNAL_ERROR', message: error instanceof Failure || error instanceof NativeError ? error.message : 'Service error; inspect server.log.', ...(error.extra || {})});
    }
  });
  const transport = extensionSockets(server, {port, tokenValid, profiles, pending, snapshot, Failure, log});
  server.on('error', error => {
    log('startup_failed', {code: error.code});
    process.send?.({error: error.code === 'EADDRINUSE' ? 'Port already in use; choose an explicit --port or inspect the existing service.' : error.code});
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    log('listening', {port, pid: process.pid});
    process.send?.({started: true, pid: process.pid, url: `http://127.0.0.1:${port}`});
  });
}
