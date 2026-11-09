"use strict";
const base = document.getElementById("base");
const enabled = document.getElementById("enabled");
const statusElement = document.getElementById("status");
const permissionBox = document.getElementById("permissions");
const optional = browser.runtime.getManifest().optional_permissions || [];
for (const permission of optional) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = permission;
  input.checked = true;
  label.append(input, document.createTextNode(" " + permission));
  permissionBox.append(label);
}
function requestSelectedPermissions() {
  const chosen = [...permissionBox.querySelectorAll("input:checked:not(:disabled)")].map((input) => input.value);
  // Call directly within the user's gesture, before any await.
  return chosen.length ? browser.permissions.request({
    permissions: chosen.filter((item) => item !== "<all_urls>"),
    origins: chosen.includes("<all_urls>") ? ["<all_urls>"] : []
  }) : Promise.resolve(true);
}
async function refresh() {
  const status = await browser.runtime.sendMessage({ type: "status" });
  const permissions = await browser.permissions.getAll();
  statusElement.textContent = JSON.stringify({ ...status, permissions }, null, 2);
  for (const input of permissionBox.querySelectorAll("input")) {
    const granted = [...permissions.permissions, ...(permissions.origins || [])].includes(input.value);
    if (granted || input.disabled) input.checked = granted;
    input.disabled = granted;
  }
}
document.getElementById("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = new URL(base.value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("Use the dedicated service's loopback HTTP origin without a path");
    }
    if (enabled.checked && !(await requestSelectedPermissions())) {
      throw new Error("Firefox did not grant the selected permissions. Settings were not saved.");
    }
    await browser.storage.local.set({ bridgeBaseUrl: url.origin, enabled: enabled.checked });
    await refresh();
  } catch (error) { statusElement.textContent = String(error); }
});
document.getElementById("grant").addEventListener("click", async () => {
  try {
    if (!(await requestSelectedPermissions())) throw new Error("Firefox did not grant the selected permissions.");
    await refresh();
  } catch (error) { statusElement.textContent = String(error); }
});
void browser.storage.local.get(["bridgeBaseUrl", "enabled"]).then((config) => {
  base.value = config.bridgeBaseUrl || "http://127.0.0.1:30003";
  enabled.checked = config.enabled === true;
  return refresh();
}).catch((error) => { statusElement.textContent = String(error); });
setInterval(() => { void refresh().catch((error) => { statusElement.textContent = String(error); }); }, 2000);
