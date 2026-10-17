"""Fit selected dimensions of a 1.2 design to a measured R or T spectrum.

Bounded least squares over the real forward model, from several starts. The
reported uncertainty is the linearized (Jacobian) estimate for the residual
scale and says nothing about model error or uniqueness.
"""

from __future__ import annotations

from time import perf_counter

import numpy as np
from pydantic import Field, model_validator
from scipy.optimize import least_squares

from .preflight import SolverError
from .schemas import StrictModel
from .schemas_2d import Project2D
from .solver_2d import assemble_forward_2d, solve_wavelengths_2d

MAX_EVALUATIONS = 80
PathItem = str | int


class FitParameter(StrictModel):
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
    data = {**base, "layers": [dict(layer) for layer in base["layers"]]}
    for parameter, value in zip(spec.parameters, x):
        for path in [parameter.path, *parameter.linked]:
            parent, key = _get(data, path)
            parent[key] = float(value)
    return data


def _observable(result: dict, spec: FitSpec) -> np.ndarray:
    spectra = result["spectra"]
    if spec.polarization == "avg":
        series = [np.asarray(s[spec.quantity]) for s in spectra.values()]
        return np.mean(series, axis=0)
    if spec.polarization not in spectra:
        raise ValueError(f"The design does not calculate {spec.polarization} polarization")
    return np.asarray(spectra[spec.polarization][spec.quantity])


def fit_2d(project: Project2D, spec: dict) -> dict:
    spec = FitSpec.model_validate(spec)
    project = Project2D.model_validate(project.model_dump())
    base = project.model_dump()
    base["illumination"] = {**base["illumination"], "wavelengths_nm": list(spec.wavelengths_nm)}
    target = np.asarray(spec.values)
    lower = np.array([p.lower for p in spec.parameters])
    upper = np.array([p.upper for p in spec.parameters])
    for parameter in spec.parameters:
        parent, key = _get(base, parameter.path)
        if not isinstance(parent.get(key) if isinstance(parent, dict) else parent[key], (int, float)):
            raise ValueError(f"{'.'.join(map(str, parameter.path))} is not a numeric input")
    started = perf_counter()
    evaluations = 0
    history: list[dict] = []

    def model(x) -> np.ndarray:
        nonlocal evaluations
        evaluations += 1
        if evaluations > MAX_EVALUATIONS:
            raise SolverError("The fit did not settle within its evaluation budget")
        candidate = Project2D.model_validate(_apply(base, spec, x))
        n = len(candidate.illumination.wavelengths_nm)
        result = assemble_forward_2d(candidate, solve_wavelengths_2d(candidate, range(n)), elapsed_seconds=0.0)
        return _observable(result, spec)

    def residual(x):
        r = model(x) - target
        history.append({"x": [float(v) for v in x], "rms": float(np.sqrt(np.mean(r**2)))})
        return r

    width = upper - lower
    current = np.array([_get(base, p.path)[0][_get(base, p.path)[1]] for p in spec.parameters], dtype=float)
    starts = [np.clip(current, lower + 0.01 * width, upper - 0.01 * width)]
    if len(spec.parameters) == 1:
        starts += [lower + 0.25 * width, lower + 0.75 * width]
    best = None
    for start in starts:
        try:
            fit = least_squares(residual, start, bounds=(lower, upper), x_scale=width, diff_step=1e-3,
                                xtol=1e-6, ftol=1e-9, max_nfev=25)
        except SolverError:
            if best is None:
                raise
            break
        if best is None or fit.cost < best.cost:
            best = fit
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
        "note": "Linearized 1σ from the residual scale; model error and non-unique fits are not assessed.",
    }
