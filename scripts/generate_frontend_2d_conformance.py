"""Generate schema-1.2 frontend identity vectors with unchanged backend helpers.

No forward solve is invoked. --check verifies committed vectors byte-for-byte.
Run with the repository's pinned Python/Pydantic environment.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import gzip
import json
import math
from pathlib import Path
import random
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import pydantic  # noqa: E402
from rcwa_core.identity import canonical_hash  # noqa: E402
from rcwa_core.project_io import normalized_project_and_hash, validate_result_for_project  # noqa: E402
from rcwa_core.preflight import refractive_index  # noqa: E402
from rcwa_core.preflight_2d import wavevectors  # noqa: E402

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
            _, normalized, digest = normalized_project_and_hash(json.loads(source))
            canonical = json.dumps(
                normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
            assert digest == canonical_hash(normalized) == hashlib.sha256(canonical.encode()).hexdigest()
            item.update(accepted=True, canonical=canonical, sha256=digest, utf8_hex=canonical.encode().hex())
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
    floats = [{"bits": struct.pack(">d", value).hex(), "python": repr(value)} for value in float_values]
    # Small deterministic mutations of the immutable result test contracts only.
    # These are not forward solves, new numerical references, or accuracy evidence.
    result_bytes = (ROOT / "backend/tests/fixtures/true-2d/default-result-H5.json.gz").read_bytes()
    assert (
        hashlib.sha256(result_bytes).hexdigest() == "8a978f155cdbeb5a74e258253b1aae52bf8bc0f6513e934564d725d7715cd36c"
    )
    result_source = json.loads(gzip.decompress(result_bytes))
    base_project = deepcopy(default)
    base_project["illumination"]["wavelengths_nm"] = [default["illumination"]["wavelengths_nm"][0]]
    base_project["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
    base_result = deepcopy(result_source)
    base_result["wavelengths_nm"] = base_project["illumination"]["wavelengths_nm"]
    meta = base_result["metadata"]
    meta.update(
        harmonics_x=1, harmonics_y=1, basis_size=9, retained_orders=[[m, n] for n in range(-1, 2) for m in range(-1, 2)]
    )
    for series in base_result["spectra"].values():
        orders = [o for o in series["orders"][0] if abs(o["m"]) <= 1 and abs(o["n"]) <= 1]
        series["orders"] = [orders]
        series["R"] = [sum(o["R"] for o in orders)]
        series["T"] = [sum(o["T"] for o in orders)]
        series["R_specular"] = [orders[4]["R"]]
        series["T_specular"] = [orders[4]["T"]]
        series["A_balance"] = [1 - series["R"][0] - series["T"][0]]
    meta["max_lossless_flux_error"] = max(abs(s["A_balance"][0]) for s in base_result["spectra"].values())
    binding_cases = []

    def binding(name, edit=None, result_edit=None):
        p, r = deepcopy(base_project), deepcopy(base_result)
        if edit:
            edit(p)
        model, normalized, digest = normalized_project_and_hash(p)
        r["metadata"]["input_hash"] = digest
        r["wavelengths_nm"] = list(model.illumination.wavelengths_nm)
        local_classification_ambiguous = False
        r["metadata"]["layer_count"] = len(model.layers)
        r["metadata"]["active_slab_count"] = sum(layer.thickness_nm > 0 for layer in model.layers)
        r["metadata"]["total_thickness_nm"] = sum(layer.thickness_nm for layer in model.layers)
        # Derive only classifications/wavevectors from unchanged binder helpers.
        wl = model.illumination.wavelengths_nm[0]
        n0 = refractive_index(model.ambient, wl).real
        ns = refractive_index(model.substrate, wl)
        kx, ky = wavevectors(model, wl, 1, 1)
        for series in r["spectra"].values():
            for order in series["orders"][0]:
                x, y = float(kx[order["m"] + 1]), float(ky[order["n"] + 1])
                qr, qt = n0**2 - x * x - y * y, ns**2 - x * x - y * y
                local_classification_ambiguous |= abs(qr) < 1e-10 or not ns.imag and abs(qt.real) < 1e-10
                classification = "absorbing_half_space" if ns.imag else "propagating" if qt.real > 0 else "evanescent"
                order.update(
                    kx_over_k0=x,
                    ky_over_k0=y,
                    reflection_propagating=bool(qr > 0),
                    transmission_class=classification,
                    transmission_propagating=None if ns.imag else bool(qt.real > 0),
                )
        if result_edit:
            result_edit(r)
        try:
            validate_result_for_project("forward", r, normalized)
            accepted = True
        except ValueError:
            accepted = False
        binding_cases.append(
            {
                "name": name,
                "project": normalized,
                "result": r,
                "accepted": accepted,
                "local_classification_ambiguous": bool(local_classification_ambiguous),
            }
        )

    binding("immutable-derived-H1-single-wave")
    binding("active-material-loss-requires-null", lambda p: p["layers"][0]["material"].update(k=0.1))
    binding(
        "active-material-loss-null",
        lambda p: p["layers"][0]["material"].update(k=0.1),
        lambda r: r["metadata"].update(max_lossless_flux_error=None),
    )
    binding(
        "inactive-zero-X-material-loss",
        lambda p: (p["layers"][0].update(cd_x_nm=0), p["layers"][0]["material"].update(k=0.1)),
    )
    binding(
        "inactive-zero-Y-material-loss",
        lambda p: (p["layers"][0].update(cd_y_nm=0), p["layers"][0]["material"].update(k=0.1)),
    )
    binding(
        "inactive-zero-thickness-material-loss",
        lambda p: (p["layers"][0].update(thickness_nm=0), p["layers"][0]["material"].update(k=0.1)),
    )
    binding(
        "inactive-full-width-background-loss",
        lambda p: (
            p["layers"][0].update(cd_x_nm=p["period_nm"], cd_y_nm=p["period_y_nm"]),
            p["layers"][0]["background"].update(k=0.1),
        ),
    )
    binding(
        "active-background-loss",
        lambda p: p["layers"][0]["background"].update(k=0.1),
        lambda r: r["metadata"].update(max_lossless_flux_error=None),
    )
    binding("absorbing-substrate-is-not-finite-loss", lambda p: p["substrate"].update(k=0.1))
    binding(
        "absorbing-substrate-must-retain-lossless-flux",
        lambda p: p["substrate"].update(k=0.1),
        lambda r: r["metadata"].update(max_lossless_flux_error=None),
    )
    for theta in [0.0, 20.0, 37.0, 75.0]:
        wl = base_project["illumination"]["wavelengths_nm"][0]
        nominal = wl / (1 - math.sin(math.radians(theta)))
        if nominal > 5000:
            continue
        for direction, pitch in [
            ("below", math.nextafter(nominal, 0.0)),
            ("at", nominal),
            ("above", math.nextafter(nominal, math.inf)),
        ]:
            binding(
                f"near-cutoff-theta-{theta}-{direction}",
                lambda p, pitch=pitch, theta=theta: (
                    p.update(period_nm=pitch),
                    p["illumination"].update(angle_deg=theta, azimuth_deg=0),
                ),
            )

    def known_trig_discrepancy(p):
        p.update(period_nm=1863.483715055275, period_y_nm=350)
        p["illumination"].update(wavelengths_nm=[500], angle_deg=47.027868717108475, azimuth_deg=0)

    def wrong_cutoff_flag(r):
        for series in r["spectra"].values():
            for order in series["orders"][0]:
                if order["m"] == 1 and order["n"] == 0:
                    order["reflection_propagating"] = True

    binding("numpy-browser-cutoff-discrepancy-correct", known_trig_discrepancy)
    binding("numpy-browser-cutoff-discrepancy-mutated", known_trig_discrepancy, wrong_cutoff_flag)
    for direction, sign in [("below", -1), ("above", 1)]:
        wl = base_project["illumination"]["wavelengths_nm"][0]
        pitch = wl / math.sqrt(1 + sign * 2e-10)
        binding(
            f"outside-cutoff-exclusion-{direction}",
            lambda p, pitch=pitch: (p.update(period_nm=pitch), p["illumination"].update(angle_deg=0, azimuth_deg=0)),
        )
    return {
        "authority": {
            "pydantic": pydantic.__version__,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "helper": "unchanged rcwa_core.project_io.normalized_project_and_hash + identity.canonical_hash",
            "project_fixture_sha256": PROJECT_SHA,
            "seed": 120013,
            "solves": 0,
        },
        "projects": cases,
        "floats": floats,
        "binding_case_notice": "Validation-only deterministic mutations of immutable reference; not numerical solutions or convergence evidence.",
        "bindings": binding_cases,
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
                "float_cases": len(data["floats"]),
                "binding_cases": len(data["bindings"]),
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
                "solves": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
