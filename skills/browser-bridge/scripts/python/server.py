"""HTTP client API, authenticated extension WebSockets and hidden service launcher."""

from __future__ import annotations

import argparse
import hmac
import json
import math
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# This file is a direct script entry point; its directory is Python's import root.
from browser_bridge import Json, JsonObject, http, read_json
from rdp import RdpError, RdpManager
from websocket_peer import WebSocketPeer

SERVICE = "browser-bridge-skill"


class Failure(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Json) -> None:
        super().__init__(message)
        self.status: int = status
        if details.get("terminal") is True:
            details["receipt_id"] = str(uuid.uuid4())
        self.body: JsonObject = {"code": code, "message": message, **details}


def string(body: JsonObject, name: str) -> str:
    value = body.get(name)
    if not isinstance(value, str):
        raise Failure(400, "INVALID_FIELD", f"{name} must be a string.")
    return value


def objects(body: JsonObject, name: str) -> list[JsonObject]:
    value = body.get(name)
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise Failure(400, "INVALID_FIELD", f"{name} must be an array of objects.")
    return [item for item in value if isinstance(item, dict)]


@dataclass
class Profile:
    identity: str
    instance: str
    inventory: JsonObject
    seen: float = field(default_factory=time.monotonic)
    peer: WebSocketPeer | None = None
    retired: set[str] = field(default_factory=set)
    active: dict[str, None] = field(default_factory=dict)


@dataclass
class Pending:
    profile: str
    job: JsonObject
    dispatched: bool = False
    ready: threading.Event = field(default_factory=threading.Event)
    result: JsonObject | None = None
    error: Failure | None = None
    phase: str = "queued"
    finished: bool = False
    delivered: bool = False
    outcome_unknown: bool = False
    waiting: bool = False
    wait_result: JsonObject | None = None
    receipt_id: str | None = None


