#!/usr/bin/env python3
"""Optional, actual meent-versus-S4 numerical cross-check (no canned reference).

Run from the project root with .venv/bin/python scripts/reference_check.py
--s4-source /path/to/victorliu-S4 --output /tmp/rcwa-reference.json.
This compiles the pinned, clean upstream S4 source locally; it never downloads,
installs dependencies, publishes, or changes the production solver.
"""

from __future__ import annotations

import argparse
import ctypes.util
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.schemas import HomogeneousLayer, Layer, Material, Project  # noqa: E402
from rcwa_core.solver import forward  # noqa: E402

S4_COMMIT = "7fd00a231610bff51f5c7de5f723e3956eab7453"
S4_URL = "https://github.com/victorliu/S4"
TOLERANCE = 1e-9
# A small original bridge around S4's public API, with pinned internal access
# solely for by-order flux and explicit basis inspection. No S4 code is vendored.
BRIDGE_CPP = r"""
#include "S4.h"
#include "S4_internal.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>
static void ok(int r, const char* name){if(r!=0){fprintf(stderr,"S4 %s returned %d\n",name,r); exit(2);}}
static int mat(S4_Simulation*S,const char*name,double n,double k){double e[2]={n*n-k*k,2*n*k};int m=S4_Simulation_SetMaterial(S,-1,name,S4_MATERIAL_TYPE_SCALAR_COMPLEX,e);if(m<0) exit(2);return m;}
int main(int argc,char**argv){
 if(argc<9){fprintf(stderr,"usage: driver pitch wavelength angle H ambient_n substrate_n substrate_k layer_count [height cd ridge_n ridge_k background_n background_k]...\n");return 2;}
 double pitch=atof(argv[1]),wl=atof(argv[2]),angle=atof(argv[3])*acos(-1)/180;
 int H=atoi(argv[4]),N=2*H+1,L=atoi(argv[8]);if(L<1||L>8||argc!=9+6*L)return 2;
 std::vector<int> G(2*N,0);int gi=1;for(int m=-H;m<=H;++m){if(m){G[2*gi++]=m;}}
 for(int pol=0;pol<2;++pol){
 double lattice[4]={pitch,0,0,0};auto S=S4_Simulation_New(lattice,N,G.data());
 int a=mat(S,"ambient",atof(argv[5]),0),b=mat(S,"substrate",atof(argv[6]),atof(argv[7]));
 double zero=0;int top=S4_Simulation_SetLayer(S,-1,"top",&zero,-1,a);if(top<0)return 2;
 for(int j=0;j<L;++j){
 int i=9+6*j;double height=atof(argv[i]),cd=atof(argv[i+1]);std::string name="layer"+std::to_string(j);
 int r=mat(S,(name+"_ridge").c_str(),atof(argv[i+2]),atof(argv[i+3])),bg=mat(S,(name+"_background").c_str(),atof(argv[i+4]),atof(argv[i+5]));
 int film=S4_Simulation_SetLayer(S,-1,name.c_str(),&height,-1,cd==pitch?r:bg);if(film<0)return 2;
 if(cd>0&&cd<pitch){double hw[2]={cd/2,0},center[2]={pitch/2,0};ok(S4_Layer_SetRegionHalfwidths(S,film,r,S4_REGION_TYPE_INTERVAL,hw,center,&zero),"region");}
 }
 int bot=S4_Simulation_SetLayer(S,-1,"bottom",&zero,-1,b);if(bot<0)return 2;
 double freq[2]={1/wl,0},kdir[3]={sin(angle),0,cos(angle)},udir[3]={0,1,0},u[2]={double(pol==0),0},v[2]={double(pol==1),0};
 ok(S4_Simulation_SetFrequency(S,freq),"frequency");ok(S4_Simulation_ExcitationPlanewave(S,kdir,udir,u,v),"excitation");
 double ft[4],fb[4];ok(S4_Simulation_GetPowerFlux(S,top,&zero,ft),"top flux");ok(S4_Simulation_GetPowerFlux(S,bot,&zero,fb),"bottom flux");
 std::vector<double> pt(4*N),pb(4*N);ok(Simulation_GetPoyntingFluxByG(S,&S->layer[top],0,pt.data()),"top orders");ok(Simulation_GetPoyntingFluxByG(S,&S->layer[bot],0,pb.data()),"bottom orders");
 printf("%c %.17g %.17g %.17g %d\n",pol?'p':'s',-ft[1]/ft[0],fb[0]/ft[0],ft[0],S->n_G);
 for(int i=0;i<S->n_G;++i)printf("%d %.17g %.17g\n",S->G[2*i],-pt[4*i+1]/ft[0],pb[4*i]/ft[0]);
 S4_Simulation_Destroy(S);
 }
 return 0;
}
"""


