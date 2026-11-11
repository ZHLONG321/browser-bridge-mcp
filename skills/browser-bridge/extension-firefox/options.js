"use strict";
const base = document.getElementById("base");
const enabled = document.getElementById("enabled");
const statusElement = document.getElementById("status");
async function refresh() {
  const status = await browser.runtime.sendMessage({ type: "status" });
  const permissions = await browser.permissions.getAll();
  const privateAllowed = await browser.extension.isAllowedIncognitoAccess();
  statusElement.textContent = JSON.stringify({ ...status, permissions, private_allowed: privateAllowed }, null, 2);
}
document.getElementById("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = new URL(base.value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("Use the dedicated service's loopback HTTP origin without a path");
    }
    await browser.storage.local.set({ bridgeBaseUrl: url.origin, enabled: enabled.checked });
    await refresh();
  } catch (error) { statusElement.textContent = String(error); }
});
void browser.storage.local.get(["bridgeBaseUrl", "enabled"]).then((config) => {
  base.value = config.bridgeBaseUrl || "http://127.0.0.1:30003";
  enabled.checked = config.enabled === true;
  return refresh();
}).catch((error) => { statusElement.textContent = String(error); });
setInterval(() => { void refresh().catch((error) => { statusElement.textContent = String(error); }); }, 2000);