class State:
    def __init__(self) -> None:
        self.secret: str = secrets.token_hex(32)
        self.condition: threading.Condition = threading.Condition()
        self.profiles: dict[str, Profile] = {}
        self.pending: dict[str, Pending] = {}
        self.stopping: bool = False
        self.rdp: RdpManager = RdpManager()
        self.instance: str = str(uuid.uuid4())

    def live(self, profile: Profile) -> bool:
        return profile.peer is not None and not profile.peer.closed and time.monotonic() - profile.seen < 45

    def extension_inventory(self) -> list[Json]:
        rows: list[Json] = []
        for profile in self.profiles.values():
            if self.live(profile):
                browser = profile.inventory.get("browser", "chromium")
                row: JsonObject = {"profile_id": profile.identity, "connection_id": "browser-extension:" + profile.instance,
                                   "browser": browser, "protocol": "webextension" if browser == "firefox" else "cdp", "connected": True, "extension_transport": "websocket", "extension_protocol": 2, "extension_version": profile.inventory.get("extension_version"),
                                   "capabilities": ["webextension"] if browser == "firefox" else ["javascript", "list_frames", "cdp", "tab_control", "window_control", "userscript", "debugging"]}
                for key in ("private_allowed", "debugging_enabled", "windows"):
                    row[key] = profile.inventory[key]
                rows.append(row)
        return rows

    def inventory(self) -> JsonObject:
        return {"status": "completed", "connections": self.extension_inventory() + self.rdp.inventory()}

    def find_tabs(self, body: JsonObject) -> JsonObject:
        """Search live tab metadata; return all candidates without changing selection."""
        match, query = body.get("match", {}), body.get("query", "")
        if not isinstance(match, dict) or any(isinstance(value, (dict, list)) for value in match.values()) or not isinstance(query, str):
            raise Failure(400, "INVALID_MATCH", "match must contain scalar metadata values; query must be a string.")
        needle = query.lower()
        matches: list[Json] = []
        for profile in self.profiles.values():
            if not self.live(profile):
                continue
            for tab in objects(profile.inventory, "tabs"):
                row: JsonObject = {**tab, "profile_id": profile.identity,
                                   "connection_id": "browser-extension:" + profile.instance,
                                   "browser": profile.inventory.get("browser", "chromium"),
                                   "context": "private" if tab.get("incognito") else "normal"}
                if all(key in row and row[key] == value and isinstance(row[key], bool) == isinstance(value, bool) for key, value in match.items()) and any(needle in str(value).lower() for value in row.values()):
                    matches.append(row)
        return {"status": "completed", "matches": matches}

    def snapshot(self, body: JsonObject) -> Profile:
        identity, instance = string(body, "profile_id"), string(body, "instance_id")
        _ = objects(body, "tabs")
        _ = objects(body, "windows")
        profile = self.profiles.get(identity)
        if profile is None or profile.instance != instance:
            retired: set[str] = set() if profile is None else profile.retired | {profile.instance}
            if instance in retired:
                raise Failure(409, "STALE_EXECUTION_CONTEXT", "A retired extension execution context cannot replace the current one.")
            if profile is not None:
                for job_id in profile.active:
                    entry = self.pending.get(job_id)
                    if entry is not None and not entry.finished and entry.error is None:
                        entry.error = Failure(409, "EXTENSION_RESTARTED", "The extension execution context restarted; inspect dispatched work before repeating it.", job_id=entry.job["job_id"], outcome_unknown=entry.dispatched, terminal=True)
                        entry.ready.set()
                if profile.peer is not None:
                    profile.peer.close()
            profile = Profile(identity, instance, body)
            profile.retired = retired
            self.profiles[identity] = profile
        profile.inventory = body
        profile.seen = time.monotonic()
        self.condition.notify_all()
        return profile

    def selection(self, query: dict[str, list[str]]) -> tuple[Profile, str]:
        identity = query.get("profile_id", [""])[0]
        context = query.get("context", [""])[0]
        if not identity or context not in ("normal", "private"):
            raise Failure(400, "SELECTION_REQUIRED", "Explicit profile_id and normal/private context are required.")
        profile = self.profiles.get(identity)
        if profile is None or not self.live(profile):
            raise Failure(404, "PROFILE_NOT_CONNECTED", "The selected profile is not connected. Enumerate profiles again.")
        return profile, context

    def deliver(self, profile: Profile, accepted: set[str] | None = None) -> None:
        """Queue deliveries under condition; never repeat an accepted operation."""
        if profile.peer is None or profile.peer.closed:
            return
        for job_id in tuple(profile.active):
            entry = self.pending.get(job_id)
            if entry is None or entry.finished or entry.error is not None:
                continue
            deadline = entry.job.get("deadline_at")
            if not isinstance(deadline, (float, int)) or deadline <= time.time() * 1000:
                if accepted is not None and job_id not in accepted:
                    entry.phase = "expired_before_acceptance"
                    entry.error = Failure(504, "DEADLINE_EXCEEDED", "The same extension execution context confirmed this expired job was never accepted.", job_id=job_id, phase=entry.phase, outcome_unknown=False, terminal=True)
                    _ = profile.active.pop(job_id, None)
                    entry.ready.set()
                continue
            if entry.dispatched and (accepted is None or string(entry.job, "job_id") in accepted):
                continue
            entry.dispatched = True
            entry.phase = "dispatched"
            profile.peer.send({"type": "job", "job": entry.job})
            print(json.dumps({"event": "dispatched", "job_id": entry.job["job_id"], "profile_id": profile.identity}), flush=True)


