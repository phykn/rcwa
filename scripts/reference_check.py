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
from rcwa_core.schemas import Material, Project  # noqa: E402
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
static void ok(int r, const char* name){if(r!=0){fprintf(stderr,"S4 %s returned %d\n",name,r); exit(2);}}
static int mat(S4_Simulation*S,const char*name,double n,double k){double e[2]={n*n-k*k,2*n*k};int m=S4_Simulation_SetMaterial(S,-1,name,S4_MATERIAL_TYPE_SCALAR_COMPLEX,e);if(m<0) exit(2);return m;}
int main(int argc,char**argv){
 if(argc!=14){fprintf(stderr,"usage: driver pitch cd height wavelength angle H ambient_n substrate_n ridge_n ridge_k background_n background_k substrate_k\n");return 2;}
 double pitch=atof(argv[1]),cd=atof(argv[2]),height=atof(argv[3]),wl=atof(argv[4]),angle=atof(argv[5])*acos(-1)/180;
 int H=atoi(argv[6]),N=2*H+1;
 std::vector<int> G(2*N,0);int gi=1;for(int m=-H;m<=H;++m){if(m){G[2*gi++]=m;}}
 for(int pol=0;pol<2;++pol){
 double lattice[4]={pitch,0,0,0};auto S=S4_Simulation_New(lattice,N,G.data());
 int a=mat(S,"ambient",atof(argv[7]),0),b=mat(S,"substrate",atof(argv[8]),atof(argv[13])),r=mat(S,"ridge",atof(argv[9]),atof(argv[10])),bg=mat(S,"background",atof(argv[11]),atof(argv[12]));
 double zero=0;int top=S4_Simulation_SetLayer(S,-1,"top",&zero,-1,a);int film=S4_Simulation_SetLayer(S,-1,"film",&height,-1,cd==pitch?r:bg);int bot=S4_Simulation_SetLayer(S,-1,"bottom",&zero,-1,b);
 if(top<0||film<0||bot<0)return 2;
 if(cd>0&&cd<pitch){double hw[2]={cd/2,0},center[2]={pitch/2,0};ok(S4_Layer_SetRegionHalfwidths(S,film,r,S4_REGION_TYPE_INTERVAL,hw,center,&zero),"region");}
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
    layer = project.layers[0]
    ambient, substrate, ridge, background = [
        optical_index(m, wavelength) for m in (project.ambient, project.substrate, layer.material, layer.background)
    ]
    args = [
        project.period_nm,
        layer.cd_nm,
        layer.thickness_nm,
        wavelength,
        project.illumination.angle_deg,
        project.solver.harmonics,
        ambient.real,
        substrate.real,
        ridge.real,
        ridge.imag,
        background.real,
        background.imag,
        substrate.imag,
    ]
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
        "schema_version": "1.0",
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