def command(args, *, cwd=None, timeout=180):
    return subprocess.run(
        args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=timeout
    ).stdout


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_s4(source: Path):
    if command(["git", "rev-parse", "HEAD"], cwd=source).strip() != S4_COMMIT:
        raise RuntimeError(f"Use official upstream S4 at exactly {S4_COMMIT}")
    if command(["git", "diff", "HEAD", "--"], cwd=source).strip():
        raise RuntimeError("S4 has tracked source modifications; a clean pinned source is required")
    compiler = shutil.which("g++")
    if not compiler or not shutil.which("make"):
        raise RuntimeError("This optional Linux reference build requires g++ and make")
    if platform.system() != "Linux":
        raise RuntimeError("The reference build recipe has been checked only on Linux")
    libs = [ctypes.util.find_library(name) for name in ("lapack", "blas")]
    if not all(libs):
        raise RuntimeError("The reference build requires existing LAPACK and BLAS runtime libraries")
    build = source / "build" / "rcwa_reference"
    build.mkdir(parents=True, exist_ok=True)
    # -B avoids using stale .o files from another flag set or source revision.
    build_args = ["make", "-B", "-j2", "build/libS4.a"]
    try:
        log = command(build_args, cwd=source)
    except subprocess.CalledProcessError as exc:
        (build / "build.log").write_text(exc.stdout)
        raise RuntimeError(f"S4 build failed; see {build / 'build.log'}") from exc
    (build / "build.log").write_text(log)
    cpp = build / "reference_driver.cpp"
    executable = build / "reference_driver"
    cpp.write_text(BRIDGE_CPP)
    link_args = [
        compiler,
        "-O2",
        "-I",
        str(source / "S4"),
        str(cpp),
        str(source / "build/libS4.a"),
        *[f"-Wl,-l:{lib}" for lib in libs],
        "-o",
        str(executable),
    ]
    try:
        command(link_args, cwd=source)
    except subprocess.CalledProcessError as exc:
        (build / "link.log").write_text(exc.stdout)
        raise RuntimeError(f"S4 bridge link failed; see {build / 'link.log'}") from exc
    return executable, {
        "repository": S4_URL,
        "commit": S4_COMMIT,
        "tracked_source_clean": True,
        "compiler": command([compiler, "--version"]).splitlines()[0],
        "build_command": build_args,
        "link_command": link_args,
        "linked_libraries": libs,
        "binary_sha256": digest(executable),
        "build_log": str(build / "build.log"),
        "formulation": "Analytic Fourier coefficients, upstream 1D proper Fourier-factorization rule, S-matrix; no smoothing",
        "basis": "Explicit 0 followed by -H..-1,+1..+H; same set as meent -H..+H",
        "material_convention": "S4 epsilon=(n+i*k)^2, exp(-i*omega*t)",
    }


def optical_index(material: Material, wavelength: float):
    """Independent piecewise-linear evaluation; not the app's interpolation helper."""
    if material.kind == "constant":
        return complex(material.n, material.k)
    ws = material.wavelengths_nm
    if not ws[0] <= wavelength <= ws[-1]:
        raise ValueError("Reference material extrapolation is forbidden")
    for i in range(len(ws) - 1):
        if ws[i] <= wavelength <= ws[i + 1]:
            f = (wavelength - ws[i]) / (ws[i + 1] - ws[i])
            return complex(
                material.n_values[i] * (1 - f) + material.n_values[i + 1] * f,
                material.k_values[i] * (1 - f) + material.k_values[i + 1] * f,
            )
    raise AssertionError("Unreachable material interpolation")


