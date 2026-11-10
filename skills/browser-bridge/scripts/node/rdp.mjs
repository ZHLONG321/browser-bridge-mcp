// Firefox's TCP packet stream is separate from extension profile identity.
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const RETAINED_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const scopes = {tabs: 'listTabs', addons: 'listAddons', workers: 'listWorkers', processes: 'listProcesses', service_workers: 'listServiceWorkerRegistrations'};
export class NativeError extends Error {
  constructor(message, status = 400, code = 'INVALID_NATIVE_REQUEST', extra = {}) {
    super(message); Object.assign(this, {status, code, extra});
  }
}
function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new NativeError(`${name} must be an integer in ${minimum}..${maximum}.`);
  return value;
}
function cursor(value, sequence) {
  const after = value ?? sequence;
  integer(after, 'after');
  if (after > sequence) throw new NativeError('after is beyond this connection\'s current cursor.');
  return after;
}

class Connection {
  constructor(host, port, socket) {
    Object.assign(this, {host, port, socket, id: 'firefox-rdp:' + randomUUID(), greeting: null, error: null, sequence: 0, entries: [], bytes: 0, input: Buffer.alloc(0), frame: null, sendChain: Promise.resolve()});
    this.ready = new Promise(resolve => {this.signalReady = resolve;});
    socket.on('data', data => {
      try {this.input = Buffer.concat([this.input, data]); this.parse();}
      catch (error) {this.error = error.message; socket.destroy(); this.signalReady();}
    });
    socket.on('error', error => {this.error = error.message; this.signalReady();});
    socket.on('close', () => {this.error ??= 'RDP connection closed.'; this.signalReady();});
  }
  get connected() {return !!this.greeting && !this.error && !this.socket.destroyed;}
  describe() {
    return {connection_id: this.id, browser: 'firefox', protocol: 'rdp', host: this.host, port: this.port, connected: this.connected, greeting: this.greeting || {}, next_cursor: this.sequence, error: this.error, state: this.connected ? 'connected' : this.error || this.socket.destroyed ? 'closed' : 'connecting'};
  }
  append(entry) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    this.entries.push({sequence: ++this.sequence, ...entry, _bytes: size}); this.bytes += size;
    while (this.bytes > RETAINED_BYTES && this.entries.length) this.bytes -= this.entries.shift()._bytes;
  }
  parse() {
    while (true) {
      if (!this.frame) {
        const end = this.input.indexOf(58);
        if (end < 0) {
          if (this.input.length > RETAINED_BYTES) throw new Error('Invalid RDP transport header.');
          return;
        }
        const header = this.input.subarray(0, end).toString('ascii');
        this.input = this.input.subarray(end + 1);
        if (/^\d+$/.test(header)) {
          const length = Number(header);
          if (!Number.isSafeInteger(length) || length > RETAINED_BYTES) throw new Error('RDP JSON frame exceeds the 8 MiB memory budget; use native bulk APIs.');
          this.frame = {kind: 'json', length};
        } else {
          const match = /^bulk ([^: ]+) ([^: ]+) (\d+)$/.exec(header);
          if (!match || !this.greeting || !Number.isSafeInteger(Number(match[3]))) throw new Error('Invalid RDP bulk header.');
          this.frame = {kind: 'bulk', actor: match[1], type: match[2], length: Number(match[3]), offset: 0, transfer_id: randomUUID()};
        }
      }
      const frame = this.frame;
      const size = frame.kind === 'json' ? frame.length : Math.min(CHUNK_BYTES, frame.length - frame.offset);
      if (this.input.length < size) return;
      const data = this.input.subarray(0, size); this.input = this.input.subarray(size);
      if (frame.kind === 'json') {
        const packet = JSON.parse(utf8.decode(data));
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('RDP JSON packet must be an object.');
        if (!this.greeting) {
          if (packet.from !== 'root' || packet.applicationType !== 'browser') throw new Error('Not a Firefox browser RDP greeting; check TCP RDP port, not BiDi/WebSocket.');
          this.greeting = packet; this.signalReady();
        }
        this.append({kind: 'json', packet}); this.frame = null;
      } else {
        this.append({kind: 'bulk', transfer_id: frame.transfer_id, actor: frame.actor, type: frame.type, length: frame.length, offset: frame.offset, data_base64: data.toString('base64'), final: frame.offset + size === frame.length});
        frame.offset += size;
        if (frame.offset === frame.length) this.frame = null;
      }
    }
  }
  close() {this.socket.destroy();}
  async exchange(body) {
    const packets = body.packets ?? [];
    if (!Array.isArray(packets) || packets.some(p => !p || typeof p !== 'object' || typeof p.to !== 'string' || !p.to || typeof p.type !== 'string' || !p.type)) throw new NativeError('Each packet requires nonempty to/type strings.');
    const encoded = packets.map(packet => Buffer.from(JSON.stringify(packet), 'utf8'));
    let bulk = null;
    if (body.bulk !== undefined && body.bulk !== null) {
      const b = body.bulk;
      if (typeof b.actor !== 'string' || !/^[^: ]+$/.test(b.actor) || typeof b.type !== 'string' || !/^[^: ]+$/.test(b.type) || typeof b.data_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.data_base64)) throw new NativeError('bulk requires actor, type and standard data_base64.');
      bulk = {actor: b.actor, type: b.type, data: Buffer.from(b.data_base64, 'base64')};
    }
    const wait = integer(body.wait_ms ?? 500, 'wait_ms', 0, 15000);
    let after;
    const send = async () => {
      after = cursor(body.after, this.sequence);
      if (!encoded.length && !bulk) return;
      if (!this.connected) throw new NativeError('RDP connection closed; poll retained packets or explicitly reconnect.', 409, 'RDP_CLOSED');
      const write = data => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RDP send timed out.')), 5000);
        this.socket.write(data, error => {clearTimeout(timer); error ? reject(error) : resolve();});
      });
      try {
        for (const data of encoded) await write(Buffer.concat([Buffer.from(`${data.length}:`), data]));
        if (bulk) {
          await write(Buffer.from(`bulk ${bulk.actor} ${bulk.type} ${bulk.data.length}:`));
          for (let offset = 0; offset < bulk.data.length; offset += CHUNK_BYTES) await write(bulk.data.subarray(offset, offset + CHUNK_BYTES));
        }
      } catch {
        this.error = 'RDP send interrupted; delivery is uncertain. Do not replay automatically.';
        this.close(); throw new NativeError(this.error, 502, 'RDP_SEND_UNCERTAIN', {outcome_unknown: true});
      }
    };
    const sending = this.sendChain.then(send); this.sendChain = sending.catch(() => {}); await sending;
    if (wait) await sleep(wait);
    const oldest = this.entries[0]?.sequence ?? this.sequence + 1;
    return {status: 'completed', ...this.describe(), after, oldest_cursor: oldest, gap: after < oldest - 1, retained_bytes_limit: RETAINED_BYTES, sent_count: packets.length + Number(!!bulk), packets: this.entries.filter(entry => entry.sequence > after).map(({_bytes, ...entry}) => entry), note: 'Ordered native stream, not command completions. Poll next_cursor for later replies/events.'};
  }
}

