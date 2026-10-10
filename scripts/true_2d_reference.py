#!/usr/bin/env python3
"""Reproducible optional S4 reference against actual offline 2D module.

Build official pinned upstream S4 without modifying its tracked source. The
Laurent diagnostic checks algebra/order/port/channel mapping, not production
convergence. Full production/default convergence has its separate evidence.
"""

from __future__ import annotations

import argparse
import ctypes.util
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.contracts_2d import validate_result_2d  # noqa: E402
from rcwa_core.schemas_2d import Project2D  # noqa: E402
from rcwa_core.solver_2d import laurent_diagnostic_2d  # noqa: E402
from reference_check import S4_COMMIT, build_s4, command, digest, optical_index  # noqa: E402

CHANNELS = ("R", "T", "R_s", "R_p", "T_s", "T_p")


def build_driver(source, *, reuse_verified_library=False):
    source = Path(source).resolve()
    if command(["git", "rev-parse", "HEAD"], cwd=source).strip() != S4_COMMIT:
        raise RuntimeError("Reference source is not at the exact official pinned commit")
    if command(["git", "diff", "HEAD", "--"], cwd=source).strip():
        raise RuntimeError("Reference source has tracked changes")
    if not reuse_verified_library:
        build_s4(source)
    build = source / "build/rcwa_reference_2d"
    build.mkdir(parents=True, exist_ok=True)
    cpp = ROOT / "scripts/true_2d/s4_driver.cpp"
    binary = build / "reference_driver_2d"
    libs = [ctypes.util.find_library(name) for name in ("lapack", "blas")]
    if not all(libs) or not shutil.which("g++"):
        raise RuntimeError("g++ and installed BLAS/LAPACK are required")
    args = [
        shutil.which("g++"),
        "-O2",
        "-I",
        str(source / "S4"),
        str(cpp),
        str(source / "build/libS4.a"),
        *[f"-Wl,-l:{lib}" for lib in libs],
        "-o",
        str(binary),
    ]
    (build / "link.log").write_text(command(args))
    return binary, {
        "source_commit": S4_COMMIT,
        "source_url": "https://github.com/victorliu/S4",
        "tracked_source_clean": True,
        "source_tree": command(["git", "rev-parse", "HEAD^{tree}"], cwd=source).strip(),
        "driver_sha256": digest(cpp),
        "binary_sha256": digest(binary),
        "static_library_sha256": digest(source / "build/libS4.a"),
        "link_command": args,
        "fresh_library_build": not reuse_verified_library,
        "compiler": command([shutil.which("g++"), "--version"]).splitlines()[0],
        "formulation": "Upstream default 2D Laurent; independent exact geometry; no smoothing or injected matrices",
    }


def s4_solve(executable, project, wavelength, hx, hy):
    """Build reference geometry/materials independently, remap returned G labels."""
    n0, ns = optical_index(project.ambient, wavelength), optical_index(project.substrate, wavelength)
    layers = []
    for layer in project.layers:
        if not layer.thickness_nm:
            continue
        inclusion = optical_index(layer.material, wavelength)
        if layer.geometry == "homogeneous":
            wx, wy, bg = project.period_nm, project.period_y_nm, inclusion
        elif layer.geometry == "rectangle_1d":
            wx, wy, bg = layer.cd_nm, project.period_y_nm, optical_index(layer.background, wavelength)
        else:
            wx, wy, bg = layer.cd_x_nm, layer.cd_y_nm, optical_index(layer.background, wavelength)
        layers.append([layer.thickness_nm, wx, wy, inclusion.real, inclusion.imag, bg.real, bg.imag])
    # Explicit neutral zero-thickness film avoids upstream no-finite-layer quirk.
    if not layers:
        layers = [[0, project.period_nm, project.period_y_nm, n0.real, 0, n0.real, 0]]
    header = [
        project.period_nm,
        project.period_y_nm,
        wavelength,
        project.illumination.angle_deg,
        project.illumination.azimuth_deg,
        hx,
        hy,
        n0.real,
        ns.real,
        ns.imag,
        len(layers),
    ]
    payload = " ".join(map(str, header)) + "\n" + "\n".join(" ".join(map(str, row)) for row in layers) + "\n"
    started = perf_counter()
    output = subprocess.run(
        [str(executable)], input=payload, text=True, capture_output=True, check=True, timeout=120
    ).stdout.splitlines()
    labels = [(m, n) for n in range(-hy, hy + 1) for m in range(-hx, hx + 1)]
    count = len(labels)
    if len(output) != 2 * (count + 1):
        raise ValueError("Unexpected S4 output shape")
    answer = {}
    for i, pol in enumerate(("s", "p")):
        header = output[i * (count + 1)].split()
        if header[0] != pol or int(header[4]) != count:
            raise ValueError("S4 incident polarization or basis count mismatch")
        rows = {}
        for line in output[i * (count + 1) + 1 : (i + 1) * (count + 1)]:
            m, n, *values = line.split()
            label = (int(m), int(n))
            if label in rows or len(values) != 6:
                raise ValueError("Duplicate or malformed S4 order")
            rows[label] = dict(zip(CHANNELS, map(float, values)))
        if set(rows) != set(labels):
            raise ValueError("S4 returned a different explicit rectangular G set")
        answer[pol] = {
            "R": float(header[1]),
            "T": float(header[2]),
            "orders": [{"m": m, "n": n, **rows[(m, n)]} for m, n in labels],
        }
        for key in ("R", "T"):
            if abs(answer[pol][key] - sum(o[key] for o in rows.values())) > 1e-9:
                raise ValueError("S4 own order totals are inconsistent")
        for o in rows.values():
            if abs(o["R"] - o["R_s"] - o["R_p"]) > 1e-9 or abs(o["T"] - o["T_s"] - o["T_p"]) > 1e-9:
                raise ValueError("S4 independent channel projection disagrees with its flux")
    return {"seconds": perf_counter() - started, "spectra": answer}


