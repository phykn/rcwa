"""Fit selected dimensions of a 1.2 design to a measured R or T spectrum.

Bounded least squares over the real forward model, from several starts. The
reported uncertainty is the linearized (Jacobian) estimate for the residual
scale and says nothing about model error or uniqueness.
"""

from __future__ import annotations

from copy import deepcopy
from itertools import product
from time import perf_counter

import numpy as np
from pydantic import ConfigDict, Field, ValidationError, model_validator
from scipy.optimize import least_squares

from .preflight import SolverError
from .preflight_2d import preflight_2d
from .schemas import StrictModel
from .schemas_2d import Project2D
from .solver_2d import forward_2d

MAX_EVALUATIONS = 80
PathItem = str | int


class FitParameter(StrictModel):
    # Strict like the legacy fit options: "40" or a JSON true in a path is rejected, not coerced.
    model_config = ConfigDict(strict=True)

    path: list[PathItem] = Field(min_length=1, max_length=4)
    lower: float
    upper: float
    #: Other paths that always take the same value (e.g. a square lattice's y pitch).
    linked: list[list[PathItem]] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def ordered(self):
        if not self.lower < self.upper:
            raise ValueError("Each fit parameter needs lower < upper")
        return self


class FitSpec(StrictModel):
    model_config = ConfigDict(strict=True)

    parameters: list[FitParameter] = Field(min_length=1, max_length=3)
    wavelengths_nm: list[float] = Field(min_length=3, max_length=31)
    values: list[float] = Field(min_length=3, max_length=31)
    quantity: str = Field(pattern="^(R|T|R_specular|T_specular)$")
    polarization: str = Field(pattern="^(s|p|avg)$")

    @model_validator(mode="after")
    def matched(self):
        if len(self.values) != len(self.wavelengths_nm):
            raise ValueError("Measured values and wavelengths must have the same length")
        if any(not -0.05 <= v <= 1.05 for v in self.values):
            raise ValueError("Measured values must be fractions between 0 and 1")
        return self


class DimensionFitResult(StrictModel):
    result_type: str = Field(pattern="^dimension_fit$")
    schema_version: str = Field(pattern="^1\\.2$")
    values: list[float] = Field(min_length=1, max_length=3)
    sigma: list[float | None] = Field(min_length=1, max_length=3)
    at_bound: list[bool] = Field(min_length=1, max_length=3)
    rms: float = Field(ge=0)
    wavelengths_nm: list[float] = Field(min_length=3, max_length=31)
    fitted: list[float] = Field(min_length=3, max_length=31)
    evaluations: int = Field(ge=1, le=MAX_EVALUATIONS)
    history: list[dict] = Field(max_length=60)
    elapsed_seconds: float = Field(ge=0)
    note: str
    #: Forward warnings for the reported design, so a fit cannot hide them.
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def consistent(self):
        n = len(self.values)
        if len(self.sigma) != n or len(self.at_bound) != n or len(self.fitted) != len(self.wavelengths_nm):
            raise ValueError("Dimension fit result arrays disagree")
        return self


def validate_fit_result(result: dict, spec: dict) -> DimensionFitResult:
    """Bind a returned fit to the request that produced it."""
    spec = FitSpec.model_validate(spec)
    fit = DimensionFitResult.model_validate(result)
    if len(fit.values) != len(spec.parameters) or fit.wavelengths_nm != list(spec.wavelengths_nm):
        raise ValueError("Dimension fit result does not match its request")
    for value, parameter in zip(fit.values, spec.parameters):
        if not parameter.lower <= value <= parameter.upper:
            raise ValueError("Fitted value outside its bounds")
    return fit


def _get(data, path):
    for key in path[:-1]:
        data = data[key]
    return data, path[-1]


def _apply(base: dict, spec: FitSpec, x) -> dict:
    data = deepcopy(base)
    for parameter, value in zip(spec.parameters, x):
        for path in [parameter.path, *parameter.linked]:
            parent, key = _get(data, path)
            parent[key] = float(value)
    return data


def _observable(result: dict, spec: FitSpec) -> np.ndarray:
    spectra = result["spectra"]
    if spec.polarization == "avg":
        return (np.asarray(spectra["s"][spec.quantity]) + np.asarray(spectra["p"][spec.quantity])) / 2
    return np.asarray(spectra[spec.polarization][spec.quantity])


def _fit_base(project: Project2D, spec: FitSpec) -> dict:
    """The design the fit perturbs, checked against the spec before any solve.

    Every path, linked or not, must name an existing real-valued input outside the
    solver settings, and the measured wavelengths must form a valid design.
    """
    base = project.model_dump()
    # Solve exactly the polarizations the measurement needs, whatever the design shows.
    base["illumination"] = {
        **base["illumination"],
        "wavelengths_nm": list(spec.wavelengths_nm),
        "polarization": "both" if spec.polarization == "avg" else spec.polarization,
    }
    seen = set()
    for parameter in spec.parameters:
        for path in [parameter.path, *parameter.linked]:
            name = ".".join(map(str, path))
            if tuple(path) in seen:
                raise ValueError(f"Fit path {name} appears more than once; each input takes one value")
            seen.add(tuple(path))
            try:
                parent, key = _get(base, path)
                value = parent[key]
            except (KeyError, IndexError, TypeError):
                raise ValueError(f"Fit path {name} does not name an input of this design") from None
            if any(type(item) is int and item < 0 for item in path):
                raise ValueError(f"Fit path {name} does not name an input of this design")
            # A tabulated material's scalar n/k are display values the solver never reads.
            ignored = isinstance(parent, dict) and parent.get("kind") == "tabulated" and key in ("n", "k")
            # A list entry is a sample (a measured wavelength, a table row), not a design input.
            if path[0] == "solver" or isinstance(parent, list) or type(value) is not float or ignored:
                raise ValueError(f"Fit path {name} is not a real-valued design input")
    try:
        Project2D.model_validate(base)
    except ValidationError as exc:
        reason = exc.errors()[0]["msg"].removeprefix("Value error, ")
        raise ValueError(f"The measured wavelengths do not form a valid design: {reason}") from None
    _check_bounds(base, spec)
    return base


