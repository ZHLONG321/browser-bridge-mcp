"""Standard-library client; every browser call selects a profile and privacy context."""

from __future__ import annotations

import json
import os
from http.client import HTTPResponse
from typing import TypeAlias, cast
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

Json: TypeAlias = "None | bool | int | float | str | list[Json] | dict[str, Json]"
JsonObject: TypeAlias = dict[str, Json]


def json_object(value: Json) -> JsonObject:
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object.")
    return value


def read_json(text: str) -> JsonObject:
    return json_object(cast(Json, json.loads(text)))


class BridgeError(RuntimeError):
    def __init__(self, status: int, details: JsonObject) -> None:
        super().__init__(str(details.get("message", f"HTTP {status}")))
        self.status: int = status
        self.details: JsonObject = details


def http(path: str, *, url: str | None = None, payload: JsonObject | None = None,
         timeout: float = 35) -> JsonObject:
    address = url or os.environ.get("BROWSER_BRIDGE_URL", "http://127.0.0.1:30003")
    parsed = urlsplit(address)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("Use a loopback HTTP service URL with no path or credentials.")
    request = Request(address.rstrip("/") + path,
                      data=None if payload is None else json.dumps(payload).encode("utf-8"),
                      headers={"X-Browser-Bridge-Client": "1", "Content-Type": "application/json"})
    try:
        with cast(HTTPResponse, build_opener(ProxyHandler({})).open(request, timeout=timeout)) as response:
            return read_json(response.read().decode("utf-8"))
    except HTTPError as error:
        raise BridgeError(error.code, read_json(error.read().decode("utf-8"))) from None


def profiles(*, service_url: str | None = None) -> JsonObject:
    return http("/profiles", url=service_url)


def discover(*, service_url: str | None = None, **fields: Json) -> JsonObject:
    """List connections, describe a selected extension, or explicitly connect to RDP."""
    return http("/discover", url=service_url, payload=fields, timeout=_native_timeout(fields))


def rdp(*, service_url: str | None = None, **fields: Json) -> JsonObject:
    """Send native packets once or poll a retained stream by its exclusive cursor."""
    return http("/rdp", url=service_url, payload=fields, timeout=_native_timeout(fields))


def _native_timeout(fields: JsonObject) -> float:
    wait = fields.get("wait_ms", 500)
    if not isinstance(wait, (int, float)) or isinstance(wait, bool) or wait < 0:
        raise ValueError("wait_ms must be nonnegative.")
    return wait / 1000 + 10


def _selection_query(profile_id: str, context: str) -> str:
    if not profile_id or context not in ("normal", "private"):
        raise ValueError("Explicit profile_id and normal/private context are required on every call.")
    return urlencode({"profile_id": profile_id, "context": context})


def tabs(*, profile_id: str, context: str, window_id: int | None = None, service_url: str | None = None) -> JsonObject:
    query = _selection_query(profile_id, context)
    if window_id is not None:
        query += "&" + urlencode({"window_id": window_id})
    return http("/tabs?" + query, url=service_url)


def find_tabs(*, match: JsonObject | None = None, query: str = "", service_url: str | None = None) -> JsonObject:
    """Find candidates in live inventories without selecting a default profile."""
    return http("/find-tabs", url=service_url, payload={"match": match if match is not None else {}, "query": query})


def request(operation: str, payload: JsonObject | None = None, *, profile_id: str, context: str,
            service_url: str | None = None) -> JsonObject:
    """Dispatch once to the profile/context supplied on this call; retain no selection."""
    query = _selection_query(profile_id, context)
    body: JsonObject = {**(payload or {}), "operation": operation}
    timeout = body.get("timeout_ms", 30000)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
        raise ValueError("timeout_ms must be positive.")
    return http("/request?" + query, url=service_url, payload=body, timeout=timeout / 1000 + 5)


def javascript(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("javascript", fields, profile_id=profile_id, context=context, service_url=service_url)


def list_frames(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("list_frames", fields, profile_id=profile_id, context=context, service_url=service_url)


def cdp(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("cdp", fields, profile_id=profile_id, context=context, service_url=service_url)


def tab_control(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("tab_control", fields, profile_id=profile_id, context=context, service_url=service_url)


def userscript(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("userscript", fields, profile_id=profile_id, context=context, service_url=service_url)


def window_control(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("window_control", fields, profile_id=profile_id, context=context, service_url=service_url)


def webextension(*, profile_id: str, context: str, service_url: str | None = None, **fields: Json) -> JsonObject:
    return request("webextension", fields, profile_id=profile_id, context=context, service_url=service_url)