def s4_solve(executable, project, wavelength):
    ambient = optical_index(project.ambient, wavelength)
    substrate = optical_index(project.substrate, wavelength)
    args = [
        project.period_nm,
        wavelength,
        project.illumination.angle_deg,
        project.solver.harmonics,
        ambient.real,
        substrate.real,
        substrate.imag,
        len(project.layers),
    ]
    # S4 independently receives every physical layer in top-to-bottom order,
    # including zero-thickness layers. Homogeneous films are full-width cells.
    for layer in project.layers:
        ridge = optical_index(layer.material, wavelength)
        if layer.geometry == "homogeneous":
            cd, background = project.period_nm, ridge
        else:
            cd, background = layer.cd_nm, optical_index(layer.background, wavelength)
        args.extend([layer.thickness_nm, cd, ridge.real, ridge.imag, background.real, background.imag])
    lines = command([str(executable), *map(str, args)], timeout=30).splitlines()
    result = {}
    cursor = 0
    for polarization in ("s", "p"):
        pol, reflection, transmission, flux, count = lines[cursor].split()
        count = int(count)
        if pol != polarization or count != 2 * project.solver.harmonics + 1:
            raise RuntimeError("Unexpected S4 basis or polarization output")
        cursor += 1
        orders = {}
        for row in lines[cursor : cursor + count]:
            order, r, t = row.split()
            orders[int(order)] = {"R": float(r), "T": float(t)}
        if set(orders) != set(range(-project.solver.harmonics, project.solver.harmonics + 1)):
            raise RuntimeError("S4 retained reciprocal vectors differ from meent")
        result[pol] = {"R": float(reflection), "T": float(transmission), "incident_flux": float(flux), "orders": orders}
        cursor += count
    if cursor != len(lines):
        raise RuntimeError("Unexpected trailing S4 output")
    return result


def scenarios(skip_absorbing_substrate=False):
    def project(name, **settings):
        p = Project(name=name)
        p.illumination.wavelengths_nm = settings.pop("wavelengths", [450.0, 550.0, 650.0, 850.0])
        for key, value in settings.items():
            obj, field = {
                "H": (p.solver, "harmonics"),
                "angle": (p.illumination, "angle_deg"),
                "period": (p, "period_nm"),
                "cd": (p.layers[0], "cd_nm"),
                "height": (p.layers[0], "thickness_nm"),
                "n": (p.layers[0].material, "n"),
                "k": (p.layers[0].material, "k"),
                "background_k": (p.layers[0].background, "k"),
                "ambient_n": (p.ambient, "n"),
                "substrate_n": (p.substrate, "n"),
                "substrate_k": (p.substrate, "k"),
            }[key]
            setattr(obj, field, value)
        return Project.model_validate(p.model_dump())

    for h in (3, 7, 11, 15):
        yield project(f"lossless_rectangle_H{h}", H=h)
    yield project("normal_incidence", angle=0.0)
    yield project("oblique_55_degrees", angle=55.0, H=11)
    yield project("high_contrast_lossy_ridge", n=3.8, k=0.02, height=240.0, cd=167.0, H=11)
    yield project("lossy_ridge", k=0.1)
    yield project("lossy_background", k=0.03, background_k=0.02)
    yield project("uniform_lossy_film", cd=400.0, k=0.1)
    yield project("empty_ridge", cd=0.0)
    yield project("zero_thickness", height=0.0)
    yield project(
        "many_propagating_orders", period=800.0, cd=370.0, angle=30.0, H=11, wavelengths=[450.0, 550.0, 750.0]
    )
    yield project("immersion_ambient", ambient_n=1.33)
    if not skip_absorbing_substrate:
        yield project("absorbing_substrate", substrate_n=3.5, substrate_k=0.1, wavelengths=[450.0, 550.0, 632.8, 850.0])
        yield project("absorbing_substrate_and_ridge", substrate_n=3.8, substrate_k=0.5, k=0.1, H=11, angle=55.0)
        yield project("strongly_absorbing_substrate", substrate_n=0.8, substrate_k=2.0, k=0.05, H=11, angle=67.0)
        yield project("metal_like_substrate", substrate_n=0.25, substrate_k=5.0, H=15, angle=31.0)
    p = project("independent_tabulated_interpolation")
    p.layers[0].material = Material(
        kind="tabulated", wavelengths_nm=[400.0, 600.0, 900.0], n_values=[2.4, 2.1, 1.9], k_values=[0.08, 0.03, 0.0]
    )
    yield p
    yield from stack_scenarios(skip_absorbing_substrate)


