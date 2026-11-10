import {WebSocketServer, WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';

// The HTTP API owns request validation. This module owns authenticated extension
// connections and job delivery, independently of an HTTP caller's wait lifetime.
export function extensionSockets(server, {port, tokenValid, profiles, pending, snapshot, Failure, log}) {
  const sockets = new WebSocketServer({noServer: true, maxPayload: 0, perMessageDeflate: false});
  const serviceInstance = randomUUID();
  const send = (socket, message) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };
  function deliver(profile, accepted) {
    if (profile.socket?.readyState !== WebSocket.OPEN) return;
    for (const id of profile.active) {
      const entry = pending.get(id);
      if (!entry || entry.finished || entry.error) continue;
      if (entry.job.deadline_at <= Date.now()) {
        if (accepted && !accepted.has(id)) {
          entry.phase = 'expired_before_acceptance';
          entry.error = new Failure(504, 'DEADLINE_EXCEEDED', 'The same extension execution context confirmed this expired job was never accepted.', {job_id: id, phase: entry.phase, outcome_unknown: false, terminal: true});
          profile.active.delete(id);
          entry.reject?.(entry.error);
        }
        continue;
      }
      // A reconnect to the SAME execution epoch can prove a message was never
      // accepted. Keep its ID: extension-side deduplication precedes execution.
      if (entry.dispatched && (!accepted || accepted.has(entry.job.job_id))) continue;
      entry.dispatched = true;
      entry.phase = 'dispatched';
      send(profile.socket, {type: 'job', job: entry.job});
      log('dispatched', {job_id: entry.job.job_id, profile_id: entry.profile, operation: entry.job.kind});
    }
  }
  function submit(profile) { deliver(profile); }
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || request.url !== '/extension/ws' ||
        origin && !/^(chrome-extension:\/\/[a-p]+|moz-extension:\/\/[a-f0-9-]+)$/i.test(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  });
  sockets.on('connection', socket => {
    let profile;
    let seen = Date.now();
    const authTimeout = setTimeout(() => socket.terminate(), 5000);
    const heartbeat = setInterval(() => {if (Date.now() - seen > 45000) socket.terminate();}, 15000);
    socket.on('error', () => {}); // close owns recovery; never log secrets or payloads.
    socket.on('close', () => {
      clearTimeout(authTimeout); clearInterval(heartbeat);
      if (profile?.socket === socket) {
        profile.socket = null;
        log('extension_disconnected', {profile_id: profile.identity, instance_id: profile.instance});
      }
    });
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Failure(400, 'INVALID_MESSAGE', 'Use JSON text messages.');
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Failure(400, 'INVALID_MESSAGE', 'Use a JSON object.');
        if (!profile) {
          if (message.type !== 'hello' || message.protocol !== 2 || !tokenValid(message.secret) || !Array.isArray(message.accepted_job_ids)) {
            throw new Failure(401, 'HANDSHAKE_REQUIRED', 'Bootstrap and authenticate protocol 2.');
          }
          profile = snapshot(message.snapshot);
          const previous = profile.socket;
          profile.identity = message.snapshot.profile_id;
          profile.socket = socket;
          clearTimeout(authTimeout);
          if (previous && previous !== socket) previous.close(1000, 'Connection replaced');
          send(socket, {type: 'welcome', protocol: 2, service_instance_id: serviceInstance});
          deliver(profile, new Set(message.accepted_job_ids));
          log('extension_connected', {profile_id: profile.identity, instance_id: profile.instance, extension_version: profile.extension_version});
        } else {
          if (profile.socket !== socket) return;
          if (message.type === 'inventory') {
            if (message.snapshot.profile_id !== profile.identity || message.snapshot.instance_id !== profile.instance) throw new Failure(409, 'INSTANCE_MISMATCH', 'Reconnect with a new handshake.');
            snapshot(message.snapshot);
          } else if (message.type === 'result') {
            const result = message.result, job = message.job;
            if (!job || !result || job.profile_id !== profile.identity || job.job_id !== result.job_id || job.tab_id !== result.tab_id) throw new Failure(400, 'INVALID_RESULT', 'Result selection does not match its job.');
            let entry = pending.get(job.job_id);
            // The service can restart while the extension is finishing work.
            // Import its unacknowledged result, never resend the operation.
            if (!entry) {
              entry = {job, profile: profile.identity, dispatched: true, phase: 'completed'};
              pending.set(job.job_id, entry);
            } else if (entry.profile !== profile.identity || entry.job.tab_id !== result.tab_id) throw new Failure(409, 'JOB_MISMATCH', 'Result belongs to another selection.');
            if (!entry.finished) {
              entry.receiptId = randomUUID();
              entry.result = {...result, receipt_id: entry.receiptId}; entry.finished = true; entry.delivered = false; entry.outcomeUnknown = result.outcome_unknown === true; entry.error = null; entry.phase = 'completed';
              profile.active.delete(job.job_id);
              entry.resolve?.(entry.result);
              log('completed', {job_id: job.job_id, profile_id: profile.identity});
            }
            send(socket, {type: 'result_ack', job_id: job.job_id});
          } else if (message.type === 'progress') {
            const entry = pending.get(message.job_id);
            if (entry?.profile === profile.identity && !entry.finished && !entry.error) {
              entry.phase = message.phase;
              log('job_progress', {job_id: message.job_id, profile_id: profile.identity, phase: message.phase});
            }
          } else if (message.type !== 'ping') throw new Failure(400, 'INVALID_MESSAGE', 'Unknown extension message type.');
        }
        seen = Date.now(); profile.seen = seen;
        if (message.type === 'ping') send(socket, {type: 'pong', at: seen});
      } catch (error) {
        send(socket, {type: 'error', code: error.code || 'INVALID_MESSAGE', message: error instanceof Failure ? error.message : 'Invalid extension message.'});
        socket.close(1008, 'Protocol error');
      }
    });
  });
  return {submit, serviceInstance, close() {for (const socket of sockets.clients) socket.terminate(); sockets.close();}};
}
