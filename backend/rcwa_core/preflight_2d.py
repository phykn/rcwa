"""Numerical-only full-lattice preflight; no Fourier-convergence certification."""

from __future__ import annotations

from math import ceil, floor

import numpy as np

from .preflight import (
    Diagnostic,
    EXACT_CUTOFF_TOLERANCE,
    NEAR_CUTOFF_TOLERANCE,
    PreflightError,
    has_contrast,
    refractive_index,
)


def widths(project, layer):
    if layer.geometry == "homogeneous":
        return project.period_nm, project.period_y_nm
    if layer.geometry == "rectangle_1d":
        return layer.cd_nm, project.period_y_nm
    if layer.geometry == "circular_hole_2d":
        return layer.diameter_nm, layer.diameter_nm
    return layer.cd_x_nm, layer.cd_y_nm


def declared_materials(project):
    yield project.ambient, ["ambient"]
    yield project.substrate, ["substrate"]
    for i, layer in enumerate(project.layers):
        yield layer.material, ["layers", i, "material"]
        if layer.geometry != "homogeneous":
            yield layer.background, ["layers", i, "background"]


def material_coverage_diagnostics_2d(project):
    wavelengths = project.illumination.wavelengths_nm
    return [
        Diagnostic(
            code="material_coverage",
            severity="error",
            location=location + ["wavelengths_nm"],
            message=f"{material.name}: wavelength outside material table; extrapolation is forbidden",
        )
        for material, location in declared_materials(project)
        if material.kind == "tabulated"
        and (min(wavelengths) < material.wavelengths_nm[0] or max(wavelengths) > material.wavelengths_nm[-1])
    ]


def active_materials_2d(project):
    for layer in project.layers:
        yield from layer_active_materials_2d(project, layer)


def layer_active_materials_2d(project, layer):
    if not layer.thickness_nm:
        return
    wx, wy = widths(project, layer)
    if wx > 0 and wy > 0:
        yield layer.material
    if layer.geometry == "circular_hole_2d" or (
        layer.geometry != "homogeneous" and (wx < project.period_nm or wy < project.period_y_nm)
    ):
        yield layer.background


def uniform_slab_permittivities_2d(project, wavelength):
    """Active slabs with no lateral contrast at this wavelength, including degenerate cells."""
    permittivities = []
    for layer in project.layers:
        indices = {refractive_index(material, wavelength) for material in layer_active_materials_2d(project, layer)}
        if len(indices) == 1:
            permittivities.append(indices.pop() ** 2)
    return permittivities


def has_patterned_slab_2d(project):
    """A stack whose every active slab is uniform cannot diffract."""
    for layer in project.layers:
        if not layer.thickness_nm or layer.geometry == "homogeneous":
            continue
        if not has_contrast(layer, project.illumination.wavelengths_nm):
            continue
        if layer.geometry == "circular_hole_2d":
            if layer.diameter_nm > 0:
                return True
            continue
        wx, wy = widths(project, layer)
        if wx > 0 and wy > 0 and (wx < project.period_nm or wy < project.period_y_nm):
            return True
    return False


def stack_has_loss_2d(project, wavelength):
    return any(refractive_index(material, wavelength).imag != 0 for material in active_materials_2d(project))


def wavevectors(project, wavelength, hx, hy):
    theta, phi = np.deg2rad([project.illumination.angle_deg, project.illumination.azimuth_deg])
    n0 = refractive_index(project.ambient, wavelength).real
    kx = n0 * np.sin(theta) * np.cos(phi) + np.arange(-hx, hx + 1) * wavelength / project.period_nm
    ky = n0 * np.sin(theta) * np.sin(phi) + np.arange(-hy, hy + 1) * wavelength / project.period_y_nm
    return kx, ky


def preflight_2d(project, *, basis=None):
    diagnostics = material_coverage_diagnostics_2d(project)
    if diagnostics:
        return diagnostics
    hx, hy = basis or (project.solver.harmonics_x, project.solver.harmonics_y)
    patterned = has_patterned_slab_2d(project)
    for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
        n0 = refractive_index(project.ambient, wavelength)
        ns = refractive_index(project.substrate, wavelength)
        kx, ky = wavevectors(project, wavelength, hx, hy)
        # Enumerate every integer point in the light-cone bounding rectangle.
        # Corner/axis tests alone miss shifted off-axis propagating channels.
        bx, by = kx[hx], ky[hy]
        # A weakly absorbing substrate still carries nearly propagating orders out to n.
        radius = max(n0.real, ns.real)
        sx, sy = wavelength / project.period_nm, wavelength / project.period_y_nm
        missing = [
            (m, n)
            for n in range(ceil((-radius - by) / sy), floor((radius - by) / sy) + 1)
            for m in range(ceil((-radius - bx) / sx), floor((radius - bx) / sx) + 1)
            if (bx + m * sx) ** 2 + (by + n * sy) ** 2 <= radius**2 and (abs(m) > hx or abs(n) > hy)
        ]
        if missing and patterned:
            diagnostics.append(
                Diagnostic(
                    code="insufficient_harmonics",
                    severity="error",
                    location=["solver"],
                    message=f"Retained x/y basis omits {len(missing)} open or cutoff orders near {wavelength:g} nm; "
                    f"first (m,n)={missing[0]}. Increase harmonics or reduce periods.",
                )
            )
        # Uniform films couple only the specular order; other orders carry no power.
        xx, yy = np.meshgrid(kx, ky) if patterned else (kx[hx : hx + 1], ky[hy : hy + 1])
        rho2 = xx**2 + yy**2
        # A uniform slab has no mode mixing, so an order grazing inside it is singular too.
        films = uniform_slab_permittivities_2d(project, wavelength)
        distance = np.min(np.abs(np.r_[n0.real**2 - rho2.ravel(), ns**2 - rho2.ravel(),
                                        *[eps - rho2.ravel() for eps in films]]))
        if distance < EXACT_CUTOFF_TOLERANCE:
            diagnostics.append(
                Diagnostic(
                    code="rayleigh_cutoff",
                    severity="error",
                    location=["illumination", "wavelengths_nm", wi],
                    message=f"A retained (m,n) order is exactly at a Rayleigh cutoff, or grazes inside a uniform layer, near {wavelength:g} nm",
                )
            )
        elif distance < NEAR_CUTOFF_TOLERANCE:
            diagnostics.append(
                Diagnostic(
                    code="near_rayleigh_cutoff",
                    severity="warning",
                    location=["illumination", "wavelengths_nm", wi],
                    message="A retained 2D order approaches a Rayleigh cutoff; refine wavelength and harmonic sampling.",
                )
            )
    return diagnostics


def ensure_preflight_2d(project, *, basis=None):
    diagnostics = preflight_2d(project, basis=basis)
    if any(item.severity == "error" for item in diagnostics):
        raise PreflightError(diagnostics)
    return diagnostics
