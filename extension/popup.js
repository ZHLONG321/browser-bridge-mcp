"use strict";

let refreshRevision = 0;
async function refresh() {
  const revision = ++refreshRevision;
  const state = await chrome.storage.local.get({
    bridgeBaseUrl: "",
    bridgeStatus: "unknown",
    bridgeLastError: "",
    bridgeTabCount: 0,
    debuggingEnabled: false,
  });
  if (revision !== refreshRevision) return;
  document.getElementById("status").textContent = state.bridgeStatus;
  document.getElementById("base").textContent = state.bridgeBaseUrl || "Not configured";
  document.getElementById("tabs").textContent = String(state.bridgeTabCount || 0);
  document.getElementById("error").textContent = state.bridgeLastError || "None";
  document.getElementById("debuggingEnabled").checked = state.debuggingEnabled === true;
  try {
    const debugging = await BrowserBridgeDebuggingStatus.read();
    if (revision !== refreshRevision) return;
    document.getElementById("debuggingEnabled").checked = debugging.enabled;
    document.getElementById("debuggingStatus").textContent = BrowserBridgeDebuggingStatus.text(debugging);
  } catch (error) {
    if (revision === refreshRevision) document.getElementById("debuggingStatus").textContent = `Debugging connection status unavailable: ${error.message}`;
  }
}

document.getElementById("debuggingEnabled").addEventListener("change", async (event) => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "set_debugging", enabled: event.target.checked });
    if (!response?.ok) throw new Error(response?.error || "Could not change debugging setting.");
    await refresh();
  } catch (error) {
    await refresh();
    document.getElementById("debuggingStatus").textContent = error?.message || "Could not change debugging setting.";
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local") void refresh();
});

document.getElementById("options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void refresh();
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "debugging_state_changed") void refresh();
});
setInterval(() => { void refresh(); }, 2000);
