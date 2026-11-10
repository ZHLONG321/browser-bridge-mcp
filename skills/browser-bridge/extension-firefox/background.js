"use strict";

// Firefox MV2 keeps the background page alive without Chromium offscreen APIs.
let transport = null;
let config = { bridgeBaseUrl: "", enabled: false };
let profileId = "";
let status = { state: "not_configured", error: "" };
const subscriptions = new Map();
const handles = new Map();
const events = [];
let eventSequence = 0;
let eventBytes = 0;
let eventChain = Promise.resolve();
let snapshotPending = false;
let snapshotAgain = false;
const EVENT_BYTES_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiPath(path) {
  const parts = path ? path.split(".") : [];
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new Error("Invalid API path");
  }
  let value = browser;
  let parent = null;
  if (parts[0] === "handles") {
    parts.shift();
    value = handles.get(parts.shift());
    if (!value) throw new Error("Native object handle expired or unknown");
  }
  for (const part of parts) {
    parent = value;
    value = value?.[part];
    if (value === undefined || value === null) throw new Error(`API unavailable: ${path}; check permissions and Firefox version`);
  }
  return { parent, value };
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;
}

function toBase64(value) {
  const bytes = new Uint8Array(value);
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(text);
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$function === "string") {
      // Explicit native-function argument, only accepted over the authenticated
      // loopback bridge while the user has enabled privileged native control.
      const result = (0, eval)(`(${value.$function}\n)`);
      if (typeof result !== "function") throw new Error("$function must be a JavaScript function expression");
      return result;
    }
    if (keys.length === 1 && typeof value.$base64 === "string") return fromBase64(value.$base64);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function members(value) {
  const names = new Set(Object.keys(value || {}));
  const prototype = value && Object.getPrototypeOf(value);
  if (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) names.add(name);
  }
  return [...names].filter((name) => !["constructor", "__proto__", "prototype"].includes(name)).sort();
}

