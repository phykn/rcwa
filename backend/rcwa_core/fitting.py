"""Bounded, deterministic CD-only synthetic recovery using the real forward model."""

from __future__ import annotations

from time import perf_counter

import numpy as np
from scipy.optimize import least_squares

from .schemas import FitRequest, Project
from .solver import SolverError, forward


def _observable(result: dict) -> np.ndarray:
    """Equal-weight dimensionless specular R/T for the requested polarizations."""
    return np.concatenate(
        [np.asarray(series[key]) for series in result["spectra"].values() for key in ("R_specular", "T_specular")]
    )


def fit_cd(project: Project, fit: dict) -> dict:
    """Fit a generated synthetic target, with every other input held fixed.

    This deliberately exposes the target CD: it is a recovery demonstration,
    not a measured-data importer, uncertainty estimator, or uniqueness claim.
    """
    request = FitRequest(project=project, **fit)
    project = Project.model_validate(request.project.model_dump())
    started = perf_counter()
    target_project = project.model_copy(deep=True)
    target_project.layers[0].cd_nm = request.target_cd_nm
    target = forward(target_project)
    target_vector = _observable(target)
    lower, upper = request.lower_cd_nm, request.upper_cd_nm
    width = upper - lower
    evaluation_count = 0
    cache: dict[float, np.ndarray] = {}

    def evaluate(cd: float) -> np.ndarray:
        nonlocal evaluation_count
        key = float(cd)
        if key not in cache:
            candidate = project.model_copy(deep=True)
            candidate.layers[0].cd_nm = key
            cache[key] = _observable(forward(candidate))
            evaluation_count += 1
        return cache[key]

    # A flat optical response cannot contain dimensional information.
    probes = [evaluate(lower + fraction * width) for fraction in (0.1, 0.5, 0.9)]
    if max(np.max(abs(probe - probes[0])) for probe in probes[1:]) < 1e-8:
        raise SolverError("CD has negligible optical sensitivity for this sample; synthetic recovery is not meaningful")

    starts = sorted(
        set(
            [
                float(np.clip(project.layers[0].cd_nm, lower + 0.01 * width, upper - 0.01 * width)),
                lower + 0.2 * width,
                lower + 0.8 * width,
            ]
        )
    )
    solutions = []
    for initial in starts:
        solution = least_squares(
            lambda x: evaluate(float(x[0])) - target_vector,
            x0=[initial],
            bounds=([lower], [upper]),
            diff_step=1e-4,
            max_nfev=40,
            ftol=1e-10,
            xtol=1e-9,
            gtol=1e-10,
        )
        solutions.append(
            {
                "initial_cd_nm": initial,
                "fit_cd_nm": float(solution.x[0]),
                "rmse": float(np.sqrt(np.mean(solution.fun**2))),
                "optimizer_success": bool(solution.success),
                "message": str(solution.message),
                "nfev": int(solution.nfev),
            }
        )
    best = min(solutions, key=lambda solution: solution["rmse"])
    fitted_project = project.model_copy(deep=True)
    fitted_project.layers[0].cd_nm = best["fit_cd_nm"]
    prediction = forward(fitted_project)
    residual = _observable(prediction) - target_vector

    # One refinement is a useful warning, not a convergence certificate.
    refined_project = fitted_project.model_copy(deep=True)
    refined_project.solver.harmonics += 4
    refined = forward(refined_project)
    refinement_delta = float(np.max(abs(_observable(refined) - _observable(prediction))))
    good_solutions = [item for item in solutions if item["rmse"] < 1e-6]
    spread = max((abs(item["fit_cd_nm"] - best["fit_cd_nm"]) for item in good_solutions), default=0.0)
    warnings = [
        "Synthetic target and fit use the same engine, material model, and harmonic setting; this is an inverse-crime demonstration.",
        "Only CD is fitted. No experimental accuracy, global uniqueness, confidence interval, or model adequacy is established.",
    ]
    if refinement_delta > 1e-3:
        warnings.append(
            "Specular powers change by more than 0.001 under harmonic refinement; increase the basis before interpreting a fit."
        )
    if spread > 0.01:
        warnings.append("Different starts produced distinct CDs with small residuals; this example is ambiguous.")
    recovered = best["rmse"] < 1e-6 and abs(best["fit_cd_nm"] - request.target_cd_nm) < 0.01
    return {
        "status": "converged" if recovered else "not_converged",
        "fit_cd_nm": best["fit_cd_nm"],
        "target_cd_nm": request.target_cd_nm,
        "rmse": best["rmse"],
        "nfev": evaluation_count,
        "fitted_project": fitted_project.model_dump(mode="json"),
        "prediction": prediction,
        "target": target,
        "diagnostics": {
            "observable": "Equally weighted specular R and T for each requested polarization and wavelength",
            "residuals": residual.tolist(),
            "starts": solutions,
            "refined_harmonics": refined_project.solver.harmonics,
            "max_refinement_power_delta": refinement_delta,
            "multi_start_cd_spread_nm": spread,
            "elapsed_seconds": perf_counter() - started,
        },
        "warnings": warnings,
    }
