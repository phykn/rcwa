"""Bounded HTTP transport for the local MCP adapter. No retries or discovery URLs."""

from __future__ import annotations

import json
import math
import re
from urllib.parse import urlsplit

import anyio
import httpx

MAX_REQUEST_BYTES = 2_000_000
MAX_RESPONSE_BYTES = 8_000_000
MAX_ACTIVE_CALLS = 4
ID_PATTERN = r"^[A-Za-z0-9_-]{1,100}$"


class AdapterError(Exception):
    def __init__(self, code, message, *, payload=None, http_status=None, outcome_unknown=False):
        super().__init__(message)
        self.payload = payload or {"detail": message, "error": {"code": code, "message": message, "diagnostics": []}}
        if http_status is not None:
            self.payload = {**self.payload, "http_status": http_status}
        if outcome_unknown:
            self.payload = {**self.payload, "outcome_unknown": True}


def local_url(value: str) -> str:
    """Pin localhost to an IP. Reject parser normalization and all remote targets."""
    if any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError("API URL must not contain whitespace or control characters")
    url = urlsplit(value)
    if (
        url.scheme != "http"
        or url.hostname not in {"localhost", "127.0.0.1", "::1"}
        or url.username is not None
        or url.password is not None
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
        or url.netloc.endswith(":")
    ):
        raise ValueError("Use a loopback HTTP API URL, for example http://127.0.0.1:8000")
    port = url.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("API port must be between 1 and 65535")
    host = "[::1]" if url.hostname == "::1" else "127.0.0.1"
    return f"http://{host}" + (f":{port}" if port is not None else "")


def strict_json(raw: bytes) -> dict:
    def reject(value):
        raise ValueError(f"Nonfinite JSON value: {value}")

    payload = json.loads(raw.decode("utf-8"), parse_constant=reject)
    json.dumps(payload, allow_nan=False)
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    return payload


class LocalAPI:
    def __init__(self, api_url="http://127.0.0.1:8000", timeout=10.0, *, transport=None):
        if not math.isfinite(timeout) or not 0 < timeout <= 30:
            raise ValueError("Request timeout must be greater than zero and at most 30 seconds")
        self.url = local_url(api_url)
        self.timeout = timeout
        self.slots = anyio.Semaphore(MAX_ACTIVE_CALLS)
        self.http = httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            timeout=timeout,
            transport=transport,
            limits=httpx.Limits(max_connections=MAX_ACTIVE_CALLS, max_keepalive_connections=MAX_ACTIVE_CALLS),
            headers={"Accept": "application/json", "Accept-Encoding": "identity"},
        )

    async def aclose(self):
        await self.http.aclose()

    async def request(self, method: str, path: str, body=None):
        # Even internal callers cannot turn this transport into a general HTTP tool.
        fixed = {("GET", "/api/capabilities"), ("GET", "/api/example"),
                 ("POST", "/api/validate"), ("POST", "/api/change-preview"),
                 ("POST", "/api/jobs"), ("POST", "/api/snapshots")}
        variable = re.fullmatch(r"/api/(jobs|projects)/([A-Za-z0-9_-]{1,100})", path)
        if (method, path) not in fixed and not (
            variable and (method == "GET" or (method == "DELETE" and variable[1] == "jobs"))
        ):
            raise AdapterError("invalid_route", "This HTTP route is not exposed by the adapter")
        try:
            data = None if body is None else json.dumps(body, allow_nan=False, ensure_ascii=False).encode("utf-8")
        except (ValueError, TypeError, RecursionError) as exc:
            raise AdapterError("invalid_arguments", "Arguments must be finite JSON") from exc
        if data is not None and len(data) > MAX_REQUEST_BYTES:
            raise AdapterError("request_too_large", "API request exceeds the 2 MB limit")
        try:
            self.slots.acquire_nowait()
        except anyio.WouldBlock as exc:
            raise AdapterError("adapter_capacity", "Four adapter calls are already active; wait for one to finish") from exc
        mutation = method in {"POST", "DELETE"} and path not in {"/api/validate", "/api/change-preview"}
        try:
            with anyio.fail_after(self.timeout):
                async with self.http.stream(
                    method, self.url + path, content=data, headers={"Content-Type": "application/json"}
                ) as response:
                    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                        raise ValueError("Compressed API responses are not accepted")
                    raw = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        raw.extend(chunk)
                        if len(raw) > MAX_RESPONSE_BYTES:
                            raise ValueError("API response exceeds the 8 MB limit")
                    payload = strict_json(bytes(raw))
                    if not 200 <= response.status_code < 300:
                        from api.contracts import ErrorResponse
                        ErrorResponse.model_validate(payload, strict=True)
                        raise AdapterError(
                            payload["error"]["code"], payload["error"]["message"],
                            payload=payload, http_status=response.status_code,
                            outcome_unknown=mutation and response.status_code >= 500,
                        )
                    return payload
        except AdapterError:
            raise
        except (httpx.HTTPError, TimeoutError, ValueError, UnicodeError, RecursionError) as exc:
            code = "outcome_unknown" if mutation else "api_unavailable"
            message = "No trustworthy API response was received"
            if mutation:
                message += "; the operation may have occurred. Do not automatically resubmit it"
            raise AdapterError(code, message, outcome_unknown=mutation) from exc
        finally:
            self.slots.release()