def diagnostic_cases():
    def rectangle(d, wx, wy, n, k=0, bg=1):
        return {
            "geometry": "rectangle_2d",
            "thickness_nm": d,
            "cd_x_nm": wx,
            "cd_y_nm": wy,
            "material": {"n": n, "k": k},
            "background": {"n": bg},
        }

    base = {
        "schema_version": "1.2",
        "period_nm": 460,
        "period_y_nm": 420,
        "ambient": {"n": 1.33},
        "substrate": {"n": 0.4, "k": 3.1},
        "layers": [
            rectangle(110, 220, 180, 2.2),
            {"geometry": "homogeneous", "thickness_nm": 80, "material": {"n": 1.45}},
            rectangle(130, 290, 240, 1.9, 0.02),
        ],
        "solver": {"harmonics_x": 2, "harmonics_y": 3},
    }
    cases = []
    for theta, phi in [
        (0, 0),
        (0, 45),
        (0, 90),
        (0, 180),
        (0, 270),
        (31, 0),
        (31, 90),
        (31, 180),
        (31, 270),
        (31, 225),
    ]:
        cases.append(
            Project2D.model_validate(
                {
                    **base,
                    "name": f"Diagnostic theta{theta} phi{phi}",
                    "illumination": {"angle_deg": theta, "azimuth_deg": phi, "wavelengths_nm": [632.8]},
                }
            )
        )
    cases.append(
        Project2D.model_validate(
            {
                **base,
                "name": "Tabulated and mixed geometry",
                "substrate": {"n": 1.5},
                "layers": [
                    {
                        "geometry": "rectangle_1d",
                        "thickness_nm": 70,
                        "cd_nm": 190,
                        "material": {
                            "kind": "tabulated",
                            "wavelengths_nm": [400, 700, 900],
                            "n_values": [1.7, 1.9, 2.0],
                            "k_values": [0.01, 0.02, 0.03],
                        },
                    },
                    rectangle(110, 290, 240, 1, 0, 1.8),
                ],
                "illumination": {"angle_deg": 31, "azimuth_deg": 25, "wavelengths_nm": [450, 632.8, 850]},
            }
        )
    )
    return cases


def run_diagnostics(binary):
    records, worst = [], 0.0
    for project in diagnostic_cases():
        actual = laurent_diagnostic_2d(project)
        validate_result_2d(actual, project, laurent_diagnostic=True)
        rows = []
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            ref = s4_solve(binary, project, wavelength, project.solver.harmonics_x, project.solver.harmonics_y)
            errors = []
            for pol in ("s", "p"):
                for key in ("R", "T"):
                    errors.append(abs(actual["spectra"][pol][key][wi] - ref["spectra"][pol][key]))
                for a, b in zip(actual["spectra"][pol]["orders"][wi], ref["spectra"][pol]["orders"]):
                    errors.extend(abs(a[k] - b[k]) for k in CHANNELS)
            discrepancy = max(errors)
            worst = max(worst, discrepancy)
            rows.append({"wavelength_nm": wavelength, "S4": ref, "max_absolute_error": discrepancy})
        records.append({"input": project.model_dump(), "diagnostic_laurent": actual, "comparison": rows})
    return {
        "claim": "Same-Laurent algebraic diagnostic only; not production convergence",
        "tolerance": 1e-9,
        "passed": worst <= 1e-9,
        "worst_absolute_error": worst,
        "cases": records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--s4-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary, provenance = build_driver(args.s4_source)
    result = {
        "reference": provenance,
        "production_source_sha256": {
            str(path.relative_to(ROOT)): digest(path) for path in sorted((ROOT / "backend/rcwa_core").glob("*.py"))
        },
        "diagnostics": run_diagnostics(binary),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(result, allow_nan=False, separators=(",", ":")).encode()
    if args.output.suffix == ".gz":
        args.output.write_bytes(gzip.compress(data, mtime=0))
    else:
        args.output.write_bytes(data)
    print(
        json.dumps(
            {
                "passed": result["diagnostics"]["passed"],
                "worst_absolute_error": result["diagnostics"]["worst_absolute_error"],
                "evidence_sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    )
    return 0 if result["diagnostics"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