def serve(port: int) -> None:
    state = State()

    class Handler(BaseHTTPRequestHandler):
        def socket_session(self) -> None:
            peer = WebSocketPeer(self)
            profile: Profile | None = None
            try:
                for message in peer.messages():
                    with state.condition:
                        if profile is None:
                            accepted = message.get("accepted_job_ids")
                            if message.get("type") != "hello" or message.get("protocol") != 2 or not hmac.compare_digest(string(message, "secret"), state.secret) or not isinstance(accepted, list) or any(not isinstance(item, str) for item in accepted):
                                raise Failure(401, "HANDSHAKE_REQUIRED", "Bootstrap and authenticate protocol 2.")
                            value = message.get("snapshot")
                            if not isinstance(value, dict):
                                raise Failure(400, "INVALID_SNAPSHOT", "Provide an extension inventory.")
                            profile = state.snapshot(value)
                            previous = profile.peer
                            profile.peer = peer
                            if previous is not None and previous is not peer:
                                previous.close()
                            peer.authenticated()
                            peer.send({"type": "welcome", "protocol": 2, "service_instance_id": state.instance})
                            state.deliver(profile, {item for item in accepted if isinstance(item, str)})
                            print(json.dumps({"event": "extension_connected", "profile_id": profile.identity, "instance_id": profile.instance}), flush=True)
                        else:
                            if profile.peer is not peer:
                                return
                            kind = message.get("type")
                            if kind == "inventory":
                                value = message.get("snapshot")
                                if not isinstance(value, dict) or value.get("profile_id") != profile.identity or value.get("instance_id") != profile.instance:
                                    raise Failure(409, "INSTANCE_MISMATCH", "Reconnect with a new handshake.")
                                _ = state.snapshot(value)
                            elif kind == "result":
                                job, result = message.get("job"), message.get("result")
                                if not isinstance(job, dict) or not isinstance(result, dict) or job.get("profile_id") != profile.identity or job.get("job_id") != result.get("job_id") or job.get("tab_id") != result.get("tab_id"):
                                    raise Failure(400, "INVALID_RESULT", "Result selection does not match its job.")
                                job_id = string(job, "job_id")
                                entry = state.pending.get(job_id)
                                if entry is None:
                                    entry = Pending(profile.identity, job, dispatched=True)
                                    state.pending[job_id] = entry
                                if entry.profile != profile.identity or entry.job.get("tab_id") != result.get("tab_id"):
                                    raise Failure(409, "JOB_MISMATCH", "Result belongs to another selection.")
                                if not entry.finished:
                                    entry.receipt_id = str(uuid.uuid4())
                                    entry.result, entry.error, entry.phase = {**result, "receipt_id": entry.receipt_id}, None, "completed"
                                    entry.delivered = False
                                    if entry.waiting:
                                        entry.wait_result = entry.result
                                    entry.finished = True
                                    entry.outcome_unknown = result.get("outcome_unknown") is True
                                    _ = profile.active.pop(job_id, None)
                                    entry.ready.set()
                                peer.send({"type": "result_ack", "job_id": job_id})
                                print(json.dumps({"event": "completed", "job_id": job_id, "profile_id": profile.identity}), flush=True)
                            elif kind == "progress":
                                job_id, phase = string(message, "job_id"), string(message, "phase")
                                entry = state.pending.get(job_id)
                                if entry is not None and entry.profile == profile.identity and not entry.finished and entry.error is None:
                                    entry.phase = phase
                                    print(json.dumps({"event": "job_progress", "job_id": job_id, "profile_id": profile.identity, "phase": phase}), flush=True)
                            elif kind == "ping":
                                peer.send({"type": "pong", "at": time.time() * 1000})
                            else:
                                raise Failure(400, "INVALID_MESSAGE", "Unknown extension message type.")
                        profile.seen = time.monotonic()
            except Failure as error:
                peer.send({"type": "error", **error.body})
                peer.close(graceful=True)
            except (OSError, ValueError):
                pass
            finally:
                peer.close()
                with state.condition:
                    if profile is not None and profile.peer is peer:
                        profile.peer = None
                        print(json.dumps({"event": "extension_disconnected", "profile_id": profile.identity, "instance_id": profile.instance}), flush=True)

        def log_message(self, format: str, *args: Json) -> None:  # pyright: ignore[reportImplicitOverride]
            # Do not log request bodies, profile labels, page URLs or transport secrets.
            return

        def send(self, status: int, body: JsonObject) -> None:
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            _ = self.wfile.write(encoded)

        def do_GET(self) -> None:
            self.route()

        def do_POST(self) -> None:
            self.route()

        def route(self) -> None:
            try:
                self.handle_route()
            except (Failure, RdpError) as error:
                self.send(error.status, error.body)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as error:
                print(json.dumps({"event": "request_failed", "type": type(error).__name__}), flush=True)
                self.send(500, {"code": "INTERNAL_ERROR", "message": "Service error; inspect server.log."})

        def handle_route(self) -> None:
            if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                raise Failure(403, "HOST_FORBIDDEN", "Use the configured loopback address.")
            parsed = urlsplit(self.path)
            path, query = parsed.path, parse_qs(parsed.query)
            origin = self.headers.get("Origin")
            if path.startswith("/extension/"):
                if origin and not re.fullmatch(r"(?:chrome-extension://[a-p]+|moz-extension://[a-f0-9-]+)", origin, re.IGNORECASE):
                    raise Failure(403, "ORIGIN_FORBIDDEN", "Only extension origins may use this route.")
                supplied = self.headers.get("X-Browser-Bridge-Secret", "")
                if path not in ("/extension/bootstrap", "/extension/ws") and not hmac.compare_digest(supplied, state.secret):
                    raise Failure(401, "INVALID_SECRET", "Reconnect the extension.")
            elif origin or path != "/probe" and self.headers.get("X-Browser-Bridge-Client") != "1":
                raise Failure(403, "CLIENT_HEADER_REQUIRED", "Use the CLI or client module.")
            if self.command == "GET":
                if path == "/extension/ws":
                    if self.headers.get("Upgrade", "").lower() != "websocket":
                        raise Failure(400, "UPGRADE_REQUIRED", "Use a WebSocket connection.")
                    self.socket_session()
                    return
                if path == "/probe":
                    self.send(200, {"service": SERVICE, "version": 1, "pid": os.getpid(), "extension_transport": "websocket", "extension_protocol": 2, "service_instance_id": state.instance})
                    return
                if path == "/extension/bootstrap":
                    self.send(200, {"secret": state.secret, "protocol": 2})
                    return
                with state.condition:
                    if path == "/profiles":
                        output: JsonObject = {"profiles": state.extension_inventory()}
                    elif path == "/discover":
                        output = state.inventory()
                    elif path == "/tabs":
                        profile, context = state.selection(query)
                        window_id = None
                        if "window_id" in query:
                            try:
                                window_id = int(query["window_id"][0])
                            except ValueError:
                                raise Failure(400, "INVALID_WINDOW", "window_id must be an integer.") from None
                        tabs: list[Json] = [tab for tab in objects(profile.inventory, "tabs") if tab.get("incognito") is (context == "private") and (window_id is None or tab.get("window_id") == window_id)]
                        output = {"profile_id": profile.identity, "context": context, "tabs": tabs}
                    else:
                        raise Failure(404, "NOT_FOUND", "Unknown service route.")
                self.send(200, output)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0:
                    raise ValueError("negative content length")
                body = read_json(self.rfile.read(length).decode("utf-8")) if length else {}
            except (ValueError, UnicodeDecodeError):
                raise Failure(400, "INVALID_JSON", "Provide a UTF-8 JSON object.") from None
            if path in ("/job", "/job-ack"):
                with state.condition:
                    entry = state.pending.get(string(body, "job_id"))
                    if entry is None:
                        raise Failure(404, "JOB_NOT_FOUND", "This service has no record of the job. Do not infer that it did not execute.")
                    job = entry.job
                    if any(body.get(key) != job.get(key) or isinstance(body.get(key), bool) != isinstance(job.get(key), bool) for key in ("profile_id", "context", "tab_id", "window_id")):
                        raise Failure(409, "JOB_SELECTION_MISMATCH", "Repeat the exact original profile, privacy, tab and window selection.")
                    if path == "/job-ack":
                        if not entry.finished and entry.error is None:
                            raise Failure(409, "JOB_NOT_COMPLETE", "Only a final result or terminal service error can be acknowledged.")
                        receipt = entry.receipt_id if entry.finished else entry.error.body.get("receipt_id") if entry.error is not None else None
                        if body.get("receipt_id") != receipt:
                            raise Failure(409, "JOB_RECEIPT_MISMATCH", "Acknowledge only the receipt_id you actually received. Query the current result before another acknowledgement.")
                        entry.result, entry.delivered = None, True
                        entry.job = {key: job[key] for key in ("job_id", "profile_id", "context", "tab_id", "window_id", "kind", "deadline_at") if key in job}
                        output = {"job_id": job["job_id"], "acknowledged": True}
                    else:
                        unknown = entry.outcome_unknown if entry.finished else entry.error.body.get("outcome_unknown", entry.dispatched) if entry.error is not None else entry.dispatched
                        output = {"job_id": job["job_id"], "phase": entry.phase, "status": ("outcome_unknown" if unknown else "completed") if entry.finished else "failed" if entry.error is not None else "dispatched" if entry.dispatched else "queued", "outcome_unknown": unknown, "result_delivered": entry.delivered}
                        output["terminal"] = entry.finished or entry.error is not None
                        if entry.finished or entry.error is not None:
                            output["receipt_id"] = entry.receipt_id if entry.finished else entry.error.body.get("receipt_id") if entry.error is not None else None
                        if entry.result is not None:
                            output["result"] = entry.result
                        if entry.error is not None:
                            output["error"] = entry.error.body
                self.send(200, output)
                return
            if path == "/find-tabs":
                with state.condition:
                    output = state.find_tabs(body)
                self.send(200, output)
                return
            if path == "/rdp":
                self.send(200, state.rdp.execute(body))
                return
            if path == "/discover":
                connection_id = body.get("connection_id")
                if isinstance(connection_id, str) and connection_id.startswith("browser-extension:"):
                    path = "/request"
                    query = {"profile_id": [string(body, "profile_id")], "context": [string(body, "context")]}
                    body = {**body, "operation": "webextension", "action": "describe", "path": body.get("namespace", "")}
                elif connection_id or "rdp_port" in body or body.get("actor"):
                    self.send(200, state.rdp.discover(body))
                    return
                else:
                    with state.condition:
                        output = state.inventory()
                    self.send(200, output)
                    return
            if path == "/shutdown":
                self.send(200, {"stopping": True})
                with state.condition:
                    state.stopping = True
                    for profile in state.profiles.values():
                        if profile.peer is not None:
                            profile.peer.close()
                    for entry in state.pending.values():
                        if not entry.finished and entry.error is None:
                            entry.error = Failure(409, "SERVER_STOPPING", "Service stopping; inspect dispatched work before repeating it.", job_id=entry.job["job_id"], outcome_unknown=entry.dispatched)
                            entry.ready.set()
                    state.condition.notify_all()
                state.rdp.close()
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            if path in ("/extension/poll", "/extension/snapshot"):
                raise Failure(409, "EXTENSION_UPGRADE_REQUIRED", "This service requires extension WebSocket protocol 2. Load the matching extension version once.")
            if path != "/request":
                raise Failure(404, "NOT_FOUND", "Unknown service route.")
            with state.condition:
                profile, context = state.selection(query)
                operation = string(body, "operation")
                native = operation == "webextension"
                browser = profile.inventory.get("browser", "chromium")
                if native and (browser != "firefox" or body.get("connection_id") != "browser-extension:" + profile.instance):
                    raise Failure(409, "CONNECTION_MISMATCH", "Use the selected live Firefox extension connection_id from discover.")
                if not native and browser == "firefox":
                    raise Failure(400, "UNSUPPORTED_OPERATION", "Use Firefox webextension or its separate RDP connection; Chromium operations do not apply.")
                tab_id = body.get("tab_id")
                tab = next((tab for tab in objects(profile.inventory, "tabs") if tab.get("tab_id") == tab_id), None)
                if (not native and operation not in ("window_control", "debugging") or operation == "debugging" and body.get("action") == "enable" or "tab_id" in body) and tab is None:
                    raise Failure(404, "TAB_NOT_FOUND", "The tab is not visible in this profile. Enumerate tabs again.")
                if tab is not None and tab.get("incognito") is not (context == "private"):
                    raise Failure(409, "CONTEXT_MISMATCH", "The tab belongs to the other window privacy context.")
                if "window_id" in body:
                    window_id = body["window_id"]
                    if not isinstance(window_id, int) or isinstance(window_id, bool):
                        raise Failure(400, "INVALID_WINDOW", "window_id must be an integer.")
                    if not any(window.get("window_id") == window_id and window.get("incognito") is (context == "private") for window in objects(profile.inventory, "windows")) or tab is not None and tab.get("window_id") != window_id:
                        raise Failure(409, "WINDOW_MISMATCH", "The target does not belong to the requested window and privacy context.")
                if operation not in ("javascript", "list_frames", "cdp", "tab_control", "window_control", "userscript", "webextension", "debugging"):
                    raise Failure(400, "UNKNOWN_OPERATION", "Use a documented browser operation.")
                if operation == "debugging":
                    if body.get("action") not in ("status", "enable"):
                        raise Failure(400, "INVALID_ACTION", "Use debugging action status or enable.")
                    if body.get("action") == "enable" and context == "private" and profile.inventory.get("private_allowed") is not True:
                        raise Failure(403, "PRIVATE_ACCESS_REQUIRED", "Enable Allow in Incognito / Allow in InPrivate for the selected extension.")
                if operation == "window_control":
                    if body.get("action") not in ("create", "close"):
                        raise Failure(400, "INVALID_ACTION", "Use window action create or close.")
                    if body.get("action") == "close" and "window_id" not in body:
                        raise Failure(400, "INVALID_WINDOW", "Closing a window requires an exact window_id.")
                    if context == "private" and profile.inventory.get("private_allowed") is not True:
                        raise Failure(403, "PRIVATE_ACCESS_REQUIRED", "Enable Allow in Incognito / Allow in InPrivate for the selected extension.")
                if native:
                    action = body.get("action", "call")
                    if action not in ("call", "describe", "watch", "unwatch", "events", "release"):
                        raise Failure(400, "INVALID_ACTION", "Unknown WebExtension action.")
                    if "path" in body:
                        _ = string(body, "path")
                    if action in ("call", "watch", "release") and not string(body, "path"):
                        raise Failure(400, "INVALID_PATH", "This action requires path.")
                    if "args" in body and not isinstance(body["args"], list):
                        raise Failure(400, "INVALID_ARGS", "args must be positional arguments in an array.")
                    if action == "unwatch":
                        _ = string(body, "subscription_id")
                    after, wait = body.get("after", 0), body.get("wait_ms", 0)
                    if not isinstance(after, int) or isinstance(after, bool) or after < 0:
                        raise Failure(400, "INVALID_CURSOR", "after must be a nonnegative integer.")
                    if not isinstance(wait, int) or isinstance(wait, bool) or not 0 <= wait <= 15000:
                        raise Failure(400, "INVALID_WAIT", "wait_ms must be 0..15000.")
                    body["action"] = action
                if operation not in ("tab_control", "window_control", "debugging") and profile.inventory.get("debugging_enabled") is not True:
                    raise Failure(409, "DEBUGGING_DISABLED", "Use debugging action enable with authorized_mutation for the resolved target, or enable debugging in extension controls.")
                if operation == "javascript":
                    scripts = body.get("scripts")
                    if not isinstance(scripts, list) or not scripts or any(not isinstance(script, str) for script in scripts):
                        raise Failure(400, "INVALID_SCRIPTS", "scripts must be a nonempty array of strings.")
                if operation == "cdp":
                    commands = objects(body, "commands")
                    if not commands or any(not isinstance(command.get("method"), str) or not command["method"] for command in commands):
                        raise Failure(400, "INVALID_COMMANDS", "commands must contain CDP method/params objects.")
                mode = body.get("mode", "read_only")
                if mode not in ("read_only", "authorized_mutation"):
                    raise Failure(400, "INVALID_MODE", "Use read_only or authorized_mutation.")
                if "allow_foreground" in body and not isinstance(body["allow_foreground"], bool):
                    raise Failure(400, "INVALID_FOREGROUND_FLAG", "allow_foreground must be a boolean.")
                if (operation in ("tab_control", "window_control") or operation == "debugging" and body.get("action") == "enable" or operation == "userscript" and body.get("userscript_action") not in ("list", "list_commands")) and mode != "authorized_mutation":
                    raise Failure(403, "MUTATION_NOT_AUTHORIZED", "This operation requires authorized_mutation.")
                timeout = body.get("timeout_ms", 30000)
                if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
                    raise Failure(400, "INVALID_TIMEOUT", "timeout_ms must be positive.")
                job_id = body.get("job_id", str(uuid.uuid4()))
                if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", job_id):
                    raise Failure(400, "INVALID_JOB_ID", "job_id must be a UUID.")
                if job_id in state.pending:
                    raise Failure(409, "JOB_ALREADY_EXISTS", "Inspect this job with /job; it will not be executed again.", job_id=job_id)
                job: JsonObject = {**body, "kind": operation, "mode": mode, "job_id": job_id, "profile_id": profile.identity, "context": context, "deadline_at": time.time() * 1000 + timeout}
                if operation == "tab_control":
                    job["tab_control"] = {**body, "target_tab_id": tab_id, "context": context}
                entry = Pending(profile.identity, job, waiting=True)
                state.pending[job_id] = entry
                profile.active[job_id] = None
                state.deliver(profile)
            print(json.dumps({"event": "submitted", "job_id": job_id, "profile_id": profile.identity, "operation": operation}), flush=True)
            _ = entry.ready.wait((timeout + 1000) / 1000)
            with state.condition:
                completed_result = entry.wait_result
                entry.waiting, entry.wait_result = False, None
                if completed_result is None and entry.error is None:
                    error = Failure(504, "DEADLINE_EXCEEDED", "The wait expired. Query this job before repeating any dispatched work.", job_id=job_id, phase=entry.phase, outcome_unknown=entry.dispatched, terminal=not entry.dispatched)
                    if not entry.dispatched:
                        entry.error = error
                        _ = profile.active.pop(job_id, None)
                    raise error
                if entry.error is not None:
                    raise entry.error
            if completed_result is None:
                raise RuntimeError("Completed job has no result")
            self.send(200, completed_result)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(json.dumps({"event": "listening", "port": port, "pid": os.getpid()}), flush=True)
    try:
        server.serve_forever()
    finally:
        state.rdp.close()
        server.server_close()