def stack_scenarios(skip_absorbing_substrate=False):
    def material(n):
        return Material(n=complex(n).real, k=complex(n).imag)

    def rectangle(d, cd, n, background=1):
        return Layer(thickness_nm=d, cd_nm=cd, material=material(n), background=material(background))

    def film(d, n):
        return HomogeneousLayer(thickness_nm=d, material=material(n))

    def stack(name, layers, *, angle=31, substrate=1.5, period=400, H=11):
        return Project(
            schema_version="1.1",
            name=name,
            period_nm=period,
            layers=layers,
            substrate=material(substrate),
            solver={"harmonics": H},
            illumination={"wavelengths_nm": [450.0, 632.8, 850.0], "angle_deg": angle},
        )

    for h in (3, 7, 11, 15, 19):
        yield stack(f"two_rectangles_H{h}", [rectangle(95, 167, 2.4), rectangle(130, 247, 1.8, 1.1)], H=h)
    for angle in (0, 67):
        yield stack(
            f"two_rectangles_angle{angle}", [rectangle(95, 167, 2.4), rectangle(130, 247, 1.8, 1.1)], angle=angle
        )
    yield stack("pattern_then_lossy_lower_film", [rectangle(85, 167, 2.4), film(110, 1.8 + 0.05j)])
    yield stack("film_then_lossy_lower_pattern", [film(110, 1.8), rectangle(85, 247, 2.4 + 0.1j, 1.1)])
    yield stack("two_patterns_lossy_lower_background", [rectangle(95, 167, 2.4), rectangle(130, 247, 1.8, 1.1 + 0.03j)])
    yield stack("planar_three_films", [film(71, 2.1 + 0.13j), film(123, 1.4 + 0.02j), film(58, 2.5)])
    yield stack(
        "zero_thickness_middle", [rectangle(95, 167, 2.4), rectangle(0, 100, 3.5 + 0.3j), rectangle(130, 247, 1.8, 1.1)]
    )
    yield stack("all_zero_stack", [film(0, 2.1 + 0.13j), rectangle(0, 100, 3.5 + 0.3j)])
    yield stack("empty_full_rectangles", [rectangle(95, 0, 2.4 + 0.1j, 1.3), rectangle(130, 400, 1.8, 1.1 + 0.03j)])
    yield stack("split_identical_pattern", [rectangle(60, 180, 2.1), rectangle(100, 180, 2.1)])
    yield stack("reordered_planar_films", [film(125, 1.3), film(80, 2.1)])
    yield stack(
        "stack_many_propagating_orders", [rectangle(95, 367, 2.4), rectangle(130, 447, 1.8, 1.1)], angle=12, period=800
    )
    yield stack(
        "eight_distinct_layers",
        [rectangle(70 + 11 * j, 100 + 27 * j, 2 + 0.13 * j + 0.02j, 1 + 0.03 * j) for j in range(8)],
    )
    p = stack("lower_layer_independent_tables", [rectangle(95, 167, 2.4), rectangle(130, 247, 1.8, 1.1)])
    p.layers[1].material = Material(
        kind="tabulated", wavelengths_nm=[400, 600, 900], n_values=[2.4, 2.1, 1.9], k_values=[0.08, 0.03, 0.0]
    )
    p.layers[1].background = Material(
        kind="tabulated", wavelengths_nm=[400, 700, 900], n_values=[1.1, 1.2, 1.3], k_values=[0.01, 0.02, 0.04]
    )
    yield p
    if not skip_absorbing_substrate:
        yield stack(
            "stack_absorbing_substrate", [film(110, 1.8), rectangle(85, 247, 2.4 + 0.1j, 1.1)], substrate=3.5 + 0.1j
        )
        yield stack(
            "two_patterns_metal_substrate",
            [rectangle(95, 167, 2.4 + 0.1j), rectangle(130, 247, 1.8, 1.1 + 0.03j)],
            substrate=0.25 + 5j,
        )