export class RdpManager {
  connections = new Map();
  connecting = new Map();
  closed = false;
  inventory() {return [...this.connections.values()].map(c => c.describe());}
  get(id) {
    if (typeof id !== 'string' || !id) throw new NativeError('connection_id must be a nonempty string.');
    const connection = this.connections.get(id);
    if (!connection) throw new NativeError('Unknown RDP connection_id; use discover.', 404, 'RDP_NOT_FOUND');
    return connection;
  }
  close() {this.closed = true; for (const c of this.connections.values()) c.close(); this.connections.clear();}
  async discover(body) {
    if (this.closed) throw new NativeError('Server is stopping.', 409, 'SERVER_STOPPING');
    if (body.connection_id && body.rdp_port !== undefined) throw new NativeError('Use connection_id or rdp_port, not both.');
    const wait = integer(body.wait_ms ?? 500, 'wait_ms', 0, 15000);
    if (body.actor !== undefined && (typeof body.actor !== 'string' || !body.actor)) throw new NativeError('actor must be a nonempty string.');
    if (!Object.hasOwn(scopes, body.scope ?? 'tabs') && !body.actor) throw new NativeError('Unknown discovery scope.');
    let connection;
    const started = Date.now();
    if (body.rdp_port !== undefined) {
      const port = integer(body.rdp_port, 'rdp_port', 1, 65535), host = body.rdp_host ?? '127.0.0.1';
      if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new NativeError('rdp_host must be loopback.');
      connection = [...this.connections.values()].find(c => c.host === host && c.port === port && !c.error && !c.socket.destroyed);
      if (!connection) {
        if (body.allow_foreground !== true) throw new NativeError('A new RDP connection may show Firefox\'s confirmation dialog. Obtain permission and pass allow_foreground: true.', 403, 'PROMPT_AUTHORIZATION_REQUIRED');
        const key = `${host}:${port}`;
        if (!this.connecting.has(key)) {
          const opening = new Promise((resolve, reject) => {
            const socket = createConnection({host, port});
            const timer = setTimeout(() => socket.destroy(new Error('TCP connection timed out.')), 5000);
            socket.once('error', error => {clearTimeout(timer); reject(new NativeError(error.message, 502, 'RDP_CONNECT_FAILED'));});
            socket.once('connect', () => {
              clearTimeout(timer);
              if (this.closed) {socket.destroy(); reject(new NativeError('Server is stopping.', 409, 'SERVER_STOPPING')); return;}
              const c = new Connection(host, port, socket); this.connections.set(c.id, c); resolve(c);
            });
          }).finally(() => this.connecting.delete(key));
          this.connecting.set(key, opening);
        }
        connection = await this.connecting.get(key);
      }
    } else if (body.connection_id) connection = this.get(body.connection_id);
    else {
      if (body.actor) throw new NativeError('Actor discovery requires connection_id or rdp_port.');
      return {status: 'completed', connections: this.inventory()};
    }
    if (wait) await Promise.race([connection.ready, sleep(wait)]);
    if (!connection.connected) return {status: connection.error ? 'failed' : 'connecting', ...connection.describe(), note: 'Accept the authorized Firefox prompt, then inspect this same connection_id. No requests sent.'};
    const packets = [{to: body.actor || 'root', type: 'requestTypes'}];
    if (!body.actor) packets.push({to: 'root', type: 'getRoot'}, {to: 'root', type: scopes[body.scope ?? 'tabs']});
    const result = await connection.exchange({packets, after: body.after, wait_ms: Math.max(0, wait - (Date.now() - started))});
    return {...result, discovery_requests: packets};
  }
  async execute(body) {
    if (!['read_only', 'authorized_mutation'].includes(body.mode ?? 'read_only')) throw new NativeError('Invalid mode.');
    const connection = this.get(body.connection_id);
    if (body.action === 'disconnect') {
      if (body.packets?.length || body.bulk) throw new NativeError('disconnect does not accept packets or bulk.');
      connection.close(); this.connections.delete(connection.id);
      return {status: 'completed', connection_id: connection.id, connected: false};
    }
    if (body.action !== undefined && body.action !== 'exchange') throw new NativeError('Use exchange or disconnect.');
    return connection.exchange(body);
  }
}
