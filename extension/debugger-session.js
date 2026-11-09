"use strict";

(function installLocalBridgeDebuggerSession(root) {
  function create(debuggerApi, protocolVersion, options = {}) {
    const sessions = new Map();
    async function requireEnabled() {
      if (options.isEnabled && !await options.isEnabled()) {
        throw new Error("DEBUGGING_DISABLED: Enable debugging in the Browser Bridge extension.");
      }
    }

    function createState(tabId) {
      let resolveClosed;
      const closed = new Promise((resolve) => {
        resolveClosed = resolve;
      });
      const state = {
        rootSession: { tabId },
        holders: 0,
        attached: false,
        closing: false,
        closePromise: null,
        captureActive: false,
        captureDone: Promise.resolve(),
        resolveCaptureDone: null,
        closed,
        resolveClosed,
        attachPromise: null,
      };
      sessions.set(tabId, state);
      state.attachPromise = Promise.resolve()
        .then(async () => {
          await requireEnabled();
          try {
            await debuggerApi.attach(state.rootSession, protocolVersion);
          } catch (error) {
            // A restarted worker can lose its map while Chrome still owns this
            // extension's attachment. A command succeeds only for our own session.
            try { await debuggerApi.sendCommand(state.rootSession, "Runtime.getIsolateId"); }
            catch { throw error; }
          }
          state.attached = true;
          options.onStateChanged?.();
          await requireEnabled();
          await debuggerApi.sendCommand(state.rootSession, "Debugger.enable");
        })
        .catch(async (error) => {
          if (state.attached && !state.closing) {
            try {
              await debuggerApi.detach(state.rootSession);
            } catch {
              // A target that disappeared while Debugger.enable failed is already detached.
            }
          }
          state.attached = false;
          options.onStateChanged?.();
          if (sessions.get(tabId) === state) sessions.delete(tabId);
          state.resolveClosed();
          throw error;
        });
      return state;
    }

    function beginCapture(state) {
      let resolveCaptureDone;
      state.captureDone = new Promise((resolve) => {
        resolveCaptureDone = resolve;
      });
      state.resolveCaptureDone = resolveCaptureDone;
      state.captureActive = true;
    }

    function finishCapture(state) {
      if (!state.captureActive) return;
      state.captureActive = false;
      state.resolveCaptureDone?.();
      state.resolveCaptureDone = null;
    }

    async function closeState(tabId, state) {
      if (state.closePromise) return state.closePromise;
      state.closing = true;
      state.closePromise = (async () => {
        try {
          // An established attachment must detach immediately, even if a command is pending.
          if (!state.attached) {
            try { await state.attachPromise; } catch { /* A failed initializer can still own an attachment. */ }
          }
          if (state.attached) await debuggerApi.detach(state.rootSession);
        } catch {
          // A failed attach or already-detached target is already closed from the coordinator's perspective.
        } finally {
          state.attached = false;
          options.onStateChanged?.();
          if (sessions.get(tabId) === state) sessions.delete(tabId);
          finishCapture(state);
          state.resolveClosed();
        }
      })();
      return state.closePromise;
    }

    async function acquire(tabId, options = {}) {
      if (!Number.isInteger(tabId)) throw new Error("Debugger tab ID must be an integer");
      const capture = options.capture === true;
      while (true) {
        await requireEnabled();
        let state = sessions.get(tabId);
        if (state?.closing) {
          await state.closed;
          continue;
        }
        if (state?.captureActive) {
          await state.captureDone;
          continue;
        }
        if (!state) state = createState(tabId);
        if (capture) beginCapture(state);
        state.holders += 1;
        try {
          await state.attachPromise;
          await requireEnabled();
        } catch (error) {
          state.holders = Math.max(0, state.holders - 1);
          if (capture) finishCapture(state);
          throw error;
        }
        if (sessions.get(tabId) !== state || !state.attached) {
          state.holders = Math.max(0, state.holders - 1);
          if (capture) finishCapture(state);
          continue;
        }

        let released = false;
        return {
          rootSession: state.rootSession,
          async release() {
            if (released) return;
            released = true;
            state.holders = Math.max(0, state.holders - 1);
            if (capture) {
              // Keep the attachment until the user disables debugging or the browser disconnects it.
              finishCapture(state);
              return;
            }
            // Normal jobs share one persistent attachment per tab. If Chrome or DevTools detaches it,
            // onDetach removes this state and the next acquire creates a fresh attachment automatically.
          },
        };
      }
    }

    debuggerApi.onDetach?.addListener((source) => {
      const tabId = source?.tabId;
      if (!Number.isInteger(tabId)) return;
      const state = sessions.get(tabId);
      if (!state) return;
      state.attached = false;
      options.onStateChanged?.();
      if (state.closing) return;
      if (sessions.get(tabId) === state) sessions.delete(tabId);
      finishCapture(state);
      state.resolveClosed();
    });

    async function reset(tabId) {
      const state = sessions.get(tabId);
      if (!state) return;
      await closeState(tabId, state);
    }

    async function detachAll() {
      await Promise.all([...sessions.entries()].map(([tabId, state]) => closeState(tabId, state)));
    }
    async function attachedTabIds() {
      const targets = await debuggerApi.getTargets();
      const attached = new Set(targets.filter(target => target.attached).map(target => target.tabId));
      return [...sessions.entries()]
        .filter(([tabId, state]) => state.attached && !state.closing && attached.has(tabId))
        .map(([tabId]) => tabId);
    }
    return Object.freeze({ acquire, reset, detachAll, attachedTabIds });
  }

  root.LocalBridgeDebuggerSession = Object.freeze({ create });
})(globalThis);