async function encode(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return { $bigint: String(value) };
  if (typeof value === "function") {
    const id = crypto.randomUUID();
    handles.set(id, { call: value });
    return { $handle: id, methods: ["call"] };
  }
  if (typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return { $base64: toBase64(value) };
  if (ArrayBuffer.isView(value)) return { $base64: toBase64(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
  if (value instanceof Blob) return { $base64: toBase64(await value.arrayBuffer()), type: value.type };
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = [];
      for (const item of value) output.push(await encode(item, seen));
      return output;
    }
    const keys = members(value);
    const methods = keys.filter((key) => typeof value[key] === "function");
    const output = {};
    if (methods.length) {
      const id = crypto.randomUUID();
      handles.set(id, value);
      output.$handle = id;
      output.methods = methods;
    }
    for (const key of Object.keys(value)) {
      if (typeof value[key] !== "function") output[key] = await encode(value[key], seen);
    }
    return output;
  } finally { seen.delete(value); }
}

function appendEvent(entry) {
  const size = encoder.encode(JSON.stringify(entry)).length;
  events.push({ sequence: ++eventSequence, ...entry, _bytes: size });
  eventBytes += size;
  while (eventBytes > EVENT_BYTES_LIMIT && events.length) eventBytes -= events.shift()._bytes;
}

function clearSubscriptions() {
  for (const { event, listener } of subscriptions.values()) {
    try { event.removeListener(listener); } catch { /* Already revoked by Firefox. */ }
  }
  subscriptions.clear();
  handles.clear();
}

async function nativeRequest(request) {
  if (!config.enabled) throw new Error("Native control is disabled in Firefox Browser Bridge options");
  if (request.action === "events") {
    if (request.after > eventSequence) throw new Error("Event cursor is beyond this extension's current sequence");
    if (request.wait_ms) await sleep(request.wait_ms);
    await eventChain;
    const oldest = events.length ? events[0].sequence : eventSequence + 1;
    return { events: events.filter((item) => item.sequence > request.after).map(({ _bytes, ...item }) => item),
      next_cursor: eventSequence, oldest_cursor: oldest, gap: request.after < oldest - 1,
      retained_bytes_limit: EVENT_BYTES_LIMIT };
  }
  if (request.action === "unwatch") {
    const item = subscriptions.get(request.subscription_id);
    if (!item) throw new Error("Unknown subscription_id");
    item.event.removeListener(item.listener);
    subscriptions.delete(request.subscription_id);
    return { removed: true };
  }
  if (request.action === "release") {
    const parts = request.path.split(".");
    if (parts.length !== 2 || parts[0] !== "handles" || !handles.delete(parts[1])) throw new Error("Use path handles.<id> to release a known handle");
    return { released: true };
  }
  if (request.action === "describe" && request.path === "handles") {
    return { handles: [...handles].map(([id, value]) => ({ id, members: members(value) })) };
  }
  const { parent, value } = apiPath(request.path);
  if (request.action === "describe") {
    const entries = members(value).map((name) => {
      try {
        const item = value[name];
        return { name, kind: typeof item === "function" ? "method" : item?.addListener ? "event" : typeof item };
      } catch (error) { return { name, kind: "unavailable", error: String(error) }; }
    });
    return { browser: await browser.runtime.getBrowserInfo(), profile_id: profileId, namespace: request.path,
      members: entries, permissions: await browser.permissions.getAll(),
      subscriptions: [...subscriptions].map(([id, item]) => ({ id, path: item.path })),
      documentation: "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API" };
  }
  const args = decode(request.args || []);
  if (request.action === "watch") {
    if (!value?.addListener || !value?.removeListener) throw new Error("API path is not a native event");
    const id = crypto.randomUUID();
    const listener = (...eventArgs) => {
      eventChain = eventChain.then(async () => appendEvent({ subscription_id: id, path: request.path, args: await encode(eventArgs) }))
        .catch((error) => appendEvent({ subscription_id: id, path: request.path, error: String(error) }));
    };
    value.addListener(listener, ...args);
    subscriptions.set(id, { event: value, listener, path: request.path });
    return { subscription_id: id, next_cursor: eventSequence };
  }
  if (request.action !== "call" || typeof value !== "function") throw new Error("API path is not a native method");
  return await encode(await value.apply(parent, args));
}


function normalizedBase(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a loopback HTTP service origin without a path");
  return url.origin;
}

async function inventory(current) {
  const [tabs, windows, privateAllowed] = await Promise.all([browser.tabs.query({}), browser.windows.getAll(), browser.extension.isAllowedIncognitoAccess()]);
  return {
    profile_id: profileId, instance_id: current.id, browser: "firefox",
    private_allowed: privateAllowed, debugging_enabled: config.enabled,
    windows: windows.map(w => ({window_id: w.id, incognito: w.incognito, focused: w.focused, type: w.type, state: w.state})),
    tabs: tabs.map(t => ({tab_id: "firefox-tab:" + profileId + ":" + t.id, browser_tab_id: t.id, profile_id: profileId, browser: "firefox", url: t.url || "about:blank", title: t.title || "", window_id: t.windowId, tab_index: t.index, active: t.active, pinned: t.pinned, incognito: t.incognito}))
  };
}

async function post(current, route, results = []) {
  const response = await fetch(current.base + route, {
    method: "POST", headers: {"Content-Type": "application/json", "X-Browser-Bridge-Secret": current.secret},
    body: JSON.stringify({...await inventory(current), results}), signal: current.controller.signal
  });
  if (!response.ok) throw new Error("Browser Bridge HTTP " + response.status);
  const reply = await response.json();
  for (const id of reply.acknowledged || []) current.results.delete(id);
  return reply;
}

async function publishSnapshot() {
  if (snapshotPending) {snapshotAgain = true; return;}
  snapshotPending = true;
  try {
    do {
      snapshotAgain = false;
      const current = transport;
      if (current) await post(current, "/extension/snapshot", [...current.results.values()]);
    } while (snapshotAgain);
  } finally {snapshotPending = false;}
}

async function executeJob(current, job) {
  const result = {job_id: job.job_id, ...(job.tab_id === undefined ? {} : {tab_id: job.tab_id})};
  try {
    if (job.profile_id !== profileId || job.connection_id !== "browser-extension:" + current.id || !["normal", "private"].includes(job.context)) throw new Error("Profile, connection or privacy selection mismatch");
    if (job.deadline_at <= Date.now()) throw new Error("Job expired before execution");
    if (job.kind !== "webextension") throw new Error("Use Firefox native WebExtension operations");
    if (job.window_id !== undefined) {
      const window = await browser.windows.get(job.window_id);
      if (window.incognito !== (job.context === "private")) throw new Error("Window privacy context mismatch");
    }
    if (job.tab_id !== undefined) {
      const prefix = "firefox-tab:" + profileId + ":";
      if (!job.tab_id.startsWith(prefix)) throw new Error("Tab belongs to another profile");
      const tab = await browser.tabs.get(Number(job.tab_id.slice(prefix.length)));
      if (tab.incognito !== (job.context === "private")) throw new Error("Tab belongs to the other privacy context");
      if (job.window_id !== undefined && tab.windowId !== job.window_id) throw new Error("Window selection mismatch");
    }
    const args = job.args || [];
    const options = args[args.length - 1] || {};
    const opensTab = job.path === "tabs.create" && options.active !== false;
    // focused:false needs the Windows client guard for background-only creation.
    const opensWindow = job.path === "windows.create" && options.focused !== false;
    const activates = job.path === "tabs.highlight" || job.path === "runtime.openOptionsPage" || job.path === "tabs.update" && options.active === true || job.path === "windows.update" && (options.focused === true || options.state && options.state !== "minimized");
    if (job.action === "call" && (opensTab || opensWindow || activates) && job.allow_foreground !== true) throw new Error("Foreground operation requires explicit user permission and allow_foreground: true");
    if (job.action === "call" && job.path === "tabs.remove" && job.allow_foreground !== true) {
      const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
      for (const id of ids) {
        const tab = await browser.tabs.get(id), window = await browser.windows.get(tab.windowId);
        if (tab.active && window.focused) throw new Error("Closing the foreground tab requires permission");
      }
    }
    result.value = await nativeRequest({...job, after: job.after ?? 0, wait_ms: job.wait_ms ?? 0});
    result.status = "completed";
  } catch (error) {result.status = "failed"; result.error = String(error?.message || error);}
  if (transport === current) {
    current.results.set(job.job_id, result);
    void publishSnapshot().catch(() => current.controller.abort());
  }
}

async function session(base) {
  const controller = new AbortController();
  const response = await fetch(base + "/extension/bootstrap", {cache: "no-store", signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error("Browser Bridge HTTP " + response.status);
  const bootstrap = await response.json();
  if (typeof bootstrap.secret !== "string") throw new Error("Missing Browser Bridge bootstrap secret");
  const current = {base, secret: bootstrap.secret, id: crypto.randomUUID(), controller, results: new Map()};
  transport = current;
  const heartbeat = setInterval(() => {void publishSnapshot().catch(() => controller.abort());}, 10000);
  try {
    await post(current, "/extension/snapshot");
    status = {state: "connected", error: ""};
    while (!controller.signal.aborted) {
      const reply = await post(current, "/extension/poll", [...current.results.values()]);
      for (const job of reply.jobs || []) void executeJob(current, job);
    }
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    if (transport === current) transport = null;
    clearSubscriptions();
  }
}

async function run() {
  const stored = await browser.storage.local.get(["profileId", "bridgeBaseUrl", "enabled"]);
  profileId = stored.profileId || crypto.randomUUID();
  await browser.storage.local.set({profileId});
  config = {bridgeBaseUrl: stored.bridgeBaseUrl || "http://127.0.0.1:30003", enabled: stored.enabled === true};
  let attempts = 0;
  while (true) {
    const started = Date.now();
    try {await session(normalizedBase(config.bridgeBaseUrl));}
    catch (error) {status = {state: "disconnected", error: String(error?.message || error)};}
    if (Date.now() - started > 30000) attempts = 0;
    await sleep(Math.min(10000, 1000 * (2 ** Math.min(attempts++, 4))));
  }
}

for (const event of [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onUpdated, browser.tabs.onMoved, browser.tabs.onAttached, browser.tabs.onActivated, browser.windows.onCreated, browser.windows.onRemoved, browser.permissions.onAdded, browser.permissions.onRemoved]) {
  event.addListener(() => {void publishSnapshot().catch(() => transport?.controller.abort());});
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) {config.enabled = changes.enabled.newValue === true; if (!config.enabled) clearSubscriptions();}
  if (changes.bridgeBaseUrl) config.bridgeBaseUrl = changes.bridgeBaseUrl.newValue || "";
  if (changes.bridgeBaseUrl) transport?.controller.abort();
  void publishSnapshot().catch(() => transport?.controller.abort());
});
browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.url !== browser.runtime.getURL("options.html")) return undefined;
  if (message.type === "status") return Promise.resolve({...status, profile_id: profileId, connection_id: transport ? "browser-extension:" + transport.id : null, enabled: config.enabled});
  return undefined;
});
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());
void run().catch(error => {status = {state: "failed", error: String(error)};});
