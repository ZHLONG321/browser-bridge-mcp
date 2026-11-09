"""Firefox TCP RDP streams; no command correlation, automatic replay or profile guessing."""

from __future__ import annotations

import base64
import binascii
import json
import socket
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import BinaryIO

from browser_bridge import Json, JsonObject, read_json  # pyright: ignore[reportImplicitRelativeImport]

RETAINED_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
SCOPES = {"tabs": "listTabs", "addons": "listAddons", "workers": "listWorkers", "processes": "listProcesses", "service_workers": "listServiceWorkerRegistrations"}


class RdpError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "INVALID_NATIVE_REQUEST", **extra: Json) -> None:
        super().__init__(message)
        self.status: int = status
        self.body: JsonObject = {"code": code, "message": message, **extra}


def integer(value: Json, name: str, minimum: int = 0, maximum: int = 2**53 - 1) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise RdpError(f"{name} must be an integer in {minimum}..{maximum}.")
    return value


def text(value: Json, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise RdpError(f"{name} must be a nonempty string.")
    return value


@dataclass
class Entry:
    sequence: int
    body: JsonObject
    size: int


class Connection:
    """One accepted or pending listener connection, with a retained ordered stream."""

    def __init__(self, host: str, port: int, stream: socket.socket) -> None:
        self.host: str = host
        self.port: int = port
        self.stream: socket.socket = stream
        self.reader: BinaryIO = stream.makefile("rb")
        self.identity: str = "firefox-rdp:" + str(uuid.uuid4())
        self.greeting: JsonObject = {}
        self.error: str | None = None
        self.closed: bool = False
        self.ready: threading.Event = threading.Event()
        self.lock: threading.RLock = threading.RLock()
        self.send_lock: threading.Lock = threading.Lock()
        self.entries: deque[Entry] = deque()
        self.sequence: int = 0
        self.retained: int = 0
        threading.Thread(target=self.read, daemon=True, name="firefox-rdp-reader").start()

    @property
    def connected(self) -> bool:
        return bool(self.greeting) and self.error is None and not self.closed

    def describe(self) -> JsonObject:
        with self.lock:
            return {"connection_id": self.identity, "browser": "firefox", "protocol": "rdp", "host": self.host, "port": self.port,
                    "connected": self.connected, "greeting": self.greeting, "next_cursor": self.sequence, "error": self.error,
                    "state": "connected" if self.connected else "closed" if self.closed or self.error else "connecting"}

    def append(self, body: JsonObject) -> None:
        size = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
        with self.lock:
            self.sequence += 1
            self.entries.append(Entry(self.sequence, body, size))
            self.retained += size
            while self.retained > RETAINED_BYTES and self.entries:
                self.retained -= self.entries.popleft().size

    def exact(self, length: int) -> bytes:
        data = self.reader.read(length)
        if len(data) != length:
            raise EOFError("RDP connection ended inside a frame.")
        return data

    def packet(self) -> JsonObject:
        header = bytearray()
        while True:
            byte = self.exact(1)
            if byte == b":":
                break
            header.extend(byte)
            if len(header) > RETAINED_BYTES:
                raise ValueError("Invalid RDP header.")
        wire = header.decode("ascii")
        if wire.isdecimal():
            length = int(wire)
            if length > RETAINED_BYTES:
                raise ValueError("RDP JSON frame exceeds the 8 MiB memory budget; use native bulk APIs.")
            return read_json(self.exact(length).decode("utf-8"))
        parts = wire.split(" ")
        if len(parts) != 4 or parts[0] != "bulk" or not parts[1] or not parts[2] or not parts[3].isdecimal() or not self.greeting:
            raise ValueError("Invalid RDP bulk header.")
        length, offset = int(parts[3]), 0
        transfer_id = str(uuid.uuid4())
        while offset < length or length == 0:
            chunk = self.exact(min(CHUNK_BYTES, length - offset))
            self.append({"kind": "bulk", "transfer_id": transfer_id, "actor": parts[1], "type": parts[2], "length": length, "offset": offset,
                         "data_base64": base64.b64encode(chunk).decode("ascii"), "final": offset + len(chunk) == length})
            offset += len(chunk)
            if length == 0:
                break
        return {}

    def read(self) -> None:
        try:
            greeting = self.packet()
            if greeting.get("from") != "root" or greeting.get("applicationType") != "browser":
                raise ValueError("Not a Firefox browser RDP greeting; check TCP RDP port, not BiDi/WebSocket.")
            self.greeting = greeting
            self.append({"kind": "json", "packet": greeting})
            self.ready.set()
            while not self.closed:
                packet = self.packet()
                if packet:
                    self.append({"kind": "json", "packet": packet})
        except (OSError, ValueError, EOFError) as error:
            self.error = str(error)
        finally:
            self.ready.set()
            self.close()
            self.reader.close()

    def close(self) -> None:
        self.closed = True
        try:
            self.stream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # The reader or peer may already have closed this exact socket.
        self.stream.close()
        self.ready.set()

    def exchange(self, body: JsonObject) -> JsonObject:
        raw = body.get("packets", [])
        if not isinstance(raw, list):
            raise RdpError("packets must be an array.")
        packets: list[JsonObject] = []
        for item in raw:
            if not isinstance(item, dict):
                raise RdpError("Each packet requires nonempty to/type strings.")
            _ = text(item.get("to"), "to")
            _ = text(item.get("type"), "type")
            packets.append(item)
        try:
            encoded = [json.dumps(p, ensure_ascii=False, allow_nan=False).encode("utf-8") for p in packets]
        except ValueError:
            raise RdpError("RDP packets must contain valid finite JSON values.") from None
        bulk = body.get("bulk")
        data: bytes | None = None
        actor, kind = "", ""
        if bulk is not None:
            if not isinstance(bulk, dict):
                raise RdpError("bulk must be an object.")
            actor, kind = text(bulk.get("actor"), "actor"), text(bulk.get("type"), "type")
            if any(char in actor + kind for char in ": "):
                raise RdpError("bulk actor/type cannot contain spaces or colons.")
            encoded_bulk = bulk.get("data_base64")
            if not isinstance(encoded_bulk, str):
                raise RdpError("bulk data_base64 must be standard base64.")
            try:
                data = base64.b64decode(encoded_bulk, validate=True)
            except (ValueError, binascii.Error):
                raise RdpError("bulk data_base64 must be standard base64.") from None
        wait = integer(body.get("wait_ms", 500), "wait_ms", 0, 15000)
        with self.send_lock:
            with self.lock:
                after = integer(self.sequence if body.get("after") is None else body["after"], "after")
                if after > self.sequence:
                    raise RdpError("after is beyond this connection's current cursor.")
            if encoded or data is not None:
                if not self.connected:
                    raise RdpError("RDP connection closed; poll retained packets or explicitly reconnect.", 409, "RDP_CLOSED")
                try:
                    # A send deadline must not interrupt the independent receive loop.
                    for packet in encoded:
                        self.send_all(str(len(packet)).encode("ascii") + b":" + packet)
                    if data is not None:
                        self.send_all(f"bulk {actor} {kind} {len(data)}:".encode("utf-8"))
                        for offset in range(0, len(data), CHUNK_BYTES):
                            self.send_all(data[offset:offset + CHUNK_BYTES])
                except (OSError, ValueError):
                    self.error = "RDP send interrupted; delivery is uncertain. Do not replay automatically."
                    self.close()
                    raise RdpError(self.error, 502, "RDP_SEND_UNCERTAIN", outcome_unknown=True) from None
        time.sleep(wait / 1000)
        with self.lock:
            oldest = self.entries[0].sequence if self.entries else self.sequence + 1
            entries: list[Json] = [{"sequence": entry.sequence, **entry.body} for entry in self.entries if entry.sequence > after]
            return {"status": "completed", **self.describe(), "after": after, "oldest_cursor": oldest, "gap": after < oldest - 1,
                    "retained_bytes_limit": RETAINED_BYTES, "sent_count": len(packets) + int(data is not None), "packets": entries,
                    "note": "Ordered native stream, not command completions. Poll next_cursor for later replies/events."}

    def send_all(self, data: bytes) -> None:
        import select

        deadline = time.monotonic() + 5
        remaining = memoryview(data)
        while remaining:
            timeout = deadline - time.monotonic()
            if timeout <= 0 or not select.select([], [self.stream], [], max(0, timeout))[1]:
                raise TimeoutError("RDP send timed out.")
            sent = self.stream.send(remaining[:CHUNK_BYTES])
            if sent == 0:
                raise ConnectionError("RDP socket closed during send.")
            remaining = remaining[sent:]


class RdpManager:
    def __init__(self) -> None:
        self.connections: dict[str, Connection] = {}
        self.lock: threading.Lock = threading.Lock()

    def inventory(self) -> list[Json]:
        with self.lock:
            return [connection.describe() for connection in self.connections.values()]

    def get(self, identity: Json) -> Connection:
        with self.lock:
            connection = self.connections.get(text(identity, "connection_id"))
        if connection is None:
            raise RdpError("Unknown RDP connection_id; use discover.", 404, "RDP_NOT_FOUND")
        return connection

    def close(self) -> None:
        with self.lock:
            for connection in self.connections.values():
                connection.close()
            self.connections.clear()

    def discover(self, body: JsonObject) -> JsonObject:
        if body.get("connection_id") and "rdp_port" in body:
            raise RdpError("Use connection_id or rdp_port, not both.")
        wait = integer(body.get("wait_ms", 500), "wait_ms", 0, 15000)
        actor = text(body["actor"], "actor") if "actor" in body else None
        scope = text(body.get("scope", "tabs"), "scope")
        if not actor and scope not in SCOPES:
            raise RdpError("Unknown discovery scope.")
        started = time.monotonic()
        if "rdp_port" in body:
            port = integer(body["rdp_port"], "rdp_port", 1, 65535)
            host = text(body.get("rdp_host", "127.0.0.1"), "rdp_host")
            if host not in ("127.0.0.1", "::1", "localhost"):
                raise RdpError("rdp_host must be loopback.")
            with self.lock:
                connection = next((c for c in self.connections.values() if c.host == host and c.port == port and not c.error and not c.closed), None)
                if connection is None:
                    if body.get("allow_foreground") is not True:
                        raise RdpError("A new RDP connection may show Firefox's confirmation dialog. Obtain permission and pass allow_foreground: true.", 403, "PROMPT_AUTHORIZATION_REQUIRED")
                    try:
                        stream = socket.create_connection((host, port), timeout=5)
                        stream.settimeout(None)
                    except OSError as error:
                        raise RdpError(str(error), 502, "RDP_CONNECT_FAILED") from None
                    connection = Connection(host, port, stream)
                    self.connections[connection.identity] = connection
        elif body.get("connection_id"):
            connection = self.get(body["connection_id"])
        else:
            if actor:
                raise RdpError("Actor discovery requires connection_id or rdp_port.")
            return {"status": "completed", "connections": self.inventory()}
        _ = connection.ready.wait(wait / 1000)
        if not connection.connected:
            return {"status": "failed" if connection.error or connection.closed else "connecting", **connection.describe(), "note": "Accept the authorized Firefox prompt, then inspect this same connection_id. No requests sent."}
        packets: list[Json] = [{"to": actor or "root", "type": "requestTypes"}]
        if actor is None:
            packets.extend([{"to": "root", "type": "getRoot"}, {"to": "root", "type": SCOPES[scope]}])
        result = connection.exchange({"packets": packets, **({"after": body["after"]} if body.get("after") is not None else {}), "wait_ms": max(0, wait - round((time.monotonic() - started) * 1000))})
        result["discovery_requests"] = packets
        return result

    def execute(self, body: JsonObject) -> JsonObject:
        if body.get("mode", "read_only") not in ("read_only", "authorized_mutation"):
            raise RdpError("Invalid mode.")
        connection = self.get(body.get("connection_id"))
        if body.get("action") == "disconnect":
            if body.get("packets") or body.get("bulk") is not None:
                raise RdpError("disconnect does not accept packets or bulk.")
            connection.close()
            with self.lock:
                _ = self.connections.pop(connection.identity, None)
            return {"status": "completed", "connection_id": connection.identity, "connected": False}
        if body.get("action", "exchange") != "exchange":
            raise RdpError("Use exchange or disconnect.")
        return connection.exchange(body)