def refinement_evidence(records):
    """Compare finite-basis totals separately from cross-engine agreement."""
    sequence, previous = [], None
    for h in (3, 7, 11, 15, 19):
        case = next(case for case in records if case["name"] == f"two_rectangles_H{h}")
        values = [sample["meent"][key] for sample in case["samples"] for key in ("R", "T")]
        sequence.append(
            {
                "harmonics": h,
                "max_total_R_T_change": None if previous is None else max(abs(a - b) for a, b in zip(values, previous)),
            }
        )
        previous = values
    return {"claim": "Sample-specific basis refinement evidence; no convergence certification", "sequence": sequence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--s4-source", type=Path, required=True, help="Clean git checkout of pinned official victorliu/S4"
    )
    parser.add_argument("--output", type=Path, help="Write full JSON audit in addition to a console summary")
    parser.add_argument(
        "--skip-absorbing-substrate",
        action="store_true",
        help="Explicitly omit these cases if testing an earlier lossless-port adapter",
    )
    args = parser.parse_args()
    started = perf_counter()
    executable, provenance = build_s4(args.s4_source.resolve())
    records, errors = [], []
    for project in scenarios(args.skip_absorbing_substrate):
        computed = forward(project)
        case = {"name": project.name, "input": project.model_dump(), "samples": []}
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            reference = s4_solve(executable, project, wavelength)
            for pol in ("s", "p"):
                actual = computed["spectra"][pol]
                expected = reference[pol]
                absolute_errors = [abs(actual[key][wi] - expected[key]) for key in ("R", "T")]
                for order in actual["orders"][wi]:
                    absolute_errors += [abs(order[key] - expected["orders"][order["m"]][key]) for key in ("R", "T")]
                if not all(map(math.isfinite, absolute_errors)):
                    raise RuntimeError("Non-finite cross-engine comparison")
                error = max(absolute_errors)
                errors.append(error)
                case["samples"].append(
                    {
                        "wavelength_nm": wavelength,
                        "polarization": pol,
                        "meent": {key: actual[key][wi] for key in ("R", "T", "A_balance")},
                        "S4": {key: expected[key] for key in ("R", "T", "incident_flux")},
                        "max_absolute_R_T_order_error": error,
                        "meent_orders": actual["orders"][wi],
                        "S4_orders": expected["orders"],
                    }
                )
        case["max_absolute_error"] = max(s["max_absolute_R_T_order_error"] for s in case["samples"])
        records.append(case)
        print(f"{project.name}: max |delta R,T,orders| = {case['max_absolute_error']:.3g}", file=sys.stderr)
    report = {
        "schema_version": "1.1",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "passed" if max(errors) <= TOLERANCE else "failed",
        "claim_scope": "Agreement of two independent implementations at matched finite Fourier bases; not a proof of basis convergence or measured CD accuracy",
        "absolute_tolerance": TOLERANCE,
        "max_absolute_error": max(errors),
        "case_count": len(records),
        "polarization_wavelength_sample_count": len(errors),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "versions": {package: version(package) for package in ("meent", "numpy", "scipy")},
        "solver_sha256": digest(ROOT / "backend/rcwa_core/solver.py"),
        "schema_sha256": digest(ROOT / "backend/rcwa_core/schemas.py"),
        "reference_script_sha256": digest(__file__),
        "S4": provenance,
        "elapsed_seconds": perf_counter() - started,
        "cases": records,
        "harmonic_refinement": refinement_evidence(records),
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(f"Saved {args.output}", file=sys.stderr)
    print(
        json.dumps(
            {
                k: report[k]
                for k in (
                    "status",
                    "case_count",
                    "polarization_wavelength_sample_count",
                    "max_absolute_error",
                    "absolute_tolerance",
                )
            },
            indent=2,
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
