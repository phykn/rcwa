"""Generate schema-1.2 frontend normalization vectors with unchanged backend helpers.

Each case records whether the backend accepts a raw project and, if so, its
normalized form. No forward solve is invoked. --check verifies committed vectors
byte-for-byte. Run with the repository's pinned Python/Pydantic environment.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import pydantic  # noqa: E402
from rcwa_core.project_io import normalized_project_and_hash  # noqa: E402

OUTPUT = ROOT / "frontend/src/core/fixtures/project-2d-conformance.json"
PROJECT_SHA = "8dbe8260fa61ba3ec8f82ffefc5a5749ea75587b035d9f381edf66b695755294"


def build():
    assert pydantic.__version__ == "2.12.5", "Use pinned Pydantic 2.12.5"
    original = (ROOT / "backend/tests/fixtures/true-2d/default-project.json").read_bytes()
    assert hashlib.sha256(original).hexdigest() == PROJECT_SHA
    default = json.loads(original)
    minimal = {
        "schema_version": "1.2",
        "period_nm": 300,
        "period_y_nm": 350,
        "layers": [{"geometry": "rectangle_2d", "cd_x_nm": 70, "cd_y_nm": 60, "material": {}, "background": {}}],
        "illumination": {"wavelengths_nm": [500]},
    }
    cases = []

    def add(name, value=None, *, raw=None):
        source = raw if raw is not None else json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        item = {"name": name, "raw": source}
        try:
            _, normalized, _ = normalized_project_and_hash(json.loads(source))
            canonical = json.dumps(
                normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
            item.update(accepted=True, canonical=canonical)
        except (ValueError, TypeError, UnicodeError) as error:
            item.update(accepted=False, error_type=type(error).__name__)
        cases.append(item)

    add("immutable-default", default)
    add("minimal-defaults", minimal)
    mixed = deepcopy(minimal)
    mixed["layers"] += [{"geometry": "rectangle_1d"}, {"geometry": "homogeneous"}]
    add("mixed-default-layers", mixed)
    for name in [" ", "이름 🔬 café e\u0301", "🧪" * 100, "🧪" * 101, "\ud800", "\udfff"]:
        p = deepcopy(minimal)
        p["name"] = name
        add("unicode-" + str(len(cases)), p)
    table = deepcopy(mixed)
    table["layers"][0]["material"] = {
        "kind": "tabulated",
        "name": "非ASCII e\u0301",
        "wavelengths_nm": [400, 500, 800],
        "n_values": [1.7, 2.0, 2.2],
        "k_values": [-0.0, 0.0, 0.4],
        "source": "🔬 synthetic",
    }
    add("tabulated-mixed", table)
    for name, path, value in [
        ("null-source", ["layers", 0, "material", "source"], None),
        ("unknown-key", ["solver", "unexpected"], 3),
        ("null-solver", ["solver"], None),
        ("float-harmonic", ["solver", "harmonics_x"], 3.0),
        ("string-harmonic", ["solver", "harmonics_x"], "3"),
        ("boolean-number", ["period_nm"], True),
        ("string-number", ["period_nm"], "300"),
        ("nonfinite", ["period_nm"], float("inf")),
        ("missing-geometry", ["layers", 0, "geometry"], None),
        ("table-coverage-unused", ["layers", 0, "material", "wavelengths_nm"], [600, 700, 800]),
    ]:
        p = deepcopy(table if name.startswith("table") else minimal)
        if name.startswith("table"):
            p["layers"][0]["thickness_nm"] = 0
        current = p
        for key in path[:-1]:
            if isinstance(current, dict) and key not in current:
                current[key] = {}
            current = current[key]
        current[path[-1]] = value
        add(name, p)
    source = json.dumps(minimal, separators=(",", ":"))
    for token in ["-0", "0", "-0.0", "-0e0", "-0e-999", "-1e-999", "0.0", "0e0"]:
        add(
            "zero-token-" + token,
            raw=source.replace('"wavelengths_nm":[500]', '"azimuth_deg":' + token + ',"wavelengths_nm":[500]'),
        )
    for token in ["3", "3.0", "3e0", "3E+0", "true", '"3"', "-0"]:
        add("integer-token-" + token, raw=source[:-1] + ',"solver":{"harmonics_x":' + token + "}}")
    # Escaped keys and number-like quoted strings cannot confuse raw scanning.
    add(
        "escaped-member-and-digit-string",
        raw=source.replace('"period_nm"', '"period_\\u006em"').replace(
            '"schema_version"', '"name":"3e0 -0 \\" \\\\ 1.2","schema_version"'
        ),
    )
    rng = random.Random(120013)
    float_values = [
        0.0,
        -0.0,
        5e-324,
        -5e-324,
        1e-4,
        1e-5,
        1e15,
        1e16,
        1e23,
        1.0000000000000002,
        2.2250738585072014e-308,
        1.7976931348623157e308,
        1000000000000000128.0,
        2.9802322387695312e-8,
    ]
    for power in range(-323, 309):
        try:
            value = 10.0**power
        except OverflowError:
            continue
        if math.isfinite(value) and value:
            float_values.extend([value, math.nextafter(value, 0.0), math.nextafter(value, math.inf)])
    for _ in range(4096):
        value = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
        if math.isfinite(value):
            float_values.append(value)
    for i in range(128):
        p = deepcopy(minimal)
        p["layers"][0]["thickness_nm"] = abs(float_values[rng.randrange(len(float_values))]) % 2000
        p["layers"][0]["material"]["k"] = abs(float_values[rng.randrange(len(float_values))]) % 10
        add(f"float-project-{i:03}", p)
    return {
        "authority": {
            "pydantic": pydantic.__version__,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "helper": "unchanged rcwa_core.project_io.normalized_project_and_hash",
            "project_fixture_sha256": PROJECT_SHA,
            "seed": 120013,
            "solves": 0,
        },
        "projects": cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = build()
    content = (json.dumps(data, ensure_ascii=True, indent=2) + "\n").encode()
    if args.check:
        assert OUTPUT.read_bytes() == content, "Frontend 1.2 conformance vectors differ from pinned backend authority"
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(content)
    print(
        json.dumps(
            {
                "project_cases": len(data["projects"]),
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
                "solves": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
