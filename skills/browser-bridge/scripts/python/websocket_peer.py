"""WebSocket framing for an HTTP-upgraded socket, using wsproto's RFC 6455 implementation.

The HTTP handler owns origin/authentication and application messages. Each peer
has one receiver and one queued writer; neither holds application state locks
while waiting for socket I/O. close() interrupts only this peer's socket.
"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from queue import Queue
from typing import cast

from wsproto.connection import Connection, ConnectionState, ConnectionType
from wsproto.events import AcceptConnection, CloseConnection, Ping, TextMessage
from wsproto.handshake import H11Handshake
from wsproto.utilities import ProtocolError

from browser_bridge import JsonObject, read_json


class WebSocketPeer:
    def __init__(self, handler: BaseHTTPRequestHandler) -> None:
        self.socket: socket.socket = cast(socket.socket, handler.connection)
        self.handler: BaseHTTPRequestHandler = handler
        handshake = H11Handshake(ConnectionType.SERVER)
        headers = [(key.encode("ascii"), value.encode("latin1")) for key, value in handler.headers.items()]
        handshake.initiate_upgrade_connection(headers, handler.path)
        _ = list(handshake.events())
        response = handshake.send(AcceptConnection())
        connection = handshake.connection
        if connection is None:
            raise ValueError("WebSocket upgrade failed")
        self.protocol: Connection = connection
        self.lock: threading.Lock = threading.Lock()
        self.outgoing: Queue[bytes | None] = Queue()
        self.closed: bool = False
        handler.close_connection = True
        self.socket.settimeout(5)
        _ = handler.wfile.write(response)
        handler.wfile.flush()
        threading.Thread(target=self._write, daemon=True).start()

    def _write(self) -> None:
        try:
            while True:
                data = self.outgoing.get()
                if data is None:
                    return
                self.socket.sendall(data)
        except OSError:
            self.close()
        finally:
            self._shutdown()

    def send(self, message: JsonObject) -> None:
        with self.lock:
            if self.closed or self.protocol.state is not ConnectionState.OPEN:
                return
            self.outgoing.put(self.protocol.send(TextMessage(data=json.dumps(message, ensure_ascii=False))))

    def messages(self) -> Iterator[JsonObject]:
        fragments: list[str] = []
        while not self.closed:
            data = self.handler.rfile.read1(65536)
            if not data:
                return
            with self.lock:
                try:
                    self.protocol.receive_data(data)
                    events = list(self.protocol.events())
                except ProtocolError as error:
                    raise ValueError("Invalid WebSocket frame") from error
            for event in events:
                if isinstance(event, TextMessage):
                    fragments.append(event.data)
                    if event.message_finished:
                        text = "".join(fragments)
                        fragments.clear()
                        yield read_json(text)
                elif isinstance(event, Ping):
                    with self.lock:
                        self.outgoing.put(self.protocol.send(event.response()))
                elif isinstance(event, CloseConnection):
                    with self.lock:
                        if self.protocol.state is ConnectionState.REMOTE_CLOSING:
                            self.outgoing.put(self.protocol.send(event.response()))
                    self.close(graceful=True)
                    return
                else:
                    raise ValueError("Use JSON text WebSocket messages")

    def authenticated(self) -> None:
        self.socket.settimeout(45)

    def close(self, *, graceful: bool = False) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.outgoing.put(None)
        if not graceful:
            self._shutdown()

    def _shutdown(self) -> None:
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
