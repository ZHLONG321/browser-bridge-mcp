"use strict";

(function installLocalBridgeUserscriptRuntime(root) {
  const SUPPORTED_GRANTS = new Set([
    "unsafeWindow",
    "GM_getValue",
    "GM_setValue",
    "GM_deleteValue",
    "GM_listValues",
    "GM_registerMenuCommand",
    "GM_unregisterMenuCommand",
    "GM_addStyle",
    "GM_xmlhttpRequest",
  ]);

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function wildcardRegex(value) {
    return String(value)
      .split("*")
      .map((part) => escapeRegex(part))
      .join(".*");
  }

  function matchPatternRegex(pattern) {
    const value = String(pattern || "").trim();
    if (!value) throw new Error("Userscript match pattern cannot be empty");
    if (value === "<all_urls>") return "^(?:https?|file|ftp):";
    const match = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(value);
    if (!match) throw new Error(`Unsupported userscript match pattern: ${value}`);
    const [, rawScheme, rawHost, rawPath] = match;
    const scheme = rawScheme === "*" ? "https?" : escapeRegex(rawScheme);
    let host;
    if (rawHost === "*") {
      host = "[^/]+";
    } else if (rawHost.startsWith("*.")) {
      const suffix = escapeRegex(rawHost.slice(2));
      host = `(?:[^/.]+\\.)*${suffix}`;
    } else {
      host = escapeRegex(rawHost);
    }
    return `^${scheme}:\\/\\/${host}${wildcardRegex(rawPath)}$`;
  }

  function parseMetadata(source) {
    const text = String(source || "");
    const start = text.indexOf("// ==UserScript==");
    const end = text.indexOf("// ==/UserScript==", Math.max(0, start));
    const metadata = {
      name: "",
      namespace: "",
      runAt: "document-start",
      grants: [],
      matches: [],
      excludes: [],
      connects: [],
      noframes: false,
    };
    if (start >= 0 && end > start) {
      const block = text.slice(start, end).split(/\r?\n/);
      for (const line of block) {
        const parsed = /^\/\/\s*@([^\s]+)(?:\s+(.*?))?\s*$/.exec(line);
        if (!parsed) continue;
        const key = parsed[1];
        const value = String(parsed[2] || "").trim();
        if (key === "name" && !metadata.name) metadata.name = value;
        else if (key === "namespace" && !metadata.namespace) metadata.namespace = value;
        else if (key === "run-at" && value) metadata.runAt = value;
        else if (key === "grant" && value) metadata.grants.push(value);
        else if (key === "match" && value) metadata.matches.push(value);
        else if ((key === "exclude" || key === "exclude-match") && value) metadata.excludes.push(value);
        else if (key === "connect" && value) metadata.connects.push(value);
        else if (key === "noframes") metadata.noframes = true;
      }
    }
    if (!["document-start", "document-end", "document-idle"].includes(metadata.runAt)) {
      throw new Error(`Unsupported userscript @run-at value: ${metadata.runAt}`);
    }
    const grants = Array.from(new Set(metadata.grants));
    if (grants.includes("none")) {
      if (grants.length !== 1) throw new Error("Userscript @grant none cannot be combined with other grants");
      metadata.grants = [];
    } else {
      const unsupported = grants.filter((grant) => !SUPPORTED_GRANTS.has(grant));
      if (unsupported.length) throw new Error(`Unsupported userscript @grant: ${unsupported.join(", ")}`);
      metadata.grants = grants;
    }
    metadata.matches = Array.from(new Set(metadata.matches));
    metadata.excludes = Array.from(new Set(metadata.excludes));
    metadata.connects = Array.from(new Set(metadata.connects));
    for (const pattern of [...metadata.matches, ...metadata.excludes]) matchPatternRegex(pattern);
    return metadata;
  }

  function connectAllowed(connects, rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ""));
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    for (const rawEntry of connects || []) {
      const entry = String(rawEntry || "").trim().toLowerCase();
      if (!entry) continue;
      if (entry === "*") return true;
      if (entry.startsWith("*.")) {
        const suffix = entry.slice(2);
        if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return true;
        continue;
      }
      if (hostname === entry) return true;
    }
    return false;
  }

  function grantedDeclarations(grants) {
    const allowed = new Set(grants || []);
    const declarations = [];
    if (allowed.has("unsafeWindow")) declarations.push("const unsafeWindow = globalThis;");
    if (allowed.has("GM_getValue")) declarations.push("const GM_getValue = gmGetValue;");
    if (allowed.has("GM_setValue")) declarations.push("const GM_setValue = gmSetValue;");
    if (allowed.has("GM_deleteValue")) declarations.push("const GM_deleteValue = gmDeleteValue;");
    if (allowed.has("GM_listValues")) declarations.push("const GM_listValues = gmListValues;");
    if (allowed.has("GM_registerMenuCommand")) declarations.push("const GM_registerMenuCommand = gmRegisterMenuCommand;");
    if (allowed.has("GM_unregisterMenuCommand")) declarations.push("const GM_unregisterMenuCommand = gmUnregisterMenuCommand;");
    if (allowed.has("GM_addStyle")) declarations.push("const GM_addStyle = gmAddStyle;");
    if (allowed.has("GM_xmlhttpRequest")) declarations.push("const GM_xmlhttpRequest = gmXmlhttpRequest;");
    return declarations.join("\n");
  }

  function buildBootstrap({ scriptId, source, metadata, bindingName, rpcToken }) {
    const matchers = metadata.matches.map(matchPatternRegex);
    const excludes = metadata.excludes.map(matchPatternRegex);
    const declarations = grantedDeclarations(metadata.grants);
    const serializedMetadata = JSON.stringify({
      name: metadata.name || "",
      namespace: metadata.namespace || "",
      runAt: metadata.runAt,
      grants: metadata.grants,
      matches: metadata.matches,
      excludes: metadata.excludes,
      connects: metadata.connects,
      noframes: metadata.noframes,
    });
    return [
      "(() => {",
      `const scriptId = ${JSON.stringify(scriptId)};`,
      `const metadata = ${serializedMetadata};`,
      `const matchers = ${JSON.stringify(matchers)}.map((value) => new RegExp(value));`,
      `const excludes = ${JSON.stringify(excludes)}.map((value) => new RegExp(value));`,
      "const href = String(location.href);",
      "if (metadata.noframes && globalThis.top !== globalThis) return {installed:false, reason:'frame'};",
      "if (matchers.length && !matchers.some((matcher) => matcher.test(href))) return {installed:false, reason:'no_match'};",
      "if (excludes.some((matcher) => matcher.test(href))) return {installed:false, reason:'excluded'};",
      "const rootKey = '__LOCAL_BRIDGE_TEMP_USERSCRIPTS__';",
      "const runtime = globalThis[rootKey] || (globalThis[rootKey] = {",
      "  scripts: new Map(),",
      "  removeScript(id) {",
      "    const state = this.scripts.get(String(id));",
      "    if (!state) return false;",
      "    for (const style of state.styles) { try { style.remove(); } catch {} }",
      "    state.commands.clear();",
      "    state.requests.clear();",
      "    this.scripts.delete(String(id));",
      "    return true;",
      "  },",
      "  resolveRequest(id, requestId, result) {",
      "    const state = this.scripts.get(String(id));",
      "    const entry = state?.requests.get(String(requestId));",
      "    if (!entry) return false;",
      "    state.requests.delete(String(requestId));",
      "    const options = entry.options || {};",
      "    try {",
      "      if (result?.kind === 'load') options.onload?.(result.response || {});",
      "      else if (result?.kind === 'timeout') options.ontimeout?.(result.response || {});",
      "      else if (result?.kind === 'abort') options.onabort?.(result.response || {});",
      "      else options.onerror?.(result?.response || {error: result?.error || 'GM_xmlhttpRequest failed'});",
      "    } catch (error) { queueMicrotask(() => { throw error; }); }",
      "    return true;",
      "  },",
      "  listCommands(id) {",
      "    const state = this.scripts.get(String(id));",
      "    if (!state) return [];",
      "    return Array.from(state.commands, ([command_id, entry]) => ({command_id, name: entry.name}));",
      "  },",
      "  async invokeCommand(id, commandId) {",
      "    const state = this.scripts.get(String(id));",
      "    const entry = state?.commands.get(String(commandId));",
      "    if (!entry) throw new Error(`userscript command not found: ${commandId}`);",
      "    return await entry.callback();",
      "  },",
      "});",
      "if (runtime.scripts.has(scriptId)) return {installed:true, alreadyInstalled:true};",
      `const storageKey = '__local_bridge_userscript_values__:' + ${JSON.stringify(scriptId)};`,
      "const readValues = () => {",
      "  try { const raw = sessionStorage.getItem(storageKey); return raw === null ? {} : JSON.parse(raw); }",
      "  catch { return {}; }",
      "};",
      "const writeValues = (values) => { sessionStorage.setItem(storageKey, JSON.stringify(values)); };",
      "const gmGetValue = (key, fallback) => { const values = readValues(); return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback; };",
      "const gmSetValue = (key, value) => { const values = readValues(); values[String(key)] = value; writeValues(values); };",
      "const gmDeleteValue = (key) => { const values = readValues(); delete values[String(key)]; writeValues(values); };",
      "const gmListValues = () => Object.keys(readValues());",
      "const state = {metadata, commands:new Map(), requests:new Map(), styles:new Set(), nextCommand:0, nextRequest:0};",
      "runtime.scripts.set(scriptId, state);",
      "const gmRegisterMenuCommand = (name, callback) => {",
      "  if (typeof callback !== 'function') throw new TypeError('GM_registerMenuCommand callback must be a function');",
      "  const commandId = `${scriptId}:${++state.nextCommand}`;",
      "  state.commands.set(commandId, {name:String(name), callback});",
      "  return commandId;",
      "};",
      "const gmUnregisterMenuCommand = (commandId) => state.commands.delete(String(commandId));",
      "const gmAddStyle = (css) => {",
      "  const style = document.createElement('style');",
      "  style.textContent = String(css);",
      "  (document.head || document.documentElement).appendChild(style);",
      "  state.styles.add(style);",
      "  return style;",
      "};",
      `const bindingName = ${JSON.stringify(bindingName)};`,
      `const rpcToken = ${JSON.stringify(rpcToken)};`,
      "const sendBinding = (payload) => {",
      "  const binding = globalThis[bindingName];",
      "  if (typeof binding !== 'function') throw new Error('Browser Bridge userscript RPC binding is unavailable');",
      "  binding(JSON.stringify(payload));",
      "};",
      "const gmXmlhttpRequest = (options = {}) => {",
      "  const requestId = `${Date.now().toString(36)}-${++state.nextRequest}`;",
      "  const normalized = {",
      "    type:'request', script_id:scriptId, request_id:requestId, token:rpcToken,",
      "    method:String(options.method || 'GET').toUpperCase(), url:String(options.url || ''),",
      "    headers:options.headers && typeof options.headers === 'object' ? options.headers : {},",
      "    data:options.data == null ? null : (typeof options.data === 'string' ? options.data : JSON.stringify(options.data)),",
      "    timeout:Number.isFinite(Number(options.timeout)) ? Math.max(0, Number(options.timeout)) : 0,",
      "    anonymous:options.anonymous === true, response_type:String(options.responseType || 'text'),",
      "  };",
      "  state.requests.set(requestId, {options});",
      "  try { sendBinding(normalized); }",
      "  catch (error) {",
      "    state.requests.delete(requestId);",
      "    queueMicrotask(() => options.onerror?.({status:0, error:error?.message || String(error)}));",
      "  }",
      "  return { abort() {",
      "    if (!state.requests.has(requestId)) return;",
      "    try { sendBinding({type:'abort', script_id:scriptId, request_id:requestId, token:rpcToken}); } catch {}",
      "  }};",
      "};",
      declarations,
      "const execute = () => {",
      "  try {",
      source,
      "  } catch (error) { runtime.scripts.delete(scriptId); throw error; }",
      "  return {installed:true, alreadyInstalled:false, commandCount:state.commands.size};",
      "};",
      "if (metadata.runAt === 'document-start') return execute();",
      "if (metadata.runAt === 'document-end') {",
      "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', execute, {once:true}); else execute();",
      "  return {installed:true, scheduled:'document-end'};",
      "}",
      "const idle = () => setTimeout(execute, 0);",
      "if (document.readyState === 'complete') idle(); else globalThis.addEventListener('load', idle, {once:true});",
      "return {installed:true, scheduled:'document-idle'};",
      "})()",
    ].join("\n");
  }

  root.LocalBridgeUserscriptRuntime = Object.freeze({
    SUPPORTED_GRANTS: Object.freeze(Array.from(SUPPORTED_GRANTS)),
    parseMetadata,
    matchPatternRegex,
    connectAllowed,
    buildBootstrap,
  });
})(globalThis);
