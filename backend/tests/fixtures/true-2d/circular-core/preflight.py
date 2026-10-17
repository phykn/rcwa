"""Deterministic admissibility checks shared by HTTP validation and the solver.

These checks do not start a worker, import the numerical engine, or certify
Fourier convergence. Eigensolver and flux checks still run during calculation.
"""

from __future__ import annotations

from importlib import metadata, util
from typing import Literal, TYPE_CHECKING

import numpy as np
from pydantic import Field

from .schemas import StrictModel

if TYPE_CHECKING:
    from .schemas import Material, Project

REQUIRED_ENGINE_VERSION = "0.13.2"
ADAPTER_VERSION = "1.1.0"
EXACT_CUTOFF_TOLERANCE = 1e-10
NEAR_CUTOFF_TOLERANCE = 1e-4


class Diagnostic(StrictModel):
    code: str
    severity: Literal["error", "warning", "info"]
    location: list[str | int] = Field(default_factory=list)
    message: str


class EngineInfo(StrictModel):
    engine: Literal["meent"] = "meent"
    installed_version: str | None
    required_version: Literal["0.13.2"] = REQUIRED_ENGINE_VERSION
    adapter_version: Literal["1.1.0"] = ADAPTER_VERSION
    available: bool
    status: Literal["available", "not_installed", "version_mismatch"]
    message: str


class SolverError(ValueError):
    """A numerically invalid or unsupported solve, never a substitute spectrum."""


class PreflightError(SolverError):
    def __init__(self, diagnostics: list[Diagnostic]):
        self.diagnostics = diagnostics
        super().__init__("; ".join(item.message for item in diagnostics if item.severity == "error"))


class EngineUnavailableError(SolverError):
    def __init__(self, engine: EngineInfo):
        self.engine = engine
        self.code = "engine_version_mismatch" if engine.status == "version_mismatch" else "engine_unavailable"
        super().__init__(engine.message)


def engine_info() -> EngineInfo:
    """Inspect distribution and module availability without importing meent."""
    try:
        installed = metadata.version("meent")
    except metadata.PackageNotFoundError:
        installed = None
    try:
        module_exists = util.find_spec("meent") is not None
    except (ImportError, ValueError):
        module_exists = False
    if installed is None or not module_exists:
        return EngineInfo(
            installed_version=installed,
            available=False,
            status="not_installed",
            message="The meent engine is unavailable; install the pinned backend requirements.",
        )
    if installed != REQUIRED_ENGINE_VERSION:
        return EngineInfo(
            installed_version=installed,
            available=False,
            status="version_mismatch",
            message=f"This adapter is verified only with meent=={REQUIRED_ENGINE_VERSION}; found {installed}.",
        )
    return EngineInfo(
        installed_version=installed,
        available=True,
        status="available",
        message="The required meent engine is installed. Availability does not certify numerical success or convergence.",
    )


def ensure_engine_available() -> EngineInfo:
    info = engine_info()
    if not info.available:
        raise EngineUnavailableError(info)
    return info


def refractive_index(material: Material, wavelength_nm: float) -> complex:
    """Linearly interpolate n and k separately, never epsilon or outside a table."""
    if material.kind == "constant":
        return complex(material.n, material.k)
    if not material.wavelengths_nm[0] <= wavelength_nm <= material.wavelengths_nm[-1]:
        raise SolverError(f"{material.name}: material extrapolation is forbidden")
    return complex(
        np.interp(wavelength_nm, material.wavelengths_nm, material.n_values),
        np.interp(wavelength_nm, material.wavelengths_nm, material.k_values),
    )


def active_materials(project: Project):
    """Yield only material regions occupying positive finite-stack volume.

    Coverage validation intentionally still checks every declared material,
    including zero-thickness layers and unused degenerate-rectangle regions.
    """
    for layer in project.layers:
        if layer.thickness_nm == 0:
            continue
        if layer.geometry == "homogeneous":
            yield layer.material
        else:
            if layer.cd_nm > 0:
                yield layer.material
            if layer.cd_nm < project.period_nm:
                yield layer.background


