"use strict";

importScripts("debugger-session.js", "userscript-runtime.js", "tab-control.js", "socket-client.js");

const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:30003";
const PROTOCOL_VERSION = "1.3";
const TAB_ID_PREFIX = "chrome-tab:";
const MAX_RESULT_JSON_CHARS = 1024 * 1024;
const MAX_RESULT_PREVIEW_CHARS = 8192;
const MAX_EVENT_JSON_CHARS = 64 * 1024;
const MAX_EVENTS = 512;
const MAX_EVENT_TOTAL_JSON_CHARS = 1024 * 1024;
const MAX_FRAMES = 2048;
const FRAME_DISCOVERY_SETTLE_MS = 50;
const FRAME_DISCOVERY_MAX_MS = 500;
const FRAME_CONTEXT_TIMEOUT_MS = 1000;
const USERSCRIPT_BINDING_NAME = "__LOCAL_BRIDGE_USERSCRIPT_RPC__";
const MAX_USERSCRIPT_RPC_CHARS = 1024 * 1024;
const SOCKET_WATCHDOG_ALARM = "browser-bridge-socket-watchdog";
const EXTENSION_JOB_BATCH_TIMEOUT_MS = 17_000;

const debuggerScopes = new WeakMap();
function ownDebuggerLease(lease, scope) {
  debuggerScopes.set(lease.rootSession, {scope, valid: lease.valid});
  return lease.rootSession;
}
function inheritDebuggerScope(target, parent) {
  const owner = debuggerScopes.get(parent);
  if (owner) debuggerScopes.set(target, owner);
  return target;
}
function cleanupDebuggerTarget(target) {
  // Cleanup may release resources after a deadline, but only on the original
  // owned attachment. It never authorizes another normal job command.
  const owner = debuggerScopes.get(target);
  if (!owner || !owner.valid()) throw new Error("DEBUGGER_SESSION_CHANGED: Cleanup no longer owns this attachment.");
  const cleanup = {...target};
  debuggerScopes.set(cleanup, {valid: owner.valid});
  return cleanup;
}
function assertDebuggerScope(target) {
  const owner = debuggerScopes.get(target);
  owner?.scope?.check();
  if (owner && !owner.valid()) throw new Error("DEBUGGER_SESSION_CHANGED: The job no longer owns this attachment.");
}
async function sendDebuggerCommand(target, method, params, onLateResult) {
  assertDebuggerScope(target);
  const scope = debuggerScopes.get(target)?.scope;
  scope?.native("native:" + method);
  const pending = chrome.debugger.sendCommand(target, method, params).then(value => {
    try {assertDebuggerScope(target);}
    catch (error) {
      if (onLateResult) void Promise.resolve().then(() => onLateResult(value)).catch(() => {});
      throw error;
    }
    return value;
  });
  let abort;
  try {
    const value = scope ? await Promise.race([pending, new Promise((_, reject) => {
      abort = () => reject(scope.signal.reason);
      scope.signal.addEventListener("abort", abort, {once: true});
    })]) : await pending;
    assertDebuggerScope(target);
    return value;
  } finally {if (abort) scope.signal.removeEventListener("abort", abort);}
}

const temporaryUserscripts = new Map();
const userscriptRequests = new Map();
let debuggingEnabled = false;
let debuggingSettingRevision = 0;
let debuggingControlRevision = 0;
let debuggingSettingsWrite = Promise.resolve();
const debuggerSettingsReady = chrome.storage.local.get({ debuggingEnabled: false }).then((stored) => {
  if (debuggingSettingRevision === 0) debuggingEnabled = stored.debuggingEnabled === true;
}).catch(() => { console.warn("Browser Bridge debugging setting unavailable; debugging remains disabled"); });

const debuggerSessions = globalThis.LocalBridgeDebuggerSession.create(chrome.debugger, PROTOCOL_VERSION, {
  isEnabled: async () => { await debuggerSettingsReady; return debuggingEnabled; },
  onStateChanged: notifyDebuggingStateChanged,
});

function notifyDebuggingStateChanged() {
  void chrome.runtime.sendMessage({ type: "debugging_state_changed" }).catch(() => {});
  notifyTransportTabsChanged();
}

async function debuggingState() {
  await debuggerSettingsReady;
  const attached = await debuggerSessions.attachedTabIds();
  return { enabled: debuggingEnabled, attached_tab_ids: attached.map(bridgeTabId) };
}

async function applyDebuggingSetting(enabled) {
  debuggingSettingRevision += 1;
  debuggingEnabled = enabled === true;
  console.info("Browser Bridge debugging", debuggingEnabled ? "enabled" : "disabled");
  if (!debuggingEnabled) await debuggerSessions.detachAll();
  notifyDebuggingStateChanged();
}

function persistDebuggingSetting(enabled, revision) {
  // Writes can complete after a later off/cancel. Serialize them and discard
  // superseded requests before they write, so a stale enable cannot win on restart.
  const write = debuggingSettingsWrite.catch(() => {}).then(async () => {
    if (revision !== debuggingControlRevision || debuggingEnabled !== enabled) return;
    await chrome.storage.local.set({ debuggingEnabled: enabled });
  });
  debuggingSettingsWrite = write;
  return write;
}

async function disableDebuggingFromBanner() {
  debuggingControlRevision += 1;
  // Block immediately, before the storage write or any automatic restore can run.
  await Promise.all([
    applyDebuggingSetting(false),
    persistDebuggingSetting(false, debuggingControlRevision),
  ]);
}

