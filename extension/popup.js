"use strict";

async function refresh() {
  const state = await chrome.storage.local.get({
    bridgeBaseUrl: "",
    bridgeStatus: "unknown",
    bridgeLastError: "",
    bridgeTabCount: 0,
    debuggingEnabled: false,
  });
  document.getElementById("status").textContent = state.bridgeStatus;
  document.getElementById("base").textContent = state.bridgeBaseUrl || "Not configured";
  document.getElementById("tabs").textContent = String(state.bridgeTabCount || 0);
  document.getElementById("error").textContent = state.bridgeLastError || "None";
  document.getElementById("debuggingEnabled").checked = state.debuggingEnabled === true;
  document.getElementById("debuggingStatus").textContent = state.debuggingEnabled === true
    ? "Debugging is on. Browser controls are available."
    : "Debugging is off. Page controls are unavailable.";
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
