"use strict";

globalThis.BrowserBridgeDebuggingStatus = Object.freeze({
  async read() {
    const response = await chrome.runtime.sendMessage({type: "get_debugging_state"});
    if (!response?.ok) throw new Error(response?.error || "Could not read debugging connection status.");
    return response.value;
  },
  text(state) {
    if (!state.enabled) return "Debugging is disabled. Profiles and tabs remain discoverable.";
    const count = state.attached_tab_ids.length;
    if (!count) return "Debugging is enabled. No page is connected; the next authorized operation will connect automatically.";
    return `Debugging is connected to ${count} ${count === 1 ? "tab" : "tabs"}.`;
  },
});