async function setDebuggingFromControl(enabled, targetTabId, scope) {
  scope?.check();
  if (typeof enabled !== "boolean") throw new Error("Debugging setting must be a boolean");
  // Separate target enables may run concurrently. Explicit UI controls or banner
  // cancellation supersede them, but enabling another tab does not cancel a job.
  const revision = targetTabId === undefined ? ++debuggingControlRevision : debuggingControlRevision;
  await debuggerSettingsReady;
  scope?.check();
  if (revision !== debuggingControlRevision) return { enabled: debuggingEnabled };
  const wasEnabled = debuggingEnabled;
  if (!enabled) {
    await disableDebuggingFromBanner();
    return { enabled: false };
  }
  scope?.native("native:debugging.preference");
  await applyDebuggingSetting(true);
  try {
    if (revision !== debuggingControlRevision) return { enabled: debuggingEnabled };
    if (targetTabId !== undefined) {
      // Persist the requested preference separately from this tab's connection outcome.
      scope?.check();
      await persistDebuggingSetting(true, revision);
      if (revision !== debuggingControlRevision || !debuggingEnabled) return { enabled: debuggingEnabled };
    }
    const eligible = tab => Number.isInteger(tab.id) && isDebuggableUrl(tab.url);
    let target;
    if (targetTabId !== undefined) {
      target = await chrome.tabs.get(targetTabId);
      if (!eligible(target)) throw new Error("The selected page does not support debugging.");
    } else {
      const selected = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      target = selected.find(eligible);
      if (!target) target = (await chrome.tabs.query({})).find(eligible);
    }
    if (!target) throw new Error("Open a web page before enabling debugging.");
    if (revision !== debuggingControlRevision) return { enabled: debuggingEnabled };
    scope?.check();
    const lease = await debuggerSessions.acquire(target.id, {signal: scope?.signal, progress: scope?.progress, beforeAttach: () => scope?.native("native:debugger.attach")});
    ownDebuggerLease(lease, scope);
    try {
      // A read-only operation establishes the attachment without reading page content.
      await sendDebuggerCommand(lease.rootSession, "Runtime.getIsolateId");
    } finally {
      await lease.release();
    }
    if (revision !== debuggingControlRevision || !debuggingEnabled) return { enabled: debuggingEnabled };
    if (targetTabId === undefined) await persistDebuggingSetting(true, revision);
    return { enabled: true };
  } catch (error) {
    // A manual off/cancel intentionally detaches pending commands. A superseded
    // enable must neither report that cancellation as a failure nor undo a newer setting.
    if (revision !== debuggingControlRevision || !debuggingEnabled) return { enabled: debuggingEnabled };
    // A failed connection to one target must not disable existing authorized sessions.
    if (!wasEnabled && targetTabId === undefined) await disableDebuggingFromBanner();
    throw error;
  }
}
const userscriptRuntime = globalThis.LocalBridgeUserscriptRuntime;
const tabControl = globalThis.LocalBridgeTabControl.create(chrome.tabs, chrome.storage?.session, TAB_ID_PREFIX, chrome.alarms);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  const text = error?.stack || error?.message || String(error);
  return text.length <= 16 * 1024 ? text : `${text.slice(0, 16 * 1024)}…`;
}

function boundedJsonValue(value, maxChars = MAX_RESULT_JSON_CHARS) {
  if (value === undefined) return { type: "undefined" };
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { type: "undefined" };
    if (serialized.length <= maxChars) return value;
    return {
      type: "result_truncated",
      original_json_chars: serialized.length,
      preview: serialized.slice(0, MAX_RESULT_PREVIEW_CHARS),
    };
  } catch (error) {
    return { type: "serialization_error", error: errorText(error) };
  }
}

function isDebuggableUrl(url) {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return ![
      "chrome:",
      "chrome-extension:",
      "devtools:",
      "edge:",
      "edge-extension:",
    ].includes(protocol);
  } catch {
    return false;
  }
}

function bridgeTabId(tabId) {
  return `${TAB_ID_PREFIX}${tabId}`;
}

