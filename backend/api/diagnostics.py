import json

# Limits include JSON escaping, not just character counts. Fifty diagnostics,
# each with at most 512-byte message/location and 64-byte code, stay below 64 KB.
MAX_ERROR_DIAGNOSTICS = 50
MAX_ERROR_TEXT_BYTES = 512
MAX_ERROR_LOCATION_BYTES = 512
MAX_ERROR_CODE_BYTES = 64
TRUNCATED = " [truncated]"


def _json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _bounded_text(value, limit=MAX_ERROR_TEXT_BYTES):
    if _json_bytes(value) <= limit:
        return value
    # First bound the work for long messages; then account for JSON escaping.
    prefix = value.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
    while _json_bytes(prefix + TRUNCATED) > limit:
        prefix = prefix[:len(prefix) // 2]
    return prefix + TRUNCATED


def _bounded_location(location):
    result = []
    for part in location:
        part = _bounded_text(part, 128) if isinstance(part, str) else part
        if _json_bytes([*result, part, TRUNCATED.strip()]) > MAX_ERROR_LOCATION_BYTES:
            result.append(TRUNCATED.strip())
            break
        result.append(part)
    return result


def structured_diagnostics(error, code):
    for item in error.errors():
        structured = getattr(item.get("ctx", {}).get("error"), "diagnostics", None)
        if structured:
            yield from (diagnostic.model_dump() for diagnostic in structured)
        else:
            location = list(item["loc"])
            yield {"code": code(location), "severity": "error", "location": location, "message": item["msg"]}


def _bounded_diagnostics(diagnostics):
    result = []
    for item in diagnostics:
        if len(result) == MAX_ERROR_DIAGNOSTICS:
            result[-1] = {
                "code": "diagnostics_truncated", "severity": "error", "location": [],
                "message": f"Additional validation diagnostics omitted; at most {MAX_ERROR_DIAGNOSTICS} are returned.",
            }
            break
        result.append({
            "code": _bounded_text(item["code"], MAX_ERROR_CODE_BYTES),
            "severity": item["severity"],
            "location": _bounded_location(item["location"]),
            "message": _bounded_text(item["message"]),
        })
    return result