def stack_has_loss(project: Project, wavelength_nm: float) -> bool:
    return any(refractive_index(material, wavelength_nm).imag != 0 for material in active_materials(project))


def material_coverage_diagnostics(project: Project) -> list[Diagnostic]:
    """Also used by Project validation to preserve its coverage guarantee."""
    wavelengths = project.illumination.wavelengths_nm
    diagnostics = []
    materials = [
        (project.ambient, ["ambient"]),
        (project.substrate, ["substrate"]),
    ]
    for i, layer in enumerate(project.layers):
        materials.append((layer.material, ["layers", i, "material"]))
        if layer.geometry == "rectangle_1d":
            materials.append((layer.background, ["layers", i, "background"]))
    for material, location in materials:
        if material.kind == "tabulated" and (
            min(wavelengths) < material.wavelengths_nm[0] or max(wavelengths) > material.wavelengths_nm[-1]
        ):
            diagnostics.append(
                Diagnostic(
                    code="material_coverage",
                    severity="error",
                    location=location + ["wavelengths_nm"],
                    message=f"{material.name}: wavelength outside material table; extrapolation is forbidden",
                )
            )
    return diagnostics


def preflight_project(project: Project) -> list[Diagnostic]:
    """Check a schema-valid Project without solving or allocating a process.

    Project construction validates geometry, finite numbers and table shape.
    This function rechecks coverage, including in-memory Project mutations.
    Exact cutoff and omitted propagating orders are errors; near cutoff is a
    warning. Locations identify the offending field or wavelength index.
    """
    diagnostics = material_coverage_diagnostics(project)
    if diagnostics:
        return diagnostics
    harmonics = project.solver.harmonics
    orders = np.arange(-harmonics, harmonics + 1)
    angle = np.deg2rad(project.illumination.angle_deg)
    for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
        n0 = refractive_index(project.ambient, wavelength)
        ns = refractive_index(project.substrate, wavelength)
        incident_kx = n0.real * np.sin(angle)
        kx = incident_kx + orders * wavelength / project.period_nm
        kx_outside = incident_kx + np.array([-harmonics - 1, harmonics + 1]) * wavelength / project.period_nm
        largest_lossless_port_index = max(n0.real, ns.real if ns.imag == 0 else n0.real)
        if np.any(np.abs(kx_outside) <= largest_lossless_port_index):
            diagnostics.append(
                Diagnostic(
                    code="insufficient_harmonics",
                    severity="error",
                    location=["solver", "harmonics"],
                    message="Harmonics are too small to retain all propagating diffraction orders; increase harmonics or reduce the period",
                )
            )
        q_top = n0.real**2 - kx**2
        q_bottom = ns**2 - kx**2
        distance = np.min(np.abs(np.r_[q_top, q_bottom]))
        if distance < EXACT_CUTOFF_TOLERANCE:
            diagnostics.append(
                Diagnostic(
                    code="rayleigh_cutoff",
                    severity="error",
                    location=["illumination", "wavelengths_nm", wi],
                    message=f"A diffraction order is exactly at a Rayleigh cutoff near {wavelength:g} nm; move the sampled wavelength slightly",
                )
            )
        elif distance < NEAR_CUTOFF_TOLERANCE:
            diagnostics.append(
                Diagnostic(
                    code="near_rayleigh_cutoff",
                    severity="warning",
                    location=["illumination", "wavelengths_nm", wi],
                    message="A sampled order is near a Rayleigh cutoff; refine wavelength and harmonic sampling.",
                )
            )
    return diagnostics


def ensure_preflight(project: Project) -> list[Diagnostic]:
    diagnostics = preflight_project(project)
    if any(item.severity == "error" for item in diagnostics):
        raise PreflightError(diagnostics)
    return diagnostics
