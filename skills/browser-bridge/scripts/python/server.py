"""Dependency-free fallback server and hidden launcher for the Browser Bridge protocol."""

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

SERVICE = "browser-bridge-skill"


class Failure(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Json) -> None:
        super().__init__(message)
        self.status: int = status
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
    queue: list[str] = field(default_factory=list)


@dataclass
class Pending:
    profile: str
    job: JsonObject
    dispatched: bool = False
    ready: threading.Event = field(default_factory=threading.Event)
    result: JsonObject | None = None
    error: Failure | None = None


class State:
    def __init__(self) -> None:
        self.secret: str = secrets.token_hex(32)
        self.condition: threading.Condition = threading.Condition()
        self.profiles: dict[str, Profile] = {}
        self.pending: dict[str, Pending] = {}
        self.stopping: bool = False
        self.rdp: RdpManager = RdpManager()

    def extension_inventory(self) -> list[Json]:
        rows: list[Json] = []
        for profile in self.profiles.values():
            if time.monotonic() - profile.seen < 45:
                browser = profile.inventory.get("browser", "chromium")
                row: JsonObject = {"profile_id": profile.identity, "connection_id": "browser-extension:" + profile.instance,
                                   "browser": browser, "protocol": "webextension" if browser == "firefox" else "cdp", "connected": True,
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
            if time.monotonic() - profile.seen >= 45:
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
            if profile is not None:
                for entry in self.pending.values():
                    if entry.profile == identity:
                        entry.error = Failure(409, "EXTENSION_RESTARTED", "The extension restarted; inspect the target before repeating a mutation.", outcome_unknown=entry.dispatched)
                        entry.ready.set()
            profile = Profile(identity, instance, body)
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
        if profile is None or time.monotonic() - profile.seen >= 45:
            raise Failure(404, "PROFILE_NOT_CONNECTED", "The selected profile is not connected. Enumerate profiles again.")
        return profile, context


def serve(port: int) -> None:
    state = State()

    class Handler(BaseHTTPRequestHandler):
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
                if path != "/extension/bootstrap" and not hmac.compare_digest(supplied, state.secret):
                    raise Failure(401, "INVALID_SECRET", "Reconnect the extension.")
            elif origin or path != "/probe" and self.headers.get("X-Browser-Bridge-Client") != "1":
                raise Failure(403, "CLIENT_HEADER_REQUIRED", "Use the CLI or client module.")
            if self.command == "GET":
                if path == "/probe":
                    self.send(200, {"service": SERVICE, "version": 1, "pid": os.getpid()})
                    return
                if path == "/extension/bootstrap":
                    self.send(200, {"secret": state.secret})
                    return
                with state.condition:
                    if path == "/profiles":
                        self.send(200, {"profiles": state.extension_inventory()})
                        return
                    if path == "/discover":
                        self.send(200, state.inventory())
                        return
                    if path == "/tabs":
                        profile, context = state.selection(query)
                        window_id = None
                        if "window_id" in query:
                            try:
                                window_id = int(query["window_id"][0])
                            except ValueError:
                                raise Failure(400, "INVALID_WINDOW", "window_id must be an integer.") from None
                        tabs: list[Json] = [tab for tab in objects(profile.inventory, "tabs") if tab.get("incognito") is (context == "private") and (window_id is None or tab.get("window_id") == window_id)]
                        self.send(200, {"profile_id": profile.identity, "context": context, "tabs": tabs})
                        return
                raise Failure(404, "NOT_FOUND", "Unknown service route.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0:
                    raise ValueError("negative content length")
                body = read_json(self.rfile.read(length).decode("utf-8")) if length else {}
            except (ValueError, UnicodeDecodeError):
                raise Failure(400, "INVALID_JSON", "Provide a UTF-8 JSON object.") from None
            if path == "/find-tabs":
                with state.condition:
                    self.send(200, state.find_tabs(body))
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
                        self.send(200, state.inventory())
                    return
            if path == "/shutdown":
                self.send(200, {"stopping": True})
                with state.condition:
                    state.stopping = True
                    for entry in state.pending.values():
                        entry.error = Failure(409, "SERVER_STOPPING", "Service stopping; inspect dispatched work before repeating it.", outcome_unknown=entry.dispatched)
                        entry.ready.set()
                    state.condition.notify_all()
                state.rdp.close()
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            if path in ("/extension/poll", "/extension/snapshot"):
                with state.condition:
                    profile = state.snapshot(body)
                    acknowledged: list[Json] = []
                    for result in objects({"results": body.get("results", [])}, "results"):
                        job_id = string(result, "job_id")
                        entry = state.pending.get(job_id)
                        if entry and entry.profile == profile.identity and entry.dispatched and entry.job.get("tab_id") == result.get("tab_id"):
                            entry.result = result
                            entry.ready.set()
                        acknowledged.append(job_id)
                    if path == "/extension/snapshot" or acknowledged:
                        self.send(200, {"acknowledged": acknowledged, "jobs": []})
                        return
                    _ = state.condition.wait_for(lambda: bool(profile.queue) or state.stopping or state.profiles.get(profile.identity) is not profile, timeout=12)
                    jobs: list[Json] = []
                    for job_id in profile.queue:
                        entry = state.pending.get(job_id)
                        if entry:
                            entry.dispatched = True
                            jobs.append(entry.job)
                    profile.queue.clear()
                    self.send(200, {"acknowledged": acknowledged, "jobs": jobs})
                return
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
                job_id = str(uuid.uuid4())
                job: JsonObject = {**body, "kind": operation, "mode": mode, "job_id": job_id, "profile_id": profile.identity, "context": context, "deadline_at": time.time() * 1000 + timeout}
                if operation == "tab_control":
                    job["tab_control"] = {**body, "target_tab_id": tab_id, "context": context}
                entry = Pending(profile.identity, job)
                state.pending[job_id] = entry
                profile.queue.append(job_id)
                state.condition.notify_all()
            print(json.dumps({"event": "submitted", "job_id": job_id, "profile_id": profile.identity, "operation": operation}), flush=True)
            try:
                if not entry.ready.wait(timeout / 1000):
                    raise Failure(504, "DEADLINE_EXCEEDED", "The deadline expired. Inspect the target before repeating dispatched work.", job_id=job_id, outcome_unknown=entry.dispatched)
                if entry.error is not None:
                    raise entry.error
                if entry.result is None:
                    raise RuntimeError("Completed job has no result")
                self.send(200, entry.result)
            finally:
                with state.condition:
                    _ = state.pending.pop(job_id, None)
            print(json.dumps({"event": "completed", "job_id": job_id}), flush=True)

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