class Arguments(argparse.Namespace):
    def __init__(self) -> None:
        super().__init__()
        self.session: str = ""
        self.port: int = 30003
        self.serve: bool = False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument("--session", required=True)
    _ = parser.add_argument("--port", type=int, default=30003)
    _ = parser.add_argument("--serve", action="store_true")
    args = parser.parse_args(namespace=Arguments())
    if not args.session or args.session in (".", "..") or re.search(r"[\\/:\x00]", args.session):
        parser.error("Use one session-directory name.")
    if not 1 <= args.port <= 65535:
        parser.error("Port must be 1..65535.")
    if args.serve:
        serve(args.port)
        return
    directory = Path(tempfile.gettempdir()) / args.session / "browser bridge"
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / "server.log"
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    with log.open("ab") as output:
        process = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--serve", "--session", args.session, "--port", str(args.port)], stdin=subprocess.DEVNULL, stdout=output, stderr=output, creationflags=flags, start_new_session=os.name != "nt")
    deadline = time.monotonic() + 5
    while process.poll() is None and time.monotonic() < deadline:
        try:
            status = http("/probe", url=f"http://127.0.0.1:{args.port}", timeout=0.2)
            if status.get("service") == SERVICE and status.get("pid") == process.pid:
                print(json.dumps({"started": True, "pid": process.pid, "url": f"http://127.0.0.1:{args.port}", "log": str(log)}))
                return
        except OSError:
            pass
        time.sleep(0.1)
    print(json.dumps({"error": "Server did not acknowledge startup. Check the log and port before starting another process.", "pid": process.pid, "log": str(log)}))
    raise SystemExit(1)


if __name__ == "__main__":
    main()
