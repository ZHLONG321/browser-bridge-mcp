"use strict";

importScripts("debugger-session.js", "userscript-runtime.js", "tab-control.js");

const OFFSCREEN_URL = "offscreen.html";
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
const OFFSCREEN_WATCHDOG_ALARM = "browser-bridge-offscreen-watchdog";
const OFFSCREEN_WATCHDOG_PERIOD_MINUTES = 0.5;
const OFFSCREEN_STATUS_STALE_MS = 45_000;
const EXTENSION_JOB_BATCH_TIMEOUT_MS = 17_000;
const EXTENSION_DEBUGGER_RESET_TIMEOUT_MS = 750;

let creatingOffscreenDocument = null;
let repairingOffscreenDocument = null;
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

async function setDebuggingFromControl(enabled, targetTabId) {
  if (typeof enabled !== "boolean") throw new Error("Debugging setting must be a boolean");
  // Separate target enables may run concurrently. Explicit UI controls or banner
  // cancellation supersede them, but enabling another tab does not cancel a job.
  const revision = targetTabId === undefined ? ++debuggingControlRevision : debuggingControlRevision;
  await debuggerSettingsReady;
  if (revision !== debuggingControlRevision) return { enabled: debuggingEnabled };
  const wasEnabled = debuggingEnabled;
  if (!enabled) {
    await disableDebuggingFromBanner();
    return { enabled: false };
  }
  await applyDebuggingSetting(true);
  try {
    if (revision !== debuggingControlRevision) return { enabled: debuggingEnabled };
    if (targetTabId !== undefined) {
      // Persist the requested preference separately from this tab's connection outcome.
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
    const lease = await debuggerSessions.acquire(target.id);
    try {
      // A read-only operation establishes the attachment without reading page content.
      await chrome.debugger.sendCommand(lease.rootSession, "Runtime.getIsolateId");
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
  await chrome.debugger.sendCommand(rootSession, "Page.enable");
  await chrome.debugger.sendCommand(rootSession, "Runtime.enable");
  try {
    await chrome.debugger.sendCommand(rootSession, "Runtime.addBinding", { name: USERSCRIPT_BINDING_NAME });
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
  const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", params);
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
  const registration = await chrome.debugger.sendCommand(rootSession, "Page.addScriptToEvaluateOnNewDocument", {
    source: bootstrap,
  });
  const registrationId = String(registration?.identifier || "");
  if (!registrationId) throw new Error("Page.addScriptToEvaluateOnNewDocument did not return an identifier");

  try {
    if (previous) await evaluateRuntimeExpression(rootSession, removeCurrentUserscriptExpression(scriptId));
    const current = await evaluateRuntimeExpression(rootSession, bootstrap, null, true);
    if (previous?.registrationId) {
      try {
        await chrome.debugger.sendCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
          identifier: previous.registrationId,
        });
      } catch {
        // A prior debugger detach can invalidate only the old registration; the replacement remains authoritative.
      }
    }
    abortUserscriptRequests(tabId, scriptId);
    const record = { scriptId, source, metadata, rpcToken, registrationId, bootstrap };
    scripts.set(scriptId, record);
    return { action: "inject", ...userscriptSummary(record), current };
  } catch (error) {
    try {
      await chrome.debugger.sendCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
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
    await chrome.debugger.sendCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
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
    const rootSession = lease.rootSession;
    await prepareUserscriptDebugger(rootSession);
    for (const record of scripts.values()) {
      if (record.registrationId) {
        try {
          await chrome.debugger.sendCommand(rootSession, "Page.removeScriptToEvaluateOnNewDocument", {
            identifier: record.registrationId,
          });
        } catch {
          // The detached CDP session may already have discarded its registration.
        }
      }
      const registration = await chrome.debugger.sendCommand(rootSession, "Page.addScriptToEvaluateOnNewDocument", {
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

async function discoverFrameTargets(tabId, rootSession) {
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
      try {
        await chrome.debugger.sendCommand(target, "Target.setAutoAttach", disableAutoAttachParams);
      } catch {
        // Child sessions can disappear during navigation; disabling the root below still clears surviving auto-attached targets.
      }
    }
    try {
      await chrome.debugger.sendCommand(rootSession, "Target.setAutoAttach", disableAutoAttachParams);
    } catch {
      // If the root target detached while cleaning up, chrome.debugger.onDetach already invalidates the persistent attachment.
    }
  }

  const onEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId || method !== "Target.attachedToTarget") return;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const targetInfo = params.targetInfo || {};
    if (!sessionId || targetInfo.type !== "iframe" || childSessions.has(sessionId)) return;
    const target = { tabId, sessionId };
    childSessions.set(sessionId, { target, targetInfo });
    lastChangeAt = Date.now();
    childAutoAttachPromises.push(
      chrome.debugger.sendCommand(target, "Target.setAutoAttach", autoAttachParams),
    );
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand(rootSession, "Target.setAutoAttach", autoAttachParams);

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
    const rootTree = await chrome.debugger.sendCommand(rootSession, "Page.getFrameTree");
    recordFrameTree(rootTree?.frameTree, rootSession, "root", frames, targets);

    for (const { target, targetInfo } of childSessions.values()) {
      try {
        const tree = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
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
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    return await contextPromise;
  } finally {
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function executeJob(job) {
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
      await setDebuggingFromControl(true, nativeTabId(job.tab_id));
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
      const created = await chrome.windows.create({url, incognito, focused: false, type: "normal"});
      value = {window_id: created.id, incognito: created.incognito, focused: created.focused,
        tabs: (created.tabs || []).map(tab => ({tab_id: "chrome-tab:" + tab.id, window_id: tab.windowId, incognito: tab.incognito}))};
    } else if (job.action === "close") {
      if (!Number.isInteger(job.window_id)) throw new Error("An exact window_id is required");
      const target = await chrome.windows.get(job.window_id);
      if (target.focused && job.allow_foreground !== true) throw new Error("Closing the foreground window requires explicit foreground permission");
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
    const value = await tabControl.run({ ...job.tab_control, window_id: initialTab.windowId });
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
    debuggerLease = await debuggerSessions.acquire(tabId);
    rootSession = debuggerLease.rootSession;
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
        try {
          const params = {
            expression: runtimeEvaluateExpression(job.scripts[index]),
            awaitPromise: true,
            returnByValue: true,
            userGesture: job.allow_foreground === true,
          };
          if (contextId !== null) params.contextId = contextId;
          const response = await chrome.debugger.sendCommand(evaluationTarget, "Runtime.evaluate", params);
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
        const command = job.commands[index];
        try {
          const target = command.session_id
            ? { tabId, sessionId: command.session_id }
            : rootSession;
          const value = await chrome.debugger.sendCommand(target, command.method, command.params || {});
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
  constructor(timeoutMs) {
    super("browser_job_timeout: extension execute_jobs exceeded " + timeoutMs + "ms");
    this.name = "ExtensionJobTimeoutError";
  }
}

async function resetDebuggerAfterJobTimeout(tabId) {
  try {
    await Promise.race([
      debuggerSessions.reset(tabId),
      sleep(EXTENSION_DEBUGGER_RESET_TIMEOUT_MS),
    ]);
  } catch {
    // Best effort: return a bounded failed job even if cleanup itself is slow.
  }
}

async function executeJobWithinDeadline(job, deadlineAt, timeoutMs) {
  const remaining = Math.max(0, deadlineAt - Date.now());
  if (remaining === 0) {
    if (job.tab_id && !["tab_control", "window_control"].includes(job.kind)) await resetDebuggerAfterJobTimeout(nativeTabId(job.tab_id));
    throw new ExtensionJobTimeoutError(timeoutMs);
  }
  let timer = null;
  try {
    return await Promise.race([
      executeJob(job),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ExtensionJobTimeoutError(timeoutMs)), remaining);
      }),
    ]);
  } catch (error) {
    if (error?.name === "ExtensionJobTimeoutError" && job.tab_id && !["tab_control", "window_control"].includes(job.kind)) {
      await resetDebuggerAfterJobTimeout(nativeTabId(job.tab_id));
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function executeJobs(jobs, timeoutMs = EXTENSION_JOB_BATCH_TIMEOUT_MS) {
  const completed = [];
  const deadlineAt = Date.now() + Math.max(1, Number(timeoutMs) || EXTENSION_JOB_BATCH_TIMEOUT_MS);
  for (const job of jobs || []) {
    try {
      completed.push(await executeJobWithinDeadline(job, deadlineAt, timeoutMs));
    } catch (error) {
      let tab = null;
      try {
        if (job.tab_id) tab = await chrome.tabs.get(nativeTabId(job.tab_id));
      } catch {
        // Return a bounded failed result even when the target disappeared before attachment.
      }
      const count = job.kind === "cdp"
        ? (job.commands || []).length
        : job.kind === "javascript"
          ? (job.scripts || []).length
          : ["userscript", "tab_control", "window_control", "debugging"].includes(job.kind)
            ? 1
            : 0;
      completed.push({
        tab_id: job.tab_id,
        job_id: job.job_id,
        url: tab?.url || "about:blank",
        title: tab?.title || "",
        results: Array.from({ length: count }, (_, index) => ({
          index,
          status: "failed",
          error: errorText(error),
        })),
        frames: [],
        error: job.kind === "list_frames" ? errorText(error) : null,
        events: [],
      });
    }
  }
  return completed;
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  const clientsList = await clients.matchAll();
  return clientsList.some((client) => client.url === chrome.runtime.getURL(OFFSCREEN_URL));
}

function currentExtensionVersion() {
  return String(chrome.runtime.getManifest?.().version || "");
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run the Local Bridge WebSocket worker without requiring a visible extension page.",
    }).then(async () => {
      const version = currentExtensionVersion();
      if (version) await chrome.storage.local.set({ bridgeOffscreenVersion: version });
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function ensureOffscreenWatchdogAlarm() {
  if (!chrome.alarms?.get || !chrome.alarms?.create) return;
  try {
    const existing = await chrome.alarms.get(OFFSCREEN_WATCHDOG_ALARM);
    if (!existing) {
      chrome.alarms.create(OFFSCREEN_WATCHDOG_ALARM, {
        periodInMinutes: OFFSCREEN_WATCHDOG_PERIOD_MINUTES,
      });
    }
  } catch {
    // Alarm setup is a recovery aid and must not block normal extension startup.
  }
}

async function recreateOffscreenDocument() {
  if (!repairingOffscreenDocument) {
    repairingOffscreenDocument = (async () => {
      if (creatingOffscreenDocument) await creatingOffscreenDocument;
      await chrome.storage.local.set({ bridgeUpdatedAt: 0 });
      if (await hasOffscreenDocument()) {
        try {
          await chrome.offscreen.closeDocument();
        } catch (error) {
          if (await hasOffscreenDocument()) throw error;
        }
      }
      await ensureOffscreenDocument();
    })().finally(() => {
      repairingOffscreenDocument = null;
    });
  }
  await repairingOffscreenDocument;
}

async function ensureCurrentOffscreenDocument() {
  if (!await hasOffscreenDocument()) {
    await ensureOffscreenDocument();
    return "created";
  }
  const currentVersion = currentExtensionVersion();
  if (!currentVersion) return "healthy";
  const { bridgeOffscreenVersion = "" } = await chrome.storage.local.get({ bridgeOffscreenVersion: "" });
  if (String(bridgeOffscreenVersion || "") !== currentVersion) {
    await recreateOffscreenDocument();
    return "recreated_version_mismatch";
  }
  return "healthy";
}

async function recoverStaleOffscreenDocument(now = Date.now()) {
  const lifecycle = await ensureCurrentOffscreenDocument();
  if (lifecycle !== "healthy") return lifecycle;
  const { bridgeUpdatedAt = 0 } = await chrome.storage.local.get({ bridgeUpdatedAt: 0 });
  const updatedAt = Number(bridgeUpdatedAt) || 0;
  if (updatedAt > 0 && now - updatedAt <= OFFSCREEN_STATUS_STALE_MS) return "healthy";
  await recreateOffscreenDocument();
  return "recreated";
}

async function resolveStoredBridgeBaseUrl() {
  const stored = await chrome.storage.local.get({ bridgeBaseUrl: DEFAULT_BRIDGE_BASE_URL });
  const configured = String(stored.bridgeBaseUrl || "").trim().replace(/\/$/, "");
  return configured || DEFAULT_BRIDGE_BASE_URL;
}

async function initializeBridgeRuntime({ forceRecreateOffscreen = false } = {}) {
  await resolveStoredBridgeBaseUrl();
  if (forceRecreateOffscreen && await hasOffscreenDocument()) {
    await recreateOffscreenDocument();
  } else {
    await ensureCurrentOffscreenDocument();
  }
  await ensureOffscreenWatchdogAlarm();
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
  void chrome.runtime.sendMessage({ type: "bridge_tabs_changed" }).catch(() => {});
}
for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onReplaced]) {
  event?.addListener(notifyTransportTabsChanged);
}

chrome.runtime.onInstalled.addListener((details) => {
  void initializeBridgeRuntime({ forceRecreateOffscreen: details?.reason === "update" });
});
chrome.runtime.onStartup.addListener(() => {
  void initializeBridgeRuntime();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  // Debugging writes are owned by this worker; replaying their delayed storage
  // events as new controls could undo a more recent user cancellation.
  if (areaName === "local" && changes.bridgeBaseUrl) {
    void ensureCurrentOffscreenDocument();
    void chrome.runtime.sendMessage({ type: "bridge_config_changed" }).catch(() => {});
  }
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === OFFSCREEN_WATCHDOG_ALARM) void recoverStaleOffscreenDocument();
});

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void initializeBridgeRuntime();
