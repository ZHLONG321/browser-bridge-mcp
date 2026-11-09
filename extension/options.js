"use strict";

const fields = ['bridgeBaseUrl'];
const toggle = document.getElementById('debuggingEnabled');
const message = document.getElementById('message');
async function load() {
  const state = await chrome.storage.local.get({bridgeBaseUrl: 'http://127.0.0.1:30003', debuggingEnabled: false});
  for (const name of fields) document.getElementById(name).value = state[name];
  toggle.checked = state.debuggingEnabled;
  document.getElementById('debuggingStatus').textContent = state.debuggingEnabled ? 'Debugging is on.' : 'Debugging is off. Profiles and tabs remain discoverable.';
}
document.getElementById('form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const state = Object.fromEntries(fields.map(name => [name, document.getElementById(name).value.trim()]));
    const url = new URL(state.bridgeBaseUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Use a loopback HTTP URL without a path or credentials.');
    state.bridgeBaseUrl = url.origin;
    await chrome.storage.local.set(state);
    message.textContent = 'Saved. The background connection updates automatically.';
  } catch (error) { message.textContent = error.message; }
});
toggle.addEventListener('change', async () => {
  try {
    const response = await chrome.runtime.sendMessage({type: 'set_debugging', enabled: toggle.checked});
    if (!response?.ok) throw new Error(response?.error || 'Could not change debugging.');
    message.textContent = '';
  } catch (error) { message.textContent = error.message; }
  await load();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.debuggingEnabled) void load();
});
void load();