def check_fit_2d(project: Project2D, spec: dict) -> None:
    """Admission check: a bad fit request fails here, before a worker is allocated."""
    _fit_base(Project2D.model_validate(project.model_dump()), FitSpec.model_validate(spec))


def _check_bounds(base: dict, spec: FitSpec) -> None:
    """Reject bounds whose corners are invalid or unsolvable, before any solve.

    Geometry limits (widths within periods, a hole within both periods) are convex
    in the fitted values, so valid corners make the whole box valid. Open-order
    coverage is not monotone (an oblique, rotated beam can open an order only
    mid-range), so the corner preflight is an early check, not a guarantee.
    """
    for corner in product(*[(p.lower, p.upper) for p in spec.parameters]):
        where = ", ".join(f"{'.'.join(map(str, p.path))}={v:g}" for p, v in zip(spec.parameters, corner))
        try:
            candidate = Project2D.model_validate(_apply(base, spec, corner))
        except ValidationError as exc:
            reason = exc.errors()[0]["msg"].removeprefix("Value error, ")
            raise SolverError(f"Fit bounds include an invalid design ({where}): {reason}. Narrow the bounds.") from None
        errors = [d.message for d in preflight_2d(candidate) if d.severity == "error"]
        if errors:
            raise SolverError(f"Fit bounds include a design that cannot be solved ({where}): {errors[0]}")


def fit_2d(project: Project2D, spec: dict) -> dict:
    spec = FitSpec.model_validate(spec)
    project = Project2D.model_validate(project.model_dump())
    base = _fit_base(project, spec)
    target = np.asarray(spec.values)
    lower = np.array([p.lower for p in spec.parameters])
    upper = np.array([p.upper for p in spec.parameters])
    started = perf_counter()
    evaluations = 0
    history: list[dict] = []
    solved: dict[tuple, np.ndarray] = {}
    warned: dict[tuple, list[str]] = {}

    def model(x) -> np.ndarray:
        nonlocal evaluations
        key = tuple(float(v) for v in x)
        if key in solved:
            return solved[key]
        evaluations += 1
        if evaluations > MAX_EVALUATIONS:
            raise SolverError("The fit did not settle within its evaluation budget")
        result = forward_2d(Project2D.model_validate(_apply(base, spec, x)))
        solved[key] = _observable(result, spec)
        warned[key] = list(result["warnings"])
        return solved[key]

    def residual(x):
        r = model(x) - target
        history.append({"x": [float(v) for v in x], "rms": float(np.sqrt(np.mean(r**2)))})
        return r

    width = upper - lower
    current = np.array([_get(base, p.path)[0][_get(base, p.path)[1]] for p in spec.parameters], dtype=float)
    starts = [np.clip(current, lower + 0.01 * width, upper - 0.01 * width)]
    if len(spec.parameters) == 1:
        starts += [lower + 0.25 * width, lower + 0.75 * width]
    best, failure = None, None
    # Each iteration costs one model call plus one per parameter for the Jacobian,
    # so this cap keeps every start, and the whole fit, inside the budget.
    per_call = len(spec.parameters) + 1
    for start in starts:
        calls = min(25, (MAX_EVALUATIONS - evaluations) // per_call)
        if calls < 2:
            break
        try:
            fit = least_squares(residual, start, bounds=(lower, upper), x_scale=width, diff_step=1e-3,
                                xtol=1e-6, ftol=1e-9, max_nfev=calls)
        except SolverError as exc:
            # A probe inside the bounds can still be unsolvable; other starts may avoid it.
            failure = exc
            continue
        if best is None or fit.cost < best.cost:
            best = fit
    if best is None:
        raise failure or SolverError("The fit did not settle within its evaluation budget")
    rms = float(np.sqrt(2 * best.cost / len(target)))
    try:
        dof = max(1, len(target) - len(spec.parameters))
        covariance = np.linalg.inv(best.jac.T @ best.jac) * (2 * best.cost / dof)
        sigma = [float(v) for v in np.sqrt(np.clip(np.diag(covariance), 0, None))]
    except np.linalg.LinAlgError:
        sigma = [None] * len(spec.parameters)
    fitted = model(best.x)
    return {
        "result_type": "dimension_fit",
        "schema_version": "1.2",
        "values": [float(v) for v in best.x],
        "sigma": sigma,
        "at_bound": [bool(np.isclose(v, lo) or np.isclose(v, hi)) for v, lo, hi in zip(best.x, lower, upper)],
        "rms": rms,
        "wavelengths_nm": list(spec.wavelengths_nm),
        "fitted": [float(v) for v in fitted],
        "evaluations": evaluations,
        "history": history[-60:],
        "elapsed_seconds": perf_counter() - started,
        "note": "Linearized 1σ from the residual scale; model error and non-unique fits are not assessed."
        + (" The best start stopped at its evaluation cap before converging." if best.status == 0 else ""),
        "warnings": warned[tuple(float(v) for v in best.x)],
    }
