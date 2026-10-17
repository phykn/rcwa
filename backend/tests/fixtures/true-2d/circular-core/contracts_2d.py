"""2D result validation and exact input/basis binding.

Public subclasses enforce normal-job limits; offline refinements and Laurent
diagnostics remain available only to explicit numerical reference helpers.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .contracts import OrderPower, ResultModel, _close
from .preflight import refractive_index
from .preflight_2d import stack_has_loss_2d, wavevectors
from .solver_2d import ADAPTER_VERSION_2D, input_hash_2d


class OrderPower2D(OrderPower):
    n: int = Field(ge=-15, le=15)
    ky_over_k0: float
    R_s: float = Field(ge=-1e-8)
    R_p: float = Field(ge=-1e-8)
    T_s: float = Field(ge=-1e-8)
    T_p: float = Field(ge=-1e-8)

    @model_validator(mode="after")
    def validate_channels(self):
        _close(self.R, self.R_s + self.R_p, "Reflected polarization sum")
        _close(self.T, self.T_s + self.T_p, "Transmitted polarization sum")
        return self


class Spectrum2D(ResultModel):
    R: list[float]
    T: list[float]
    R_specular: list[float]
    T_specular: list[float]
    A_balance: list[float]
    orders: list[list[OrderPower2D]]


class Metadata2D(ResultModel):
    stage: Literal["bounded_forward"]
    engine: Literal["meent"]
    version: Literal["0.13.2"]
    adapter_version: Literal["1.2.0", "1.3.0"]
    precision: Literal["complex128"]
    backend: Literal["numpy"]
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    harmonics_x: int = Field(ge=0, le=15)
    harmonics_y: int = Field(ge=0, le=15)
    basis_size: int = Field(ge=1, le=961)
    retained_orders: list[list[int]]
    offline_reference_override: bool
    factorization: Literal["directional_inverse_rule", "diagnostic_laurent"]
    layer_count: int = Field(ge=1, le=8)
    active_slab_count: int = Field(ge=0, le=8)
    total_thickness_nm: float = Field(ge=0, le=16000)
    stack_order: Literal["top_to_bottom"]
    units: Literal["nm; vacuum wavelength"]
    geometry: str
    polarization_convention: str
    port_adapter: str
    power_normalization: str
    material_interpolation: str
    convergence_checked: Literal[False]
    max_lossless_flux_error: float | None = Field(ge=0, le=1e-6)
    regularization: str
    elapsed_seconds: float = Field(ge=0)


class CircleLayerApproximation(ResultModel):
    layer_index: int = Field(ge=0, le=7)
    exact_area_nm2: float = Field(ge=0)
    approximate_area_nm2: float = Field(ge=0)
    symmetric_difference_area_bound_nm2: float = Field(ge=0)


class CircularGeometryMetadata(ResultModel):
    method: Literal["centered_midpoint_strips"]
    strips: int = Field(ge=8, le=512, multiple_of=2)
    offline_spatial_override: bool
    area_bound_is_optical_error_bound: Literal[False]
    layers: list[CircleLayerApproximation] = Field(min_length=1, max_length=8)


class CircularMetadata2D(Metadata2D):
    adapter_version: Literal["1.3.0"]
    circular_geometry: CircularGeometryMetadata


class ForwardResult2D(ResultModel):
    result_type: Literal["forward"]
    schema_version: Literal["1.2"]
    wavelengths_nm: list[float] = Field(min_length=1, max_length=31)
    spectra: dict[Literal["s", "p"], Spectrum2D] = Field(min_length=1, max_length=2)
    metadata: CircularMetadata2D | Metadata2D
    warnings: list[str]

    @model_validator(mode="after")
    def validate_spectra(self):
        count, meta = len(self.wavelengths_nm), self.metadata
        if any(not 200 <= w <= 2500 for w in self.wavelengths_nm) or any(
            a >= b for a, b in zip(self.wavelengths_nm, self.wavelengths_nm[1:])
        ):
            raise ValueError("Wavelengths must be strictly increasing and within the supported range")
        labels = [
            [m, n]
            for n in range(-meta.harmonics_y, meta.harmonics_y + 1)
            for m in range(-meta.harmonics_x, meta.harmonics_x + 1)
        ]
        if meta.retained_orders != labels or meta.basis_size != len(labels):
            raise ValueError("Declared basis must be complete, x fast and y slow")
        for series in self.spectra.values():
            if any(
                len(getattr(series, key)) != count
                for key in ("R", "T", "R_specular", "T_specular", "A_balance", "orders")
            ):
                raise ValueError("Every series must have one entry per wavelength")
            for wi, orders in enumerate(series.orders):
                if [[o.m, o.n] for o in orders] != labels:
                    raise ValueError("Order labels must match the complete declared 2D basis")
                _close(series.R[wi], sum(o.R for o in orders), "Total reflection")
                _close(series.T[wi], sum(o.T for o in orders), "Total transmission")
                zero = orders[len(labels) // 2]
                _close(series.R_specular[wi], zero.R, "Specular reflection")
                _close(series.T_specular[wi], zero.T, "Specular transmission")
                _close(series.A_balance[wi], 1 - series.R[wi] - series.T[wi], "Flux balance")
                if series.A_balance[wi] < -1e-6:
                    raise ValueError("Passive flux tolerance failed")
        return self


class PublicOrderPower2D(OrderPower2D):
    m: int = Field(ge=-5, le=5)
    n: int = Field(ge=-5, le=5)


PublicPowerSeries2D = Annotated[list[float], Field(min_length=1, max_length=31)]


class PublicSpectrum2D(Spectrum2D):
    R: PublicPowerSeries2D
    T: PublicPowerSeries2D
    R_specular: PublicPowerSeries2D
    T_specular: PublicPowerSeries2D
    A_balance: PublicPowerSeries2D
    orders: list[Annotated[list[PublicOrderPower2D], Field(min_length=9, max_length=121)]] = Field(
        min_length=1, max_length=31
    )


class PublicMetadata2D(Metadata2D):
    harmonics_x: int = Field(ge=1, le=5)
    harmonics_y: int = Field(ge=1, le=5)
    basis_size: int = Field(ge=9, le=121)
    retained_orders: list[Annotated[list[int], Field(min_length=2, max_length=2)]] = Field(
        min_length=9, max_length=121
    )
    offline_reference_override: Literal[False]
    factorization: Literal["directional_inverse_rule"]


class PublicCircularGeometryMetadata(CircularGeometryMetadata):
    strips: Literal[64]
    offline_spatial_override: Literal[False]


class PublicCircularMetadata2D(PublicMetadata2D):
    adapter_version: Literal["1.3.0"]
    circular_geometry: PublicCircularGeometryMetadata


class PublicForwardResult2D(ForwardResult2D):
    """Normal jobs cannot expose offline refinements or diagnostic factorization."""

    spectra: dict[Literal["s", "p"], PublicSpectrum2D] = Field(min_length=1, max_length=2)
    metadata: PublicCircularMetadata2D | PublicMetadata2D


def validate_result_2d(
    result, project, *, reference_basis=None, laurent_diagnostic=False, reference_circle_strips=None
):
    parsed = ForwardResult2D.model_validate(result)
    metadata = parsed.metadata
    hx, hy = reference_basis or (project.solver.harmonics_x, project.solver.harmonics_y)
    if (metadata.harmonics_x, metadata.harmonics_y) != (hx, hy):
        raise ValueError("Result basis differs from requested basis")
    if metadata.offline_reference_override != (reference_basis is not None):
        raise ValueError("Offline basis override must be explicit")
    if metadata.input_hash != input_hash_2d(project):
        raise ValueError("2D result input hash mismatch")
    if metadata.factorization != ("diagnostic_laurent" if laurent_diagnostic else "directional_inverse_rule"):
        raise ValueError("Production and diagnostic factorization results must not be exchanged")
    circular = any(layer.geometry == "circular_hole_2d" for layer in project.layers)
    from .circular_geometry import CIRCLE_STRIPS, circle_approximation_metadata, validate_circle_strips

    circle_metadata = getattr(metadata, "circular_geometry", None)
    if circular:
        strips = CIRCLE_STRIPS if reference_circle_strips is None else validate_circle_strips(reference_circle_strips)
        expected = circle_approximation_metadata(project, strips, reference_circle_strips is not None)
        if circle_metadata is None or circle_metadata.model_dump() != expected:
            raise ValueError("Circular geometry approximation differs from requested spatial resolution or input")
        if metadata.adapter_version != ADAPTER_VERSION_2D:
            raise ValueError("Historical adapters did not support circular holes")
    elif circle_metadata is not None or reference_circle_strips is not None:
        raise ValueError("Circular spatial metadata requires circular geometry")
    if metadata.adapter_version not in {"1.2.0", ADAPTER_VERSION_2D} or parsed.wavelengths_nm != project.illumination.wavelengths_nm:
        raise ValueError("Result engine or wavelengths differ from request")
    pols = {"s", "p"} if project.illumination.polarization == "both" else {project.illumination.polarization}
    if set(parsed.spectra) != pols:
        raise ValueError("Result incident polarizations differ from request")
    if metadata.layer_count != len(project.layers) or metadata.active_slab_count != sum(
        layer.thickness_nm > 0 for layer in project.layers
    ):
        raise ValueError("Layer metadata differs from request")
    _close(metadata.total_thickness_nm, sum(layer.thickness_nm for layer in project.layers), "Total thickness")
    any_loss, max_error = False, 0.0
    for wi, wl in enumerate(project.illumination.wavelengths_nm):
        ns, n0 = refractive_index(project.substrate, wl), refractive_index(project.ambient, wl).real
        kx, ky = wavevectors(project, wl, hx, hy)
        has_loss = stack_has_loss_2d(project, wl)
        any_loss |= has_loss
        for spectrum in parsed.spectra.values():
            for order in spectrum.orders[wi]:
                x, y = kx[order.m + hx], ky[order.n + hy]
                _close(order.kx_over_k0, x, "Order kx")
                _close(order.ky_over_k0, y, "Order ky")
                qr, qt = n0**2 - x * x - y * y, ns**2 - x * x - y * y
                if order.reflection_propagating != bool(qr > 0):
                    raise ValueError("Reflection classification differs from input")
                expected = "absorbing_half_space" if ns.imag else ("propagating" if qt.real > 0 else "evanescent")
                if order.transmission_class != expected:
                    raise ValueError("Transmission classification differs from input")
                if qr < 0 and abs(order.R) > 1e-9 or not ns.imag and qt.real < 0 and abs(order.T) > 1e-9:
                    raise ValueError("Evanescent lossless orders cannot carry normal power")
            if not has_loss:
                max_error = max(max_error, abs(spectrum.A_balance[wi]))
                if abs(spectrum.A_balance[wi]) > 1e-6:
                    raise ValueError("Lossless flux tolerance failed")
    if any_loss:
        if metadata.max_lossless_flux_error is not None:
            raise ValueError("Lossy finite stacks must not claim lossless flux validation")
    elif metadata.max_lossless_flux_error is None or not math.isclose(
        metadata.max_lossless_flux_error, max_error, abs_tol=1e-9, rel_tol=1e-9
    ):
        raise ValueError("Lossless flux error metadata is inconsistent")
    return parsed
