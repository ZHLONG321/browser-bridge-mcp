"""Python Windows CLI and isolated worker; stdout is JSON or a verified filename."""
from __future__ import annotations

import json
import subprocess
import sys
from io import TextIOWrapper
from pathlib import Path
from typing import cast

import browser_bridge_windows as desktop
from browser_bridge_windows._native import Json, Record
from browser_bridge_windows._platform import integer, require_windows


def object_from_json(value: str) -> Record:
    decoded = cast(Json, json.loads(value))
    if not isinstance(decoded, dict):
        raise ValueError("Request must contain an options object.")
    return decoded


def error_value(error: Exception) -> Record:
    detail: Record = {"code": error.code if isinstance(error, desktop.WindowsError) else "WINDOWS_OPERATION_FAILED", "message": str(error)}
    if isinstance(error, desktop.WindowsError) and error.details:
        detail["details"] = {key: value for key, value in error.details.items()}
    return {"error": detail}


def worker() -> int:
    try:
        request = object_from_json(sys.stdin.read())
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            raise ValueError("Worker arguments must be an object.")
        result = desktop.call(str(request["operation"]), **arguments)
        print(json.dumps({"value": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps(error_value(error), ensure_ascii=False))
        return 1


def options(argv: list[str]) -> Record:
    result: Record = {}
    seen: set[str] = set()
    if len(argv) % 2:
        raise ValueError("Each --field requires a value.")
    for index in range(0, len(argv), 2):
        flag = argv[index]
        if not flag.startswith("--"):
            raise ValueError("Each field must start with --.")
        name, raw = flag[2:].replace("-", "_"), argv[index + 1]
        if name in seen:
            raise ValueError("Duplicate command parameter.")
        seen.add(name)
        if name == "json":
            fields = object_from_json(Path(raw).read_text(encoding="utf-8"))
        else:
            try:
                value = cast(Json, json.loads(raw))
            except json.JSONDecodeError:
                value = raw
            fields = {name: value}
        if result.keys() & fields.keys():
            raise ValueError("Duplicate command parameter.")
        result.update(fields)
    return result


def main(argv: list[str]) -> int:
    if argv[:1] == ["windows-python"]:
        argv = argv[1:]
    if not argv or argv[0] in ("help", "--help"):
        print("Usage: browser-bridge.bat windows-python OPERATION [--field VALUE] [--json REQUEST.json]\n" + "\n".join(desktop.OPERATIONS))
        return 0
    operation = argv[0].replace("-", "_")
    if operation not in desktop.OPERATIONS:
        raise ValueError("Unknown Windows operation.")
    require_windows()
    arguments = options(argv[1:])
    timeout = arguments.pop("timeout_ms", 30000)
    if not isinstance(timeout, int):
        raise ValueError("timeout_ms must be an integer.")
    integer(timeout, "timeout_ms", 1, 2147483647)
    try:
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker"],
                               input=json.dumps({"operation": operation, "arguments": arguments}),
                               encoding="utf-8", capture_output=True, timeout=timeout / 1000,
                               creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    except subprocess.TimeoutExpired:
        raise desktop.WindowsError("Windows operation timed out. Inspect actual state before repeating a mutation.",
                                   code="WINDOWS_TIMEOUT", details={"operation": operation, "outcome_unknown": operation == "raw_call"}) from None
    sys.stderr.write(child.stderr)
    if not child.stdout.strip():
        raise desktop.WindowsError("Windows worker exited before returning. Inspect actual state before repeating a mutation.",
                                   code="WINDOWS_WORKER_EXIT", details={"operation": operation, "outcome_unknown": operation == "raw_call"})
    response = object_from_json(child.stdout)
    if child.returncode or "error" in response:
        print(json.dumps(response, ensure_ascii=False), file=sys.stderr)
        return 1
    value = response["value"]
    print(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        cast(TextIOWrapper, stream).reconfigure(encoding="utf-8")
    if sys.argv[1:] == ["--worker"]:
        raise SystemExit(worker())
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:
        print(json.dumps(error_value(error), ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from None
