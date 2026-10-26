from __future__ import annotations

from time import perf_counter

import numpy as np

from .preflight import (
    ADAPTER_VERSION,
    SolverError,
    ensure_engine_available,
    ensure_preflight,
    has_patterned_slab,
    refractive_index,
    stack_has_loss,
)
from .schemas import Layer, Project


def rectangle_cell(project: Project, ridge: complex, background: complex, layer: Layer | None = None):
    """Piecewise-constant vector geometry with exact floating-point boundaries.

    meent's continuous Fourier integrals consume segment end coordinates, not
    raster pixels. The ridge is centered at x=period/2; it is invariant in y.
    Degenerate CD=0/full-period are explicitly homogeneous films.
    """
    period = project.period_nm
    cd = (project.layers[0] if layer is None else layer).cd_nm
    if cd == 0:
        values, ends = [background], [period]
    elif cd == period:
        values, ends = [ridge], [period]
    else:
        values = [background, ridge, background]
        ends = [(period - cd) / 2, (period + cd) / 2, period]
    return [
        [
            np.asarray([values], dtype=np.complex128),
            np.asarray(ends, dtype=np.complex128).reshape(-1, 1),
            np.asarray([[period]], dtype=np.complex128),
        ]
    ]


def stack_cells(project: Project, wavelength: float):
    """Exact Fourier cells and thicknesses in physical top-to-bottom order.

    Zero-thickness layers have no optical effect and never enter convolution
    or eigensolving. Homogeneous cells use one full-period constant segment.
    """
    cells, thicknesses = [], []
    for layer in project.layers:
        if layer.thickness_nm == 0:
            continue
        material = refractive_index(layer.material, wavelength).conjugate()
        if layer.geometry == "homogeneous":
            cells.append(
                [
                    np.asarray([[material]], dtype=np.complex128),
                    np.asarray([[project.period_nm]], dtype=np.complex128),
                    np.asarray([[project.period_nm]], dtype=np.complex128),
                ]
            )
        else:
            background = refractive_index(layer.background, wavelength).conjugate()
            cells.extend(rectangle_cell(project, material, background, layer))
        thicknesses.append(layer.thickness_nm)
    return cells, thicknesses


def _solve_with_ports(kx, n0, ns, angle, polarization, wavelength, thicknesses, epx, epy, epz_inverse):
    """Use meent RCWA primitives with consistent passive complex-port branches.

    Upstream transfer_1d_1 conjugates kz but not epsilon in its TM port
    admittance. Initialize that boundary explicitly; all layer eigensolving,
    stable recursion, and flux conversion still use pinned meent functions.
    Internal fields follow exp(+i wt), hence passive kz has Im(kz)<=0.
    """
    from meent.on_numpy.emsolver.transfer_method import transfer_1d_2, transfer_1d_3, transfer_1d_4

    pol = 0 if polarization == "s" else 1
    size = len(kx)
    kz_top = np.sqrt(n0**2 - kx.astype(complex) ** 2).conjugate()
    kz_bottom = np.sqrt(ns**2 - kx.astype(complex) ** 2).conjugate()
    internal_ns = ns.conjugate()
    identity = np.eye(size, dtype=np.complex128)
    admittance = kz_bottom if pol == 0 else kz_bottom / internal_ns**2
    f, g, t = identity.copy(), 1j * np.diag(admittance), identity.copy()
    # The load is the semi-infinite substrate: recurse from the last physical
    # layer back to the incident face, preserving user-visible layer order.
    for i in reversed(range(len(thicknesses))):
        w, v, q = transfer_1d_2(pol, kx, epx[i], epy[i], epz_inverse[i], use_pinv=False)
        _, f, g, t, _, _ = transfer_1d_3(2 * np.pi / wavelength, w, v, q, thicknesses[i], f, g, t, use_pinv=False)
    result, _ = transfer_1d_4(pol, size, f, g, t, kz_top, kz_bottom, angle, n0.real, internal_ns, use_pinv=False)
    return result