function nativeTabId(tabId) {
  if (typeof tabId !== "string" || !tabId.startsWith(TAB_ID_PREFIX)) {
    throw new Error(`Unsupported extension tab ID: ${tabId}`);
  }
  const parsed = Number(tabId.slice(TAB_ID_PREFIX.length));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid extension tab ID: ${tabId}`);
  return parsed;
}

let profileIdentityReady = null;
function profileIdentity() {
  if (!profileIdentityReady) {
    profileIdentityReady = chrome.storage.local.get({ bridgeProfileId: "" }).then(async (stored) => {
      if (stored.bridgeProfileId) return stored.bridgeProfileId;
      const identity = crypto.randomUUID();
      await chrome.storage.local.set({ bridgeProfileId: identity });
      return identity;
    }).catch((error) => {
      profileIdentityReady = null;
      throw error;
    });
  }
  return profileIdentityReady;
}

async function snapshotTabs() {
  await debuggerSettingsReady;
  const profileId = await profileIdentity();
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => Number.isInteger(tab.id) && typeof tab.url === "string" && tab.url.length > 0)
    .map((tab) => {
      const supported = debuggingEnabled && isDebuggableUrl(tab.url);
      return {
        tab_id: bridgeTabId(tab.id),
        browser_tab_id: tab.id,
        profile_id: profileId,
        window_id: tab.windowId,
        tab_index: tab.index,
        url: tab.url,
        title: tab.title || "",
        active: Boolean(tab.active),
        pinned: Boolean(tab.pinned),
        incognito: Boolean(tab.incognito),
        source: "extension",
        capabilities: supported ? ["javascript", "cdp", "accessibility", "userscript"] : [],
      };
    });
}

function runtimeEvaluateExpression(script) {
  return `(async function () {\n${script}\n}).call(globalThis)`;
}

function runtimeValue(response) {
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    const description = details.exception?.description || details.text || "Runtime.evaluate failed";
    throw new Error(description);
  }
  const remote = response?.result;
  if (!remote) return null;
  if (Object.prototype.hasOwnProperty.call(remote, "value")) return remote.value;
  if (remote.unserializableValue !== undefined) {
    return { type: "unserializable", value: remote.unserializableValue };
  }
  return {
    type: "remote_object",
    object_type: remote.type || null,
    subtype: remote.subtype || null,
    description: remote.description || null,
  };
}

function tabUserscripts(tabId, create = false) {
  let scripts = temporaryUserscripts.get(tabId);
  if (!scripts && create) {
    scripts = new Map();
    temporaryUserscripts.set(tabId, scripts);
  }
  return scripts || null;
}

function userscriptSummary(record) {
  return {
    script_id: record.scriptId,
    name: record.metadata.name || "",
    namespace: record.metadata.namespace || "",
    run_at: record.metadata.runAt,
    grants: record.metadata.grants.slice(),
    matches: record.metadata.matches.slice(),
    excludes: record.metadata.excludes.slice(),
    connects: record.metadata.connects.slice(),
    noframes: record.metadata.noframes === true,
  };
}

function userscriptRequestKey(tabId, scriptId, requestId) {
  return `${tabId}\n${scriptId}\n${requestId}`;
}

function abortUserscriptRequests(tabId, scriptId = null) {
  const prefix = `${tabId}\n`;
  const scriptPrefix = scriptId === null ? null : `${tabId}\n${scriptId}\n`;
  for (const [key, active] of userscriptRequests) {
    if (!key.startsWith(prefix) || (scriptPrefix !== null && !key.startsWith(scriptPrefix))) continue;
    active.abortKind = "abort";
    active.controller.abort();
    userscriptRequests.delete(key);
  }
}

async function prepareUserscriptDebugger(rootSession) {
  await sendDebuggerCommand(rootSession, "Page.enable");
  await sendDebuggerCommand(rootSession, "Runtime.enable");
  try {
    await sendDebuggerCommand(rootSession, "Runtime.addBinding", { name: USERSCRIPT_BINDING_NAME });
  } catch (error) {
    if (!/binding.*already|already.*binding/i.test(errorText(error))) throw error;
  }
}

async function evaluateRuntimeExpression(target, expression, contextId = null, userGesture = false) {
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  };
  if (Number.isInteger(contextId)) params.contextId = contextId;
  const response = await sendDebuggerCommand(target, "Runtime.evaluate", params);
  return runtimeValue(response);
}

function removeCurrentUserscriptExpression(scriptId) {
  return `globalThis.__LOCAL_BRIDGE_TEMP_USERSCRIPTS__?.removeScript(${JSON.stringify(scriptId)}) ?? false`;
}

function listUserscriptCommandsExpression(scriptId) {
  return `globalThis.__LOCAL_BRIDGE_TEMP_USERSCRIPTS__?.listCommands(${JSON.stringify(scriptId)}) ?? []`;
}

function invokeUserscriptCommandExpression(scriptId, commandId) {
  return `globalThis.__LOCAL_BRIDGE_TEMP_USERSCRIPTS__?.invokeCommand(${JSON.stringify(scriptId)}, ${JSON.stringify(commandId)})`;
}

async function injectTemporaryUserscript(tabId, rootSession, job) {
  const scriptId = String(job.script_id || "");
  const source = String(job.userscript_source || "");
  if (!scriptId) throw new Error("userscript script_id is required");
  if (!source) throw new Error("userscript source is required");
  const metadata = userscriptRuntime.parseMetadata(source);
  const rpcToken = crypto.randomUUID();
  const bootstrap = userscriptRuntime.buildBootstrap({
    scriptId,
    source,
    metadata,
    bindingName: USERSCRIPT_BINDING_NAME,
    rpcToken,
  });
  await prepareUserscriptDebugger(rootSession);

  const scripts = tabUserscripts(tabId, true);
  const previous = scripts.get(scriptId) || null;
  const registration = await sendDebuggerCommand(rootSession, "Page.addScriptToEvaluateOnNewDocument", {
    source: bootstrap,
  }, value => {
    if (value?.identifier) return sendDebuggerCommand(cleanupDebuggerTarget(rootSession), "Page.removeScriptToEvaluateOnNewDocument", {identifier: String(value.identifier)});
  });
  const registrationId = String(registration?.identifier || "");
  if (!registrationId) throw new Error("Page.addScriptToEvaluateOnNewDocument did not return an identifier");

  try {
    if (previous) await evaluateRuntimeExpression(rootSession, removeCurrentUserscriptExpression(scriptId));
    const current = await evaluateRuntimeExpression(rootSession, bootstrap, null, true);
    if (previous?.registrationId) {
      try {
        await sendDebuggerCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
          identifier: previous.registrationId,
        });
      } catch {
        // A prior debugger detach can invalidate only the old registration; the replacement remains authoritative.
      }
    }
    assertDebuggerScope(rootSession);
    abortUserscriptRequests(tabId, scriptId);
    const record = { scriptId, source, metadata, rpcToken, registrationId, bootstrap };
    scripts.set(scriptId, record);
    return { action: "inject", ...userscriptSummary(record), current };
  } catch (error) {
    try {
      await sendDebuggerCommand(cleanupDebuggerTarget(rootSession), "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: registrationId,
      });
    } catch {
      // Preserve the original injection error.
    }
    throw error;
  }
}

async function removeTemporaryUserscript(tabId, rootSession, scriptId) {
  const scripts = tabUserscripts(tabId, false);
  const record = scripts?.get(scriptId) || null;
  if (!record) return { action: "remove", script_id: scriptId, removed: false };
  await prepareUserscriptDebugger(rootSession);
  try {
    await sendDebuggerCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
      identifier: record.registrationId,
    });
  } catch {
    // A detached/recreated debugger target may already have discarded the registration.
  }
  try {
    await evaluateRuntimeExpression(rootSession, removeCurrentUserscriptExpression(scriptId));
  } catch {
    // Navigation can replace the current execution context while removal is in flight.
  }
  assertDebuggerScope(rootSession);
  abortUserscriptRequests(tabId, scriptId);
  scripts.delete(scriptId);
  if (scripts.size === 0) temporaryUserscripts.delete(tabId);
  return { action: "remove", script_id: scriptId, removed: true };
}

async function executeUserscriptJob(tabId, rootSession, job) {
  const action = String(job.userscript_action || "");
  const scriptId = String(job.script_id || "");
  if (action === "inject") return injectTemporaryUserscript(tabId, rootSession, job);
  if (action === "remove") return removeTemporaryUserscript(tabId, rootSession, scriptId);
  if (action === "list") {
    return {
      action: "list",
      scripts: Array.from(tabUserscripts(tabId, false)?.values() || [], userscriptSummary),
    };
  }
  const record = tabUserscripts(tabId, false)?.get(scriptId) || null;
  if (!record) throw new Error(`userscript not found: ${scriptId}`);
  await prepareUserscriptDebugger(rootSession);
  if (action === "list_commands") {
    const commands = await evaluateRuntimeExpression(rootSession, listUserscriptCommandsExpression(scriptId));
    return { action, script_id: scriptId, commands: Array.isArray(commands) ? commands : [] };
  }
  if (action === "invoke_command") {
    const commandId = String(job.command_id || "");
    if (!commandId) throw new Error("userscript command_id is required");
    const value = await evaluateRuntimeExpression(
      rootSession,
      invokeUserscriptCommandExpression(scriptId, commandId),
      null,
      true,
    );
    return { action, script_id: scriptId, command_id: commandId, value: boundedJsonValue(value) };
  }
  throw new Error(`Unknown userscript action: ${action}`);
}

function permissionPatternForUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function deliverUserscriptRpc(source, executionContextId, scriptId, requestId, result) {
  const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
  const expression = `globalThis.__LOCAL_BRIDGE_TEMP_USERSCRIPTS__?.resolveRequest(` +
    `${JSON.stringify(scriptId)}, ${JSON.stringify(requestId)}, ${JSON.stringify(result)})`;
  try {
    await evaluateRuntimeExpression(target, expression, executionContextId);
  } catch {
    // The page may have navigated before an asynchronous request completed.
  }
}

async function handleUserscriptRpc(source, params = {}) {
  if (!Number.isInteger(source?.tabId) || params.name !== USERSCRIPT_BINDING_NAME) return;
  const payloadText = String(params.payload || "");
  if (!payloadText || payloadText.length > MAX_USERSCRIPT_RPC_CHARS) return;
  let request;
  try {
    request = JSON.parse(payloadText);
  } catch {
    return;
  }
  const scriptId = String(request.script_id || "");
  const requestId = String(request.request_id || "");
  const record = tabUserscripts(source.tabId, false)?.get(scriptId) || null;
  if (!record || !requestId || request.token !== record.rpcToken) return;
  const key = userscriptRequestKey(source.tabId, scriptId, requestId);
  if (request.type === "abort") {
    const active = userscriptRequests.get(key);
    if (active) {
      active.abortKind = "abort";
      active.controller.abort();
    }
    return;
  }
  if (request.type !== "request") return;

  const rawUrl = String(request.url || "");
  if (!userscriptRuntime.connectAllowed(record.metadata.connects, rawUrl)) {
    await deliverUserscriptRpc(source, params.executionContextId, scriptId, requestId, {
      kind: "error",
      response: { status: 0, error: `GM_xmlhttpRequest rejected by @connect: ${rawUrl}` },
    });
    return;
  }

  try {
    if (chrome.permissions?.contains) {
      const granted = await chrome.permissions.contains({ origins: [permissionPatternForUrl(rawUrl)] });
      if (!granted) throw new Error(`Browser Bridge host permission is not granted for ${new URL(rawUrl).hostname}`);
    }
    const responseType = String(request.response_type || "text").toLowerCase();
    if (!new Set(["", "text", "json"]).has(responseType)) {
      throw new Error(`Unsupported GM_xmlhttpRequest responseType: ${responseType}`);
    }
    const controller = new AbortController();
    const active = { controller, abortKind: null };
    userscriptRequests.set(key, active);
    const timeout = Math.max(0, Number(request.timeout) || 0);
    const timer = timeout > 0 ? setTimeout(() => {
      active.abortKind = "timeout";
      controller.abort();
    }, timeout) : null;
    try {
      const method = String(request.method || "GET").toUpperCase();
      const fetchOptions = {
        method,
        headers: request.headers && typeof request.headers === "object" ? request.headers : {},
        signal: controller.signal,
        credentials: request.anonymous === true ? "omit" : "include",
      };
      if (method !== "GET" && method !== "HEAD" && request.data !== null && request.data !== undefined) {
        fetchOptions.body = String(request.data);
      }
      const response = await fetch(rawUrl, fetchOptions);
      const responseText = await response.text();
      let responseValue = responseText;
      if (responseType === "json") {
        try { responseValue = JSON.parse(responseText); } catch { responseValue = null; }
      }
      const responseHeaders = Array.from(response.headers.entries(), ([name, value]) => `${name}: ${value}`).join("\r\n");
      await deliverUserscriptRpc(source, params.executionContextId, scriptId, requestId, {
        kind: "load",
        response: {
          status: response.status,
          statusText: response.statusText,
          responseText,
          response: responseValue,
          responseHeaders,
          finalUrl: response.url || rawUrl,
        },
      });
    } catch (error) {
      const kind = active.abortKind === "timeout" ? "timeout" : active.abortKind === "abort" ? "abort" : "error";
      await deliverUserscriptRpc(source, params.executionContextId, scriptId, requestId, {
        kind,
        response: { status: 0, error: errorText(error) },
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      userscriptRequests.delete(key);
    }
  } catch (error) {
    await deliverUserscriptRpc(source, params.executionContextId, scriptId, requestId, {
      kind: "error",
      response: { status: 0, error: errorText(error) },
    });
  }
}

async function restoreTemporaryUserscripts(tabId) {
  const scripts = tabUserscripts(tabId, false);
  if (!scripts?.size) return;
  try {
    await chrome.tabs.get(tabId);
  } catch {
    temporaryUserscripts.delete(tabId);
    abortUserscriptRequests(tabId);
    return;
  }
  let lease = null;
  try {
    lease = await debuggerSessions.acquire(tabId);
    const rootSession = ownDebuggerLease(lease);
    await prepareUserscriptDebugger(rootSession);
    for (const record of scripts.values()) {
      if (record.registrationId) {
        try {
          await sendDebuggerCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
            identifier: record.registrationId,
          });
        } catch {
          // The detached CDP session may already have discarded its registration.
        }
      }
      const registration = await sendDebuggerCommand(rootSession, "Page.addScriptToEvaluateOnNewDocument", {
        source: record.bootstrap,
      });
      record.registrationId = String(registration?.identifier || "");
    }
  } catch {
    // Another debugger owner can temporarily prevent restoration; the next explicit userscript command can retry.
  } finally {
    if (lease) await lease.release();
  }
}

function debuggerSourceMatchesTarget(source, target) {
  return source?.tabId === target.tabId && (source.sessionId || null) === (target.sessionId || null);
}

function securityOriginFromUrl(url) {
  try {
    const origin = new URL(url || "").origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

function recordFrameTree(frameTree, target, rootKind, frames, targets) {
  const visit = (node, isRoot) => {
    const frame = node?.frame;
    const frameId = typeof frame?.id === "string" ? frame.id : "";
    if (!frameId) return;
    const kind = isRoot ? rootKind : "frame";
    const existing = frames.get(frameId);
    const priority = kind === "root" ? 2 : kind === "oopif" ? 1 : 0;
    const existingPriority = existing?.kind === "root" ? 2 : existing?.kind === "oopif" ? 1 : existing ? 0 : -1;
    if (!existing || priority >= existingPriority) {
      if (frames.size < MAX_FRAMES || existing) {
        frames.set(frameId, {
          frame_id: frameId,
          parent_frame_id: typeof frame.parentId === "string" && frame.parentId ? frame.parentId : null,
          url: typeof frame.url === "string" ? frame.url : "",
          name: typeof frame.name === "string" ? frame.name : "",
          security_origin: typeof frame.securityOrigin === "string" ? frame.securityOrigin : "",
          kind,
        });
        targets.set(frameId, target);
      }
    }
    for (const child of node.childFrames || []) visit(child, false);
  };
  visit(frameTree, true);
}

const frameDiscoveryOwners = new Map();
async function discoverFrameTargets(tabId, rootSession) {
  if (frameDiscoveryOwners.has(tabId)) throw new Error("FRAME_RECOVERY_PENDING: The previous iframe session cleanup has not completed. Other tabs remain available.");
  const owner = Symbol();
  frameDiscoveryOwners.set(tabId, owner);
  const childSessions = new Map();
  const childAutoAttachPromises = [];
  const autoAttachParams = {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  };
  const disableAutoAttachParams = {
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true,
  };
  let cleanupTransferred = false;
  let cleanedUp = false;
  let lastChangeAt = Date.now();

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    const children = Array.from(childSessions.values()).reverse();
    for (const { target } of children) {
      if (frameDiscoveryOwners.get(tabId) !== owner) return;
      try {
        await sendDebuggerCommand(cleanupDebuggerTarget(target), "Target.setAutoAttach", disableAutoAttachParams);
      } catch {
        // Child sessions can disappear during navigation; disabling the root below still clears surviving auto-attached targets.
      }
    }
    if (frameDiscoveryOwners.get(tabId) !== owner) return;
    try {
      await sendDebuggerCommand(cleanupDebuggerTarget(rootSession), "Target.setAutoAttach", disableAutoAttachParams);
    } catch {
      // If the root target detached while cleaning up, chrome.debugger.onDetach already invalidates the persistent attachment.
    }
    if (frameDiscoveryOwners.get(tabId) === owner) frameDiscoveryOwners.delete(tabId);
  }

  const onEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId || method !== "Target.attachedToTarget") return;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const targetInfo = params.targetInfo || {};
    if (!sessionId || targetInfo.type !== "iframe" || childSessions.has(sessionId)) return;
    const target = inheritDebuggerScope({ tabId, sessionId }, rootSession);
    childSessions.set(sessionId, { target, targetInfo });
    lastChangeAt = Date.now();
    childAutoAttachPromises.push(
      sendDebuggerCommand(target, "Target.setAutoAttach", autoAttachParams),
    );
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await sendDebuggerCommand(rootSession, "Target.setAutoAttach", autoAttachParams);

    const deadline = Date.now() + FRAME_DISCOVERY_MAX_MS;
    let awaitedChildAttachCount = 0;
    let observedChildCount = -1;
    while (Date.now() < deadline) {
      const pending = childAutoAttachPromises.slice(awaitedChildAttachCount);
      if (pending.length > 0) {
        await Promise.all(pending);
        awaitedChildAttachCount += pending.length;
      }
      if (childSessions.size !== observedChildCount) {
        observedChildCount = childSessions.size;
        lastChangeAt = Date.now();
      }
      if (
        awaitedChildAttachCount === childAutoAttachPromises.length &&
        Date.now() - lastChangeAt >= FRAME_DISCOVERY_SETTLE_MS
      ) {
        break;
      }
      await sleep(10);
    }

    const frames = new Map();
    const targets = new Map();
    const rootTree = await sendDebuggerCommand(rootSession, "Page.getFrameTree");
    recordFrameTree(rootTree?.frameTree, rootSession, "root", frames, targets);

    for (const { target, targetInfo } of childSessions.values()) {
      try {
        const tree = await sendDebuggerCommand(target, "Page.getFrameTree");
        recordFrameTree(tree?.frameTree, target, "oopif", frames, targets);
        const rootFrameId = typeof tree?.frameTree?.frame?.id === "string" ? tree.frameTree.frame.id : "";
        const recorded = rootFrameId ? frames.get(rootFrameId) : null;
        if (
          recorded &&
          recorded.parent_frame_id === null &&
          typeof targetInfo.parentFrameId === "string" &&
          targetInfo.parentFrameId
        ) {
          frames.set(rootFrameId, { ...recorded, parent_frame_id: targetInfo.parentFrameId });
        }
      } catch {
        const frameId = typeof targetInfo.targetId === "string" ? targetInfo.targetId : "";
        if (!frameId || (frames.size >= MAX_FRAMES && !frames.has(frameId))) continue;
        frames.set(frameId, {
          frame_id: frameId,
          parent_frame_id:
            typeof targetInfo.parentFrameId === "string" && targetInfo.parentFrameId
              ? targetInfo.parentFrameId
              : null,
          url: typeof targetInfo.url === "string" ? targetInfo.url : "",
          name: typeof targetInfo.title === "string" ? targetInfo.title : "",
          security_origin: securityOriginFromUrl(targetInfo.url),
          kind: "oopif",
        });
        targets.set(frameId, target);
      }
    }
    assertDebuggerScope(rootSession);
    cleanupTransferred = true;
    return { frames: Array.from(frames.values()), targets, cleanup };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (!cleanupTransferred) await cleanup();
  }
}

async function resolveDefaultFrameContext(tabId, target, frameId) {
  let resolveContext;
  let rejectContext;
  const contextPromise = new Promise((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  const timer = setTimeout(() => {
    rejectContext(new Error(`frame_context_not_found: ${frameId}`));
  }, FRAME_CONTEXT_TIMEOUT_MS);
  const onEvent = (source, method, params = {}) => {
    if (!debuggerSourceMatchesTarget(source, target) || method !== "Runtime.executionContextCreated") return;
    const context = params.context;
    if (
      context?.auxData?.frameId === frameId &&
      context.auxData.isDefault === true &&
      Number.isInteger(context.id)
    ) {
      resolveContext(context.id);
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await sendDebuggerCommand(target, "Runtime.enable");
    return await contextPromise;
  } finally {
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function executeJob(job, scope) {
  scope.check();
  if (job.profile_id !== await profileIdentity()) throw new Error("Profile selection mismatch");
  if (!["normal", "private"].includes(job.context)) throw new Error("Explicit window privacy context is required");
  if (job.kind === "debugging") {
    if (!["status", "enable"].includes(job.action)) throw new Error("Use debugging action status or enable");
    if (job.window_id !== undefined) {
      const window = await chrome.windows.get(job.window_id);
      if (window.incognito !== (job.context === "private")) throw new Error("Window privacy context mismatch");
    }
    if (job.tab_id !== undefined) {
      const tab = await chrome.tabs.get(nativeTabId(job.tab_id));
      if (tab.incognito !== (job.context === "private")) throw new Error("Window privacy context mismatch");
      if (job.window_id !== undefined && tab.windowId !== job.window_id) throw new Error("Window selection mismatch");
    }
    if (job.action === "enable") {
      if (job.mode !== "authorized_mutation") throw new Error("Enabling debugging requires authorized mutation");
      if (job.context === "private" && !await chrome.extension.isAllowedIncognitoAccess()) {
        throw new Error("Enable Allow in Incognito / Allow in InPrivate for this extension");
      }
      await setDebuggingFromControl(true, nativeTabId(job.tab_id), scope);
    }
    const state = await debuggingState();
    const tabs = await chrome.tabs.query({});
    const visible = new Set(tabs.filter(tab => tab.incognito === (job.context === "private") &&
      (job.window_id === undefined || tab.windowId === job.window_id) &&
      (job.tab_id === undefined || bridgeTabId(tab.id) === job.tab_id)).map(tab => bridgeTabId(tab.id)));
    const attached = state.attached_tab_ids.filter(id => visible.has(id));
    if (job.action === "enable" && (!state.enabled || !attached.includes(job.tab_id))) {
      throw new Error("Debugging enable was canceled or the target disconnected; inspect its current status.");
    }
    const value = {enabled: state.enabled, attached: attached.length > 0, attached_tab_ids: attached,
      state: !state.enabled ? "disabled" : attached.length ? "connected" : "waiting",
      profile_id: job.profile_id, context: job.context, ...(job.window_id === undefined ? {} : {window_id: job.window_id})};
    return {job_id: job.job_id, tab_id: job.tab_id,
      results: [{index: 0, status: "exited", value}], frames: [], error: null, events: []};
  }
  if (job.kind === "window_control") {
    if (job.mode !== "authorized_mutation") throw new Error("Window control requires authorized mutation");
    const incognito = job.context === "private";
    if (incognito && !await chrome.extension.isAllowedIncognitoAccess()) throw new Error("Enable Allow in Incognito / Allow in InPrivate for this extension before private window control");
    if (job.window_id !== undefined) {
      const anchor = await chrome.windows.get(job.window_id);
      if (anchor.incognito !== incognito) throw new Error("Window privacy context mismatch");
    }
    let value;
    if (job.action === "create") {
      let url = "about:blank";
      if (job.url !== undefined) {
        const parsed = new URL(job.url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an HTTP(S) page URL");
        url = parsed.href;
      }
      scope.native("native:windows.create");
      const created = await chrome.windows.create({url, incognito, focused: false, type: "normal"});
      value = {window_id: created.id, incognito: created.incognito, focused: created.focused,
        tabs: (created.tabs || []).map(tab => ({tab_id: "chrome-tab:" + tab.id, window_id: tab.windowId, incognito: tab.incognito}))};
    } else if (job.action === "close") {
      if (!Number.isInteger(job.window_id)) throw new Error("An exact window_id is required");
      const target = await chrome.windows.get(job.window_id);
      if (target.focused && job.allow_foreground !== true) throw new Error("Closing the foreground window requires explicit foreground permission");
      scope.native("native:windows.remove");
      await chrome.windows.remove(job.window_id);
      value = {window_id: job.window_id, closed: true};
    } else {
      throw new Error("Use window action create or close");
    }
    return {job_id: job.job_id, results: [{index: 0, status: "exited", value}], frames: [], error: null, events: []};
  }
  if (job.allow_foreground !== true && job.kind === "cdp") {
    for (const command of job.commands || []) {
      if (["Page.bringToFront", "Target.activateTarget", "Browser.setWindowBounds"].includes(command.method) ||
          command.method === "Target.createTarget" && (command.params?.background !== true || command.params?.newWindow === true)) {
        throw new Error("Foreground operation requires the user's explicit permission and allow_foreground");
      }
    }
  }
  const tabId = nativeTabId(job.tab_id);
  const initialTab = await chrome.tabs.get(tabId);
  if (initialTab.incognito !== (job.context === "private")) throw new Error("Window privacy context mismatch");
  if (job.window_id !== undefined && initialTab.windowId !== job.window_id) throw new Error("Window selection mismatch");
  if (job.kind === "tab_control") {
    if (job.mode !== "authorized_mutation") throw new Error("Tab control requires authorized mutation");
    if (job.tab_control?.action === "reload" && job.tab_control.target_tab_id !== job.tab_id) {
      throw new Error("Reload target must match the dispatched tab");
    }
    const value = await tabControl.run({ ...job.tab_control, window_id: initialTab.windowId }, scope);
    return { tab_id: job.tab_id, job_id: job.job_id, url: initialTab.url, title: initialTab.title || "", results: [{ index: 0, status: "exited", value }], frames: [], error: null, events: [] };
  }
  const requestedEvents = new Set(job.event_methods || []);
  const events = [];
  let eventChars = 0;
  let debuggerLease = null;
  let rootSession = null;
  let frames = [];
  let frameTargetCleanup = null;

  const onEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId || !requestedEvents.has(method) || events.length >= MAX_EVENTS) return;
    const boundedParams = boundedJsonValue(params, MAX_EVENT_JSON_CHARS);
    const event = {
      method,
      params: boundedParams && typeof boundedParams === "object" && !Array.isArray(boundedParams)
        ? boundedParams
        : { value: boundedParams },
    };
    if (source.sessionId) event.session_id = source.sessionId;
    const size = JSON.stringify(event).length;
    if (eventChars + size > MAX_EVENT_TOTAL_JSON_CHARS) return;
    eventChars += size;
    events.push(event);
  };

  try {
    scope.check();
    debuggerLease = await debuggerSessions.acquire(tabId, {signal: scope.signal, progress: scope.progress, beforeAttach: () => scope.native("native:debugger.attach")});
    rootSession = ownDebuggerLease(debuggerLease, scope);
    if (requestedEvents.size > 0) chrome.debugger.onEvent.addListener(onEvent);

    const results = [];
    if (job.kind === "javascript") {
      let evaluationTarget = rootSession;
      let contextId = null;
      if (job.frame_id) {
        const discovered = await discoverFrameTargets(tabId, rootSession);
        frameTargetCleanup = discovered.cleanup;
        const target = discovered.targets.get(job.frame_id);
        if (!target) throw new Error(`frame_not_found: ${job.frame_id}`);
        evaluationTarget = target;
        contextId = await resolveDefaultFrameContext(tabId, target, job.frame_id);
      }
      for (let index = 0; index < job.scripts.length; index += 1) {
        scope.check();
        try {
          const params = {
            expression: runtimeEvaluateExpression(job.scripts[index]),
            awaitPromise: true,
            returnByValue: true,
            userGesture: job.allow_foreground === true,
          };
          if (contextId !== null) params.contextId = contextId;
          const response = await sendDebuggerCommand(evaluationTarget, "Runtime.evaluate", params);
          results.push({ index, status: "exited", value: boundedJsonValue(runtimeValue(response)) });
        } catch (error) {
          results.push({ index, status: "failed", error: errorText(error) });
        }
      }
    } else if (job.kind === "list_frames") {
      const discovered = await discoverFrameTargets(tabId, rootSession);
      frameTargetCleanup = discovered.cleanup;
      frames = discovered.frames;
    } else if (job.kind === "userscript") {
      try {
        const value = await executeUserscriptJob(tabId, rootSession, job);
        results.push({ index: 0, status: "exited", value: boundedJsonValue(value) });
      } catch (error) {
        results.push({ index: 0, status: "failed", error: errorText(error) });
      }
    } else if (job.kind === "cdp") {
      for (let index = 0; index < job.commands.length; index += 1) {
        scope.check();
        const command = job.commands[index];
        try {
          const target = command.session_id
            ? inheritDebuggerScope({ tabId, sessionId: command.session_id }, rootSession)
            : rootSession;
          const value = await sendDebuggerCommand(target, command.method, command.params || {});
          // Encoded screenshot bytes must arrive intact, including large pages.
          // Other CDP results retain the normal text-result bound.
          results.push({ index, status: "exited", value: command.method === "Page.captureScreenshot" ? value : boundedJsonValue(value) });
        } catch (error) {
          results.push({ index, status: "failed", error: errorText(error) });
        }
      }
    } else {
      throw new Error(`Unknown Browser Bridge job kind: ${job.kind}`);
    }

    const collectMs = Math.max(0, Number(job.collect_events_ms) || 0);
    if (collectMs > 0 && requestedEvents.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, collectMs));
    }

    let finalTab = initialTab;
    try {
      finalTab = await chrome.tabs.get(tabId);
    } catch {
      // A tab can close after a command completes; the initial snapshot still identifies the completed job.
    }
    return {
      tab_id: job.tab_id,
      job_id: job.job_id,
      url: finalTab.url || initialTab.url,
      title: finalTab.title || initialTab.title || "",
      results,
      frames,
      error: null,
      events,
    };
  } finally {
    if (requestedEvents.size > 0) chrome.debugger.onEvent.removeListener(onEvent);
    if (frameTargetCleanup) await frameTargetCleanup();
    if (debuggerLease) await debuggerLease.release();
  }
}

class ExtensionJobTimeoutError extends Error {
  constructor() {super("DEADLINE_EXCEEDED: Browser job deadline expired; inspect the job before repeating a mutation."); this.name = "ExtensionJobTimeoutError";}
}

async function executeJobs(jobs, timeoutMs = EXTENSION_JOB_BATCH_TIMEOUT_MS, progress = () => {}, controlRevision = debuggingControlRevision) {
  const completed = [];
  for (const job of jobs || []) {
    const controller = new AbortController();
    const deadline = job.deadline_at ?? Date.now() + timeoutMs;
    let dispatched = false, phase = "accepted", timer;
    const scope = {
      signal: controller.signal,
      progress(value) {phase = value; progress(value);},
      check() {
        const needsDebugger = !["tab_control", "window_control"].includes(job.kind) && !(job.kind === "debugging" && job.action === "status");
        if (needsDebugger && controlRevision !== debuggingControlRevision && !controller.signal.aborted) controller.abort(new Error("DEBUGGING_CONTROL_CHANGED: A manual control superseded this accepted job."));
        if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new ExtensionJobTimeoutError());
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      native(value) {this.check(); dispatched = true; this.progress(value);},
    };
    try {
      scope.check();
      timer = setTimeout(() => controller.abort(new ExtensionJobTimeoutError()), Math.max(1, deadline - Date.now()));
      let abort;
      try {
        completed.push(await Promise.race([executeJob(job, scope), new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, {once: true});
        })]));
      } finally {if (abort) controller.signal.removeEventListener("abort", abort);}
    } catch (error) {
      const count = job.kind === "cdp" ? (job.commands || []).length : job.kind === "javascript" ? (job.scripts || []).length : job.kind === "list_frames" ? 0 : 1;
      completed.push({job_id: job.job_id, ...(job.tab_id === undefined ? {} : {tab_id: job.tab_id}),
        results: Array.from({length: count}, (_, index) => ({index, status: "failed", error: errorText(error)})),
        frames: [], events: [], error: job.kind === "list_frames" ? errorText(error) : null,
        phase, outcome_unknown: dispatched,
      });
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new Error("JOB_FINISHED: Do not submit further commands."));
      // A job timeout never detaches a persistent attachment shared by recording
      // or userscripts. In-flight native calls can finish; later steps are fenced.
    }
  }
  return completed;
}

async function resolveStoredBridgeBaseUrl() {
  const stored = await chrome.storage.local.get({bridgeBaseUrl: DEFAULT_BRIDGE_BASE_URL});
  return String(stored.bridgeBaseUrl || DEFAULT_BRIDGE_BASE_URL).trim().replace(/\/$/, "");
}

const jobLanes = new Map();
async function executeSocketJob(job, progress) {
  const controlRevision = debuggingControlRevision;
  // Status must remain available while native execution for one tab is blocked.
  const key = job.kind === "debugging" && job.action === "status" ? null : job.tab_id || "window:" + job.context;
  const previous = key === null ? Promise.resolve() : jobLanes.get(key) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    progress("running");
    return (await executeJobs([job], Math.max(1, job.deadline_at - Date.now()), progress, controlRevision))[0];
  });
  if (key !== null) {
    jobLanes.set(key, work);
    void work.finally(() => {if (jobLanes.get(key) === work) jobLanes.delete(key);}).catch(() => {});
  }
  return await work;
}

const socketTransport = globalThis.BrowserBridgeSocket.create({
  baseUrl: resolveStoredBridgeBaseUrl,
  inventory: transportSnapshot,
  execute: executeSocketJob,
  status: async (state, error) => chrome.storage.local.set({bridgeStatus: state, bridgeLastError: error, bridgeUpdatedAt: Date.now()}),
});

async function initializeBridgeRuntime() {
  // Close a pre-upgrade offscreen page once; it must not keep polling the service.
  const contexts = await chrome.runtime.getContexts?.({contextTypes: ["OFFSCREEN_DOCUMENT"]});
  if (contexts?.some(context => context.documentUrl === chrome.runtime.getURL("offscreen.html"))) await chrome.offscreen.closeDocument();
  await chrome.alarms.clear("browser-bridge-offscreen-watchdog");
  await chrome.alarms.create(SOCKET_WATCHDOG_ALARM, {periodInMinutes: 1});
  void socketTransport.start();
}

async function handleMessage(message, sender = null) {
  switch (message?.type) {
    case "get_debugging_state":
      return await debuggingState();
    case "set_debugging": {
      if (!sender?.url?.startsWith(chrome.runtime.getURL(""))) {
        throw new Error("Debugging can only be changed from extension controls");
      }
      return await setDebuggingFromControl(message.enabled);
    }
    case "get_config": {
      return { bridgeBaseUrl: await resolveStoredBridgeBaseUrl() };
    }
    case "snapshot_tabs":
      return await transportSnapshot();
    case "execute_jobs":
      return { results: await executeJobs(message.jobs || [], message.timeout_ms) };
    case "set_status":
      await chrome.storage.local.set({
        bridgeStatus: message.status || "unknown",
        bridgeLastError: message.error || "",
        bridgeTabCount: Number(message.tabCount) || 0,
        bridgeUpdatedAt: Date.now(),
      });
      return { ok: true };
    default:
      throw new Error(`Unknown extension message type: ${message?.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: errorText(error) }),
  );
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Runtime.bindingCalled" && params?.name === USERSCRIPT_BINDING_NAME) {
    void handleUserscriptRpc(source, params);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (Number.isInteger(source?.tabId) && !source.sessionId) frameDiscoveryOwners.delete(source.tabId);
  if (reason === "canceled_by_user") {
    void disableDebuggingFromBanner().catch(() => { console.warn("Browser Bridge could not persist debugging disabled state"); });
    return;
  }
  const tabId = source?.tabId;
  if (!debuggingEnabled || !Number.isInteger(tabId) || !temporaryUserscripts.has(tabId)) return;
  setTimeout(() => void restoreTemporaryUserscripts(tabId), 0);
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  if (!Number.isInteger(tabId)) return;
  frameDiscoveryOwners.delete(tabId);
  temporaryUserscripts.delete(tabId);
  abortUserscriptRequests(tabId);
});

async function transportSnapshot() {
  await debuggerSettingsReady;
  const windows = await chrome.windows.getAll({windowTypes: ["normal", "popup"]});
  return {
    profile_id: await profileIdentity(),
    debugging_enabled: debuggingEnabled,
    private_allowed: await chrome.extension.isAllowedIncognitoAccess(),
    windows: windows.map(window => ({window_id: window.id, incognito: window.incognito, focused: window.focused, type: window.type, state: window.state})),
    tabs: await snapshotTabs(),
  };
}

function notifyTransportTabsChanged() {
  void socketTransport.publish();
}
for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onReplaced]) {
  event?.addListener(notifyTransportTabsChanged);
}

chrome.runtime.onInstalled.addListener((details) => {
  void initializeBridgeRuntime();
});
chrome.runtime.onStartup.addListener(() => {
  void initializeBridgeRuntime();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  // Debugging writes are owned by this worker; replaying their delayed storage
  // events as new controls could undo a more recent user cancellation.
  if (areaName === "local" && changes.bridgeBaseUrl) {
    socketTransport.reconnect();
  }
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === SOCKET_WATCHDOG_ALARM) void socketTransport.start();
});

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void initializeBridgeRuntime();
