"""Strict public result contracts and input/result binding at worker boundaries.

Validating these contracts establishes shape and internal consistency. It does
not independently verify a spectrum, convergence, or real-world accuracy.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .preflight import ADAPTER_VERSION, REQUIRED_ENGINE_VERSION, refractive_index, stack_has_loss
from .schemas import FitRequest, Layer, Project

RESULT_SCHEMA_VERSION = "1.1"


class ResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class OrderPower(ResultModel):
    m: int = Field(ge=-20, le=20)
    R: float
    T: float
    kx_over_k0: float
    reflection_propagating: bool
    transmission_propagating: bool | None
    transmission_class: Literal["absorbing_half_space", "propagating", "evanescent"]

    @model_validator(mode="after")
    def validate_classification(self):
        expected = {
            "absorbing_half_space": None,
            "propagating": True,
            "evanescent": False,
        }[self.transmission_class]
        if self.transmission_propagating is not expected:
            raise ValueError("Transmission classification and propagating flag disagree")
        if min(self.R, self.T) < -1e-8:
            raise ValueError("Order powers violate the passive-power tolerance")
        return self


PowerSeries = Annotated[list[float], Field(min_length=1, max_length=81)]
OrderList = Annotated[list[OrderPower], Field(min_length=3, max_length=41)]


class PolarizationSpectrum(ResultModel):
    R: PowerSeries
    T: PowerSeries
    R_specular: PowerSeries
    T_specular: PowerSeries
    A_balance: PowerSeries
    orders: list[OrderList] = Field(min_length=1, max_length=81)


class ForwardMetadata1_0(ResultModel):
    engine: Literal["meent"]
    version: Literal["0.13.2"]
    adapter_version: Literal["1.0.0"]
    backend: Literal["numpy"]
    precision: Literal["complex128"]
    method: str
    harmonics: int = Field(ge=1, le=20)
    retained_orders: list[int] = Field(min_length=3, max_length=41)
    basis_size: int = Field(ge=3, le=41)
    geometry: str
    units: Literal["nm; vacuum wavelength"]
    angle_convention: str
    material_convention: str
    port_adapter: str
    polarization_convention: str
    power_normalization: str
    material_interpolation: str
    substrate_backside: Literal["omitted; substrate is semi-infinite"]
    max_lossless_flux_error: float | None = Field(ge=0)
    convergence_checked: bool
    elapsed_seconds: float = Field(ge=0)
    regularization: str

    @model_validator(mode="after")
    def validate_basis(self):
        if self.retained_orders != list(range(-self.harmonics, self.harmonics + 1)):
            raise ValueError("Retained orders must match the complete symmetric harmonic basis")
        if self.basis_size != len(self.retained_orders):
            raise ValueError("Basis size must match retained orders")
        if self.convergence_checked:
            raise ValueError("A single forward result must not claim convergence certification")
        return self


class ForwardMetadata(ForwardMetadata1_0):
    """Current stack metadata; historical metadata remains a separate reader."""

    adapter_version: Literal["1.1.0"]
    layer_count: int = Field(ge=1, le=8)
    active_slab_count: int = Field(ge=0, le=8)
    total_thickness_nm: float = Field(ge=0, le=16000)
    stack_order: Literal["top_to_bottom"]

    @model_validator(mode="after")
    def validate_stack(self):
        if self.active_slab_count > self.layer_count:
            raise ValueError("Active slab count cannot exceed physical layer count")
        if (self.active_slab_count == 0) != (self.total_thickness_nm == 0):
            raise ValueError("Zero active slabs must correspond to zero total thickness")
        return self


def _close(actual: float, expected: float, label: str, *, tolerance: float = 1e-9) -> None:
    if not math.isclose(actual, expected, rel_tol=tolerance, abs_tol=tolerance):
        raise ValueError(f"{label} is inconsistent")


class ForwardResult1_0(ResultModel):
    result_type: Literal["forward"]
    schema_version: Literal["1.0"]
    wavelengths_nm: list[float] = Field(min_length=1, max_length=81)
    spectra: dict[Literal["s", "p"], PolarizationSpectrum] = Field(min_length=1, max_length=2)
    metadata: ForwardMetadata1_0
    warnings: list[str]

    @model_validator(mode="after")
    def validate_spectra(self):
        wavelengths = self.wavelengths_nm
        if any(not 200 <= w <= 2500 for w in wavelengths):
            raise ValueError("Result wavelengths must be within the supported range")
        if any(a >= b for a, b in zip(wavelengths, wavelengths[1:])):
            raise ValueError("Result wavelengths must be strictly increasing")
        count = len(wavelengths)
        for series in self.spectra.values():
            for key in ("R", "T", "R_specular", "T_specular", "A_balance", "orders"):
                if len(getattr(series, key)) != count:
                    raise ValueError(f"{key} must have exactly one entry per wavelength")
            for wi, orders in enumerate(series.orders):
                if [order.m for order in orders] != self.metadata.retained_orders:
                    raise ValueError("Each wavelength must contain exactly the declared retained orders")
                _close(series.R[wi], sum(order.R for order in orders), "Total reflection")
                _close(series.T[wi], sum(order.T for order in orders), "Total transmission")
                zero = orders[self.metadata.harmonics]
                _close(series.R_specular[wi], zero.R, "Specular reflection")
                _close(series.T_specular[wi], zero.T, "Specular transmission")
                _close(series.A_balance[wi], 1 - series.R[wi] - series.T[wi], "Flux balance")
                if series.A_balance[wi] < -1e-6:
                    raise ValueError("Result violates the passive flux-balance tolerance")
        return self


class ForwardResult(ForwardResult1_0):
    """Only current worker output is accepted at the compute boundary."""

    schema_version: Literal["1.1"]
    metadata: ForwardMetadata


StoredForwardResult = Annotated[ForwardResult1_0 | ForwardResult, Field(discriminator="schema_version")]


class FitStart(ResultModel):
    initial_cd_nm: float = Field(gt=0)
    fit_cd_nm: float = Field(gt=0)
    rmse: float = Field(ge=0)
    optimizer_success: bool
    message: str
    nfev: int = Field(ge=1, le=40)


class FitDiagnostics(ResultModel):
    observable: str
    residuals: list[float] = Field(min_length=10, max_length=164)
    starts: list[FitStart] = Field(min_length=1, max_length=3)
    refined_harmonics: int = Field(ge=5, le=16)
    max_refinement_power_delta: float = Field(ge=0)
    multi_start_cd_spread_nm: float = Field(ge=0)
    elapsed_seconds: float = Field(ge=0)


class SyntheticFitResult(ResultModel):
    result_type: Literal["synthetic_fit"]
    status: Literal["converged", "not_converged"]
    fit_cd_nm: float = Field(gt=0)
    target_cd_nm: float = Field(gt=0)
    rmse: float = Field(ge=0)
    nfev: int = Field(ge=1)
    fitted_project: Project
    prediction: ForwardResult
    target: ForwardResult
    diagnostics: FitDiagnostics
    warnings: list[str]

    @model_validator(mode="after")
    def validate_fit_consistency(self):
        if len(self.fitted_project.layers) != 1 or not isinstance(self.fitted_project.layers[0], Layer):
            raise ValueError("Synthetic CD fitting requires exactly one rectangular layer")
        if self.fitted_project.layers[0].cd_nm != self.fit_cd_nm:
            raise ValueError("Fitted project CD must match fit_cd_nm")
        _bind_forward(self.prediction, self.fitted_project)
        target_project = self.fitted_project.model_copy(deep=True)
        target_project.layers[0].cd_nm = self.target_cd_nm
        # Revalidation rejects target CDs outside the project period.
        target_project = Project.model_validate(target_project.model_dump())
        _bind_forward(self.target, target_project)
        if self.diagnostics.refined_harmonics != self.fitted_project.solver.harmonics + 4:
            raise ValueError("Synthetic refinement must add four harmonics")
        residuals = _observables(self.prediction) - _observables(self.target)
        if len(self.diagnostics.residuals) != len(residuals):
            raise ValueError("Residual count must match the selected specular observables")
        for actual, expected in zip(self.diagnostics.residuals, residuals):
            _close(actual, float(expected), "Synthetic-fit residual")
        _close(self.rmse, float(np.sqrt(np.mean(residuals**2))), "Synthetic-fit RMSE")
        best = min(self.diagnostics.starts, key=lambda item: item.rmse)
        _close(self.rmse, best.rmse, "Best-start RMSE")
        _close(self.fit_cd_nm, best.fit_cd_nm, "Best-start CD")
        good = [item for item in self.diagnostics.starts if item.rmse < 1e-6]
        spread = max((abs(item.fit_cd_nm - self.fit_cd_nm) for item in good), default=0.0)
        _close(self.diagnostics.multi_start_cd_spread_nm, spread, "Multistart spread")
        recovered = self.rmse < 1e-6 and abs(self.fit_cd_nm - self.target_cd_nm) < 0.01
        if (self.status == "converged") != recovered:
            raise ValueError("Synthetic recovery status disagrees with the recovery criteria")
        return self


Result = Annotated[ForwardResult | SyntheticFitResult, Field(discriminator="result_type")]


def _observables(result: ForwardResult) -> np.ndarray:
    # The solver's insertion order is s, p for dual polarization. Use that
    # canonical order regardless of JSON object ordering at the boundary.
    return np.concatenate(
        [
            np.asarray(getattr(result.spectra[pol], key))
            for pol in ("s", "p")
            if pol in result.spectra
            for key in ("R_specular", "T_specular")
        ]
    )


def _bind_forward(result: ForwardResult, project: Project) -> None:
    """Check result fields that are determined exactly by the accepted input."""
    if result.wavelengths_nm != project.illumination.wavelengths_nm:
        raise ValueError("Result wavelengths do not match the submitted project")
    polarizations = {"s", "p"} if project.illumination.polarization == "both" else {project.illumination.polarization}
    if set(result.spectra) != polarizations:
        raise ValueError("Result polarizations do not match the submitted project")
    if result.metadata.harmonics != project.solver.harmonics:
        raise ValueError("Result harmonic basis does not match the submitted project")
    if result.metadata.version != REQUIRED_ENGINE_VERSION or result.metadata.adapter_version != ADAPTER_VERSION:
        raise ValueError("Result engine or adapter version is unsupported")
    if result.metadata.layer_count != len(project.layers):
        raise ValueError("Result layer count does not match the submitted project")
    if result.metadata.active_slab_count != sum(layer.thickness_nm > 0 for layer in project.layers):
        raise ValueError("Result active slab count does not match the submitted project")
    if result.metadata.total_thickness_nm != sum(layer.thickness_nm for layer in project.layers):
        raise ValueError("Result total thickness does not match the submitted project")
    angle = np.deg2rad(project.illumination.angle_deg)
    any_layer_loss = False
    max_lossless_balance = 0.0
    for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
        n0 = refractive_index(project.ambient, wavelength)
        ns = refractive_index(project.substrate, wavelength)
        wavelength_has_loss = stack_has_loss(project, wavelength)
        any_layer_loss |= wavelength_has_loss
        for series in result.spectra.values():
            for order in series.orders[wi]:
                kx = n0.real * np.sin(angle) + order.m * wavelength / project.period_nm
                _close(order.kx_over_k0, float(kx), "Order transverse wavevector")
                if order.reflection_propagating != bool(n0.real**2 - kx**2 > 0):
                    raise ValueError("Reflection order classification does not match the submitted project")
                expected_class = (
                    "absorbing_half_space"
                    if ns.imag != 0
                    else ("propagating" if (ns**2 - kx**2).real > 0 else "evanescent")
                )
                if order.transmission_class != expected_class:
                    raise ValueError("Transmission order classification does not match the submitted project")
            if not wavelength_has_loss:
                max_lossless_balance = max(max_lossless_balance, abs(series.A_balance[wi]))
                if abs(series.A_balance[wi]) > 1e-6:
                    raise ValueError("Lossless layer flux balance exceeds the solver tolerance")
    if any_layer_loss:
        if result.metadata.max_lossless_flux_error is not None:
            raise ValueError("Lossy finite layers must not report a lossless flux error")
    else:
        if result.metadata.max_lossless_flux_error is None:
            raise ValueError("Lossless finite layers must report the lossless flux error")
        _close(result.metadata.max_lossless_flux_error, max_lossless_balance, "Maximum lossless flux error")


def validate_result(
    kind: Literal["forward", "fit"],
    result: dict | ForwardResult | SyntheticFitResult,
    project: Project | dict,
    fit: dict | FitRequest | None = None,
) -> ForwardResult | SyntheticFitResult:
    """Strictly validate worker output and bind it to the server-owned inputs.

    ``kind`` is the existing job operation (``forward`` or ``fit``); the fit
    result discriminator is deliberately named ``synthetic_fit``. This helper
    never adds missing discriminators or relaxes old imported file formats.
    Callers can serialize the returned model with ``model_dump(mode='json')``.
    """
    project = Project.model_validate(project.model_dump() if isinstance(project, Project) else project)
    if isinstance(result, BaseModel):
        result = result.model_dump(mode="python")
    if kind == "forward":
        if fit is not None:
            raise ValueError("Forward results must not have fit parameters")
        validated = ForwardResult.model_validate(result, strict=True)
        _bind_forward(validated, project)
        return validated
    if kind != "fit":
        raise ValueError("Unsupported result operation")
    if fit is None:
        raise ValueError("Synthetic-fit validation requires the accepted fit parameters")
    if isinstance(fit, FitRequest):
        if fit.project.model_dump() != project.model_dump():
            raise ValueError("Fit parameters contain a different project")
        fit_parameters = fit.model_dump(exclude={"project"})
    else:
        fit_parameters = fit
    request = FitRequest(project=project, **fit_parameters)
    validated = SyntheticFitResult.model_validate(result, strict=True)
    if validated.target_cd_nm != request.target_cd_nm:
        raise ValueError("Synthetic target CD does not match the accepted fit request")
    expected_project = project.model_copy(deep=True)
    expected_project.layers[0].cd_nm = validated.fit_cd_nm
    if validated.fitted_project.model_dump() != expected_project.model_dump():
        raise ValueError("Synthetic fitting may change only CD in the submitted project")
    lower, upper = request.lower_cd_nm, request.upper_cd_nm
    if not lower <= validated.fit_cd_nm <= upper:
        raise ValueError("Recovered CD is outside the accepted fit bounds")
    for start in validated.diagnostics.starts:
        if not lower <= start.initial_cd_nm <= upper or not lower <= start.fit_cd_nm <= upper:
            raise ValueError("A synthetic fit start is outside the accepted bounds")
    width = upper - lower
    expected_starts = sorted(
        set(
            [
                float(np.clip(project.layers[0].cd_nm, lower + 0.01 * width, upper - 0.01 * width)),
                lower + 0.2 * width,
                lower + 0.8 * width,
            ]
        )
    )
    if [start.initial_cd_nm for start in validated.diagnostics.starts] != expected_starts:
        raise ValueError("Synthetic fit starts do not match the accepted experiment")
    return validated
