"use strict";

// Canonical transport source. scripts/build-extension-transport.mjs copies this
// file into the separately loadable Firefox extension; edit this source only.
(function installBridgeSocket(root) {
  function create({baseUrl, inventory, execute, status}) {
    const instanceId = crypto.randomUUID();
    const jobs = new Map();
    let connection = null;
    let running = null;
    let publishing = false;
    let publishAgain = false;
    let completionRevision = 0;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const notify = (state, error = "") => Promise.resolve(status(state, error)).catch(() => {});
    const send = (current, value) => {
      if (!current || connection !== current || !current.ready || current.socket.readyState !== WebSocket.OPEN) return false;
      current.socket.send(JSON.stringify(value));
      return true;
    };
    const snapshot = async () => ({...await inventory(), instance_id: instanceId, extension_version: (root.browser || root.chrome).runtime.getManifest().version});
    function flush(current) {
      for (const entry of jobs.values()) {
        if (entry.result) send(current, {type: "result", job: entry.job, result: entry.result});
        else send(current, {type: "progress", job_id: entry.job.job_id, phase: entry.phase});
      }
    }
    async function publish() {
      if (publishing) {publishAgain = true; return;}
      publishing = true;
      try {
        do {
          publishAgain = false;
          const current = connection;
          if (!current?.ready) break;
          const revision = completionRevision;
          send(current, {type: "inventory", snapshot: await snapshot()});
          // If a completion arrived while inventory was being read, publish
          // again before exposing results that depend on the new resources.
          if (completionRevision === revision) flush(current);
        } while (publishAgain);
      } catch (error) {
        // Inventory failure does not erase accepted jobs, completed results or
        // native Firefox handles. Reconnection has a separate lifetime.
        void notify("inventory_error", String(error?.message || error));
      } finally {publishing = false;}
    }
    function receiveJob(job) {
      const existing = jobs.get(job.job_id);
      if (existing) {void publish(); return;}
      const entry = {job, phase: "accepted", result: null};
      // Record acceptance synchronously, before any async native side effect.
      jobs.set(job.job_id, entry);
      const progress = phase => {
        entry.phase = phase;
        send(connection, {type: "progress", job_id: job.job_id, phase});
      };
      progress("accepted");
      void Promise.resolve().then(() => execute(job, progress, instanceId)).then(result => {
        entry.result = result;
        completionRevision += 1;
        void publish();
      }, error => {
        entry.result = {job_id: job.job_id, ...(job.tab_id === undefined ? {} : {tab_id: job.tab_id}),
          status: "failed", error: String(error?.message || error), outcome_unknown: true};
        completionRevision += 1;
        // Keep results across socket/service restarts until the service acks.
        void publish();
      });
    }
    async function session() {
      const address = new URL(await baseUrl());
      if (address.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.username || address.password || address.pathname !== "/" || address.search || address.hash) throw new Error("Use a loopback HTTP service origin without a path");
      const response = await fetch(new URL("/extension/bootstrap", address), {cache: "no-store", signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error("Bootstrap HTTP " + response.status);
      const credentials = await response.json();
      if (credentials.protocol !== 2 || typeof credentials.secret !== "string") throw new Error("SERVICE_UPGRADE_REQUIRED: WebSocket protocol 2 is required");
      const url = new URL("/extension/ws", address); url.protocol = "ws:";
      const socket = new WebSocket(url);
      const current = {socket, ready: false, seen: Date.now(), welcomed: false};
      connection = current;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => socket.close(1000, "Handshake timed out"), 5000);
        const heartbeat = setInterval(() => {
          if (Date.now() - current.seen > 45000) {socket.close(1000, "Heartbeat timed out"); return;}
          send(current, {type: "ping"});
          void publish();
        }, 20000); // Chrome 116+: messages keep the service worker alive.
        let failure = "WebSocket disconnected";
        socket.onopen = () => {
          void snapshot().then(value => {
            if (connection === current && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: "hello", protocol: 2, secret: credentials.secret, snapshot: value, accepted_job_ids: [...jobs.keys()],
            }));
          }).catch(error => {failure = String(error?.message || error); socket.close();});
        };
        socket.onmessage = event => {
          if (connection !== current) return;
          try {
            const message = JSON.parse(event.data);
            current.seen = Date.now();
            if (message.type === "welcome") {
              if (message.protocol !== 2) throw new Error("Incompatible WebSocket protocol");
              clearTimeout(timer); current.ready = true; current.welcomed = true;
              void notify("connected"); void publish();
            } else if (!current.ready) throw new Error("Handshake not completed");
            else if (message.type === "job") receiveJob(message.job);
            else if (message.type === "result_ack") {if (jobs.get(message.job_id)?.result) jobs.delete(message.job_id);}
            else if (message.type === "error") throw new Error(message.code + ": " + message.message);
            else if (message.type !== "pong") throw new Error("Unknown service message");
          } catch (error) {failure = String(error?.message || error); socket.close(1000, "Protocol error");}
        };
        socket.onerror = () => {failure = "WebSocket connection failed"; socket.close();};
        socket.onclose = () => {
          clearTimeout(timer); clearInterval(heartbeat);
          if (connection === current) connection = null;
          void notify("disconnected", failure);
          if (current.welcomed) resolve(); else reject(new Error(failure));
        };
      });
    }
    async function run() {
      let attempts = 0;
      while (true) {
        const start = Date.now();
        try {await session();} catch (error) {await notify("disconnected", String(error?.message || error));}
        if (Date.now() - start > 30000) attempts = 0;
        const delay = Math.min(10000, 250 * 2 ** Math.min(attempts++, 6));
        await wait(delay * (0.5 + Math.random() * 0.5));
      }
    }
    return Object.freeze({
      start() {if (!running) running = run().finally(() => {running = null;}); return running;},
      publish,
      reconnect() {connection?.socket.close(1000, "Configuration changed");},
      instanceId,
    });
  }
  root.BrowserBridgeSocket = Object.freeze({create});
})(globalThis);
