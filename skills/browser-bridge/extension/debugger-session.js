"use strict";

(function installLocalBridgeDebuggerSession(root) {
  function create(debuggerApi, protocolVersion, options = {}) {
    const sessions = new Map();
    const changed = () => options.onStateChanged?.();
    async function requireEnabled() {
      if (options.isEnabled && !await options.isEnabled()) throw new Error("DEBUGGING_DISABLED: Enable debugging in the Browser Bridge extension.");
    }
    function check(signal) {if (signal?.aborted) throw signal.reason;}
    async function waitFor(promise, signal) {
      if (!signal) return await promise;
      check(signal);
      let abort;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, {once: true});
        })]);
      } finally {if (abort) signal.removeEventListener("abort", abort);}
    }
    function finishCapture(state) {
      state.captureActive = false;
      state.resolveCaptureDone?.(); state.resolveCaptureDone = null;
    }
    function finalize(tabId, state) {
      // Never allow a replacement while an old attach can still complete, or
      // while Chrome has not confirmed that our native attachment was released.
      if (!state.closing || !state.attachSettled || !state.detachConfirmed) return;
      if (sessions.get(tabId) === state) sessions.delete(tabId);
      finishCapture(state); state.resolveClosed(); changed();
    }
    function closeState(tabId, state) {
      state.closing = true; state.phase = "closing"; finishCapture(state); changed();
      if (sessions.get(tabId) !== state || state.detachPending) return;
      state.detachPending = true;
      const attachSettledAtDetach = state.attachSettled;
      void Promise.resolve().then(() => debuggerApi.detach(state.rootSession)).then(() => {
        // A detach that finished BEFORE an outstanding attach is not proof that
        // the late attach cannot create another native attachment.
        if (attachSettledAtDetach) {state.detachConfirmed = true; state.attached = false;}
      }, () => {
        if (attachSettledAtDetach && !state.attached) state.detachConfirmed = true;
      }).finally(() => {
        state.detachPending = false;
        finalize(tabId, state);
        if (!attachSettledAtDetach && state.attachSettled && state.attached && sessions.get(tabId) === state) closeState(tabId, state);
      });
    }
    function createState(tabId, request) {
      let resolveClosed;
      const closed = new Promise(resolve => {resolveClosed = resolve;});
      const state = {rootSession: {tabId}, holders: 0, attached: false, closing: false,
        attachSettled: false, detachPending: false, detachConfirmed: false,
        phase: "attaching", captureActive: false, captureDone: Promise.resolve(),
        resolveCaptureDone: null, closed, resolveClosed, attachPromise: null};
      sessions.set(tabId, state);
      state.attachPromise = Promise.resolve().then(async () => {
        await requireEnabled();
        if (state.closing) throw new Error("DEBUGGER_RECOVERY_PENDING: Attachment was canceled.");
        request.beforeAttach?.();
        try {await debuggerApi.attach(state.rootSession, protocolVersion);}
        catch (error) {
          // Only our own attachment accepts this command after worker restart.
          if (state.closing) throw error;
          try {await debuggerApi.sendCommand(state.rootSession, "Runtime.getIsolateId");}
          catch {throw error;}
        }
        state.detachConfirmed = false; state.attached = true; changed();
        await requireEnabled();
        if (state.closing) throw new Error("DEBUGGER_RECOVERY_PENDING: Attachment was canceled.");
        // Enabling the JavaScript Debugger domain is a caller's explicit CDP
        // operation. Runtime/Page operations only require the owned attachment.
        state.phase = "attached";
      }).catch(error => {
        state.closing = true;
        throw error;
      }).finally(() => {
        state.attachSettled = true;
        if (state.closing) {
          if (!state.attached && !state.detachPending) state.detachConfirmed = true;
          if (state.attached && sessions.get(tabId) === state) closeState(tabId, state);
          finalize(tabId, state);
        }
      });
      return state;
    }
    async function acquire(tabId, request = {}) {
      if (!Number.isInteger(tabId)) throw new Error("Debugger tab ID must be an integer");
      const signal = request.signal;
      check(signal); await requireEnabled(); check(signal);
      let state = sessions.get(tabId);
      if (state?.closing) {
        closeState(tabId, state);
        throw new Error("DEBUGGER_RECOVERY_PENDING: Chrome has not confirmed release of this tab's attachment. Other tabs remain available; do not reload or repeat mutations blindly.");
      }
      if (state?.captureActive) {
        await waitFor(state.captureDone, signal);
        return await acquire(tabId, request);
      }
      if (!state) state = createState(tabId, request);
      const capture = request.capture === true;
      if (capture) {
        state.captureActive = true;
        state.captureDone = new Promise(resolve => {state.resolveCaptureDone = resolve;});
      }
      state.holders += 1;
      request.progress?.(state.phase);
      try {
        await waitFor(state.attachPromise, signal);
        check(signal); await requireEnabled(); check(signal);
        if (state.closing || sessions.get(tabId) !== state || !state.attached) throw new Error("DEBUGGER_SESSION_CHANGED: Resolve the tab again before another operation.");
      } catch (error) {
        state.holders = Math.max(0, state.holders - 1);
        if (capture) finishCapture(state);
        if (signal?.aborted && !state.attachSettled && !state.holders) closeState(tabId, state);
        throw error;
      }
      let released = false;
      return {
        rootSession: {...state.rootSession},
        valid() {return !state.closing && sessions.get(tabId) === state && state.attached;},
        async release() {
          if (released) return;
          released = true; state.holders = Math.max(0, state.holders - 1);
          if (capture) finishCapture(state);
        },
      };
    }
    debuggerApi.onDetach?.addListener(source => {
      const tabId = source?.tabId, state = sessions.get(tabId);
      if (!state) return;
      state.attached = false; state.closing = true; state.detachConfirmed = state.attachSettled;
      finishCapture(state); finalize(tabId, state); changed();
    });
    async function reset(tabId) {const state = sessions.get(tabId); if (state) closeState(tabId, state);}
    async function detachAll() {for (const [tabId, state] of sessions) closeState(tabId, state);}
    async function attachedTabIds() {
      const targets = await debuggerApi.getTargets();
      const attached = new Set(targets.filter(target => target.attached).map(target => target.tabId));
      for (const [tabId, state] of sessions) {
        if (state.closing && state.attachSettled && !attached.has(tabId)) {state.detachConfirmed = true; finalize(tabId, state);}
      }
      return [...sessions].filter(([tabId, state]) => state.attached && !state.closing && attached.has(tabId)).map(([tabId]) => tabId);
    }
    return Object.freeze({acquire, reset, detachAll, attachedTabIds});
  }
  root.LocalBridgeDebuggerSession = Object.freeze({create});
})(globalThis);