def forward(project: Project) -> dict:
    """Compute retained diffraction-order powers, with no clipping or fallback."""
    project = Project.model_validate(project.model_dump())
    diagnostics = ensure_preflight(project)
    engine = ensure_engine_available()
    from meent.on_numpy.emsolver.convolution_matrix import to_conv_mat_vector

    started = perf_counter()
    harmonics = project.solver.harmonics
    orders = np.arange(-harmonics, harmonics + 1)
    angle = np.deg2rad(project.illumination.angle_deg)
    polarizations = ["s", "p"] if project.illumination.polarization == "both" else [project.illumination.polarization]
    spectra = {
        pol: {key: [] for key in ("R", "T", "R_specular", "T_specular", "A_balance", "orders")} for pol in polarizations
    }
    notices = ["Fourier convergence is not certified by a single run. Refine harmonics for your sample."]
    notices.extend(dict.fromkeys(item.message for item in diagnostics if item.severity == "warning"))
    any_loss = False
    absorbing_substrate = False
    max_lossless_balance = 0.0
    # Uniform stacks couple only the specular order. Solving it alone is exact and
    # avoids degenerate eigenproblems when another order grazes inside a film.
    patterned = has_patterned_slab(project)
    solved = slice(None) if patterned else slice(harmonics, harmonics + 1)

    for wavelength in project.illumination.wavelengths_nm:
        n0 = refractive_index(project.ambient, wavelength)
        ns = refractive_index(project.substrate, wavelength)
        wavelength_has_loss = stack_has_loss(project, wavelength)
        any_loss |= wavelength_has_loss
        absorbing_substrate |= ns.imag != 0
        incident_kx = n0.real * np.sin(angle)
        kx = incident_kx + orders * wavelength / project.period_nm
        q_top = n0.real**2 - kx**2
        q_bottom = ns**2 - kx**2

        cells, thicknesses = stack_cells(project, wavelength)
        if cells:
            try:
                with np.errstate(divide="raise", invalid="raise", over="raise"):
                    epx, epy, epz_inverse = to_conv_mat_vector(
                        cells, harmonics if patterned else 0, 0, type_complex=np.complex128, use_pinv=False
                    )
            except (np.linalg.LinAlgError, FloatingPointError) as exc:
                raise SolverError(f"Fourier compilation failed at {wavelength:g} nm: {exc}") from exc
        else:
            epx, epy, epz_inverse = [], [], []
        for pol in polarizations:
            try:
                with np.errstate(divide="raise", invalid="raise", over="raise"):
                    raw = _solve_with_ports(
                        kx[solved], n0, ns, angle, pol, wavelength, thicknesses, epx, epy, epz_inverse
                    )
                raw_r = np.asarray(raw["res"]["de_ri"], dtype=float).reshape(-1)
                raw_t = np.asarray(raw["res"]["de_ti"], dtype=float).reshape(-1)
            except (np.linalg.LinAlgError, FloatingPointError) as exc:
                raise SolverError(f"RCWA failed at {wavelength:g} nm ({pol}): {exc}") from exc
            if len(raw_r) != len(kx[solved]) or len(raw_t) != len(raw_r):
                raise SolverError(f"RCWA produced invalid output at {wavelength:g} nm ({pol})")
            r_orders, t_orders = np.zeros(len(orders)), np.zeros(len(orders))
            r_orders[solved], t_orders[solved] = raw_r, raw_t
            values = np.r_[r_orders, t_orders]
            if not np.all(np.isfinite(values)):
                raise SolverError(f"RCWA produced invalid output at {wavelength:g} nm ({pol})")
            reflection, transmission = float(r_orders.sum()), float(t_orders.sum())
            balance = 1.0 - reflection - transmission
            if values.min() < -1e-8 or balance < -1e-6:
                raise SolverError(f"Passive flux check failed at {wavelength:g} nm ({pol}); output was not clipped")
            if not wavelength_has_loss:
                max_lossless_balance = max(max_lossless_balance, abs(balance))
                if abs(balance) > 1e-6:
                    raise SolverError(f"Lossless stack flux check failed at {wavelength:g} nm ({pol})")
            series = spectra[pol]
            for key, value in (
                ("R", reflection),
                ("T", transmission),
                ("R_specular", float(r_orders[harmonics])),
                ("T_specular", float(t_orders[harmonics])),
                ("A_balance", balance),
            ):
                series[key].append(value)
            series["orders"].append(
                [
                    {
                        "m": int(m),
                        "R": float(r),
                        "T": float(t),
                        "kx_over_k0": float(k),
                        "reflection_propagating": bool(qr > 0),
                        "transmission_propagating": bool(qt.real > 0) if ns.imag == 0 else None,
                        "transmission_class": "absorbing_half_space"
                        if ns.imag
                        else ("propagating" if qt.real > 0 else "evanescent"),
                    }
                    for m, r, t, k, qr, qt in zip(orders, r_orders, t_orders, kx, q_top, q_bottom)
                ]
            )
    if absorbing_substrate:
        notices.append(
            "T is flux entering the absorbing substrate at its front face, not transmission through its backside. Absorbing substrate orders are not classified as ordinary propagating/evanescent channels."
        )
    if any_loss:
        notices.append(
            "A_balance is 1-R-T, the finite-stack flux deficit rather than an independently integrated absorption measurement."
        )
    return {
        "result_type": "forward",
        "schema_version": "1.1",
        "wavelengths_nm": project.illumination.wavelengths_nm,
        "spectra": spectra,
        "metadata": {
            "engine": "meent",
            "version": engine.installed_version,
            "adapter_version": ADAPTER_VERSION,
            "backend": "numpy",
            "precision": "complex128",
            "method": "1D classical RCWA, continuous Fourier integrals, inverse-rule factorization, TMM",
            "harmonics": harmonics,
            "retained_orders": orders.tolist(),
            "basis_size": len(orders),
            "geometry": "Common-period centered exact-boundary rectangles and homogeneous films; invariant y",
            "layer_count": len(project.layers),
            "active_slab_count": sum(layer.thickness_nm > 0 for layer in project.layers),
            "total_thickness_nm": sum(layer.thickness_nm for layer in project.layers),
            "stack_order": "top_to_bottom",
            "units": "nm; vacuum wavelength",
            "angle_convention": "degrees from +z surface normal; incidence in x-z plane",
            "material_convention": "Public n+i*k for exp(-i*omega*t); conjugated for meent finite-layer matrices and explicit outgoing port admittances",
            "port_adapter": "Corrected complex-port initialization: kz=conj(sqrt(N^2-kx^2)), TM admittance kz/conj(N)^2; upstream meent RCWA eigensolve/cascade/power unchanged",
            "polarization_convention": "s: electric field along y; p: magnetic field along y; power only",
            "power_normalization": "Unit incident normal Poynting flux; R at z=0, T at z=total_thickness into semi-infinite substrate (entrance-plane flux, including lossy ports)",
            "material_interpolation": "Linear n and k separately; extrapolation forbidden",
            "substrate_backside": "omitted; substrate is semi-infinite",
            "max_lossless_flux_error": max_lossless_balance if not any_loss else None,
            "convergence_checked": False,
            "elapsed_seconds": perf_counter() - started,
            "regularization": "none; no damping, pseudoinverse, angular perturbation, or output clipping",
        },
        "warnings": notices,
    }
