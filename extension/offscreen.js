"use strict";

const POLL_WORKER_URL = chrome.runtime.getURL("poll-worker.js");
const WORKER_HEARTBEAT_TIMEOUT_MS = 15_000;
const WORKER_WATCHDOG_INTERVAL_MS = 5_000;
const WORKER_RESTART_BASE_DELAY_MS = 250;
const WORKER_RESTART_MAX_DELAY_MS = 10_000;

let pollWorker = null;
let workerRestartTimer = null;
let workerRestartAttempts = 0;
let lastWorkerHeartbeatAt = 0;

function errorText(error) {
  return error?.message || String(error || "unknown poll worker error");
}

function schedulePollWorkerRestart(reason = "poll worker unavailable") {
  const previous = pollWorker;
  pollWorker = null;
  if (previous) {
    try {
      previous.terminate();
    } catch {
      // A crashed worker may already be detached from its owner.
    }
  }
  if (workerRestartTimer !== null) return;
  const delay = Math.min(
    WORKER_RESTART_BASE_DELAY_MS * (2 ** Math.min(workerRestartAttempts, 6)),
    WORKER_RESTART_MAX_DELAY_MS,
  );
  workerRestartAttempts += 1;
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = null;
    startPollWorker();
  }, delay);
}

function startPollWorker() {
  if (pollWorker) return pollWorker;
  let candidate;
  try {
    candidate = new Worker(POLL_WORKER_URL);
  } catch (error) {
    schedulePollWorkerRestart(errorText(error));
    return null;
  }
  pollWorker = candidate;
  lastWorkerHeartbeatAt = Date.now();

  candidate.addEventListener("message", async (event) => {
    if (candidate !== pollWorker) return;
    const message = event.data;
    if (message?.type === "worker_heartbeat") {
      lastWorkerHeartbeatAt = Date.now();
      workerRestartAttempts = 0;
      return;
    }
    if (message?.type !== "extension_request") return;
    try {
      const response = await chrome.runtime.sendMessage(message.request);
      if (candidate !== pollWorker) return;
      candidate.postMessage({ type: "extension_response", id: message.id, response });
    } catch (error) {
      if (candidate !== pollWorker) return;
      candidate.postMessage({
        type: "extension_response",
        id: message.id,
        response: { ok: false, error: errorText(error) },
      });
    }
  });
  candidate.addEventListener("error", (event) => {
    if (candidate !== pollWorker) return;
    event.preventDefault?.();
    schedulePollWorkerRestart(errorText(event.error || event.message));
  });
  candidate.addEventListener("messageerror", () => {
    if (candidate !== pollWorker) return;
    schedulePollWorkerRestart("poll worker message deserialization failed");
  });
  return candidate;
}

function checkPollWorkerHealth(now = Date.now()) {
  if (!pollWorker) {
    startPollWorker();
    return;
  }
  if (now - lastWorkerHeartbeatAt > WORKER_HEARTBEAT_TIMEOUT_MS) {
    schedulePollWorkerRestart("poll worker heartbeat became stale");
  }
}

startPollWorker();
setInterval(checkPollWorkerHealth, WORKER_WATCHDOG_INTERVAL_MS);

chrome.runtime.onMessage.addListener((message) => {
  if (!["bridge_config_changed", "bridge_tabs_changed"].includes(message?.type)) return;
  const worker = pollWorker || startPollWorker();
  if (worker) {
    worker.postMessage({ type: message.type === "bridge_config_changed" ? "config_changed" : "tabs_changed" });
  }
});
