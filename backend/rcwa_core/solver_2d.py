"""Offline coupled-vector x/y-periodic RCWA, awaiting application integration.

The production numerical path uses meent's directional inverse-rule Fourier
matrices. The separately named Laurent diagnostic is restricted to reference
harnesses; it never establishes production physical convergence.
"""

from __future__ import annotations

from time import perf_counter

import numpy as np

from .preflight import SolverError, ensure_engine_available, refractive_index
from .preflight_2d import ensure_preflight_2d, has_patterned_slab_2d, stack_has_loss_2d, wavevectors, widths
from .schemas_2d import Project2D

ADAPTER_VERSION_2D = "1.4.0"
CHANNELS = ("R_s", "R_p", "T_s", "T_p")
RAW_CHANNELS = ("de_ri_s", "de_ri_p", "de_ti_s", "de_ti_p")


def input_hash_2d(project):
    from .identity import canonical_hash

    normalized = Project2D.model_validate(project.model_dump(), strict=True)
    return canonical_hash(normalized.model_dump(mode="json"))


def rectangle_cell_2d(px, py, wx, wy, inclusion, background):
    """Continuous exact-boundary cells: rows are y, columns are x.

    Full/zero-width cases avoid zero-length segments. Material exchange represents
    a hole; no separate hidden geometry flag exists.
    """
    if wx == 0 or wy == 0:
        values, xs, ys = [[background]], [px], [py]
    else:
        xs = [px] if wx == px else [(px - wx) / 2, (px + wx) / 2, px]
        ys = [py] if wy == py else [(py - wy) / 2, (py + wy) / 2, py]
        values = np.full((len(ys), len(xs)), background, dtype=np.complex128)
        values[0 if len(ys) == 1 else 1, 0 if len(xs) == 1 else 1] = inclusion
    return [
        np.asarray(values, dtype=np.complex128),
        np.asarray(xs, dtype=np.complex128)[:, None],
        np.asarray(ys, dtype=np.complex128)[:, None],
    ]


def stack_cells_2d(project, wavelength, *, circle_strips=None):
    cells, thicknesses = [], []
    for layer in project.layers:
        if layer.thickness_nm == 0:
            continue
        inclusion = refractive_index(layer.material, wavelength).conjugate()
        background = (
            inclusion if layer.geometry == "homogeneous" else refractive_index(layer.background, wavelength).conjugate()
        )
        wx, wy = widths(project, layer)
        if layer.geometry == "circular_hole_2d":
            from .circular_geometry import CIRCLE_STRIPS, circular_cell_2d

            cells.append(circular_cell_2d(
                project.period_nm, project.period_y_nm, layer.diameter_nm, inclusion, background,
                strips=CIRCLE_STRIPS if circle_strips is None else circle_strips,
            ))
        else:
            cells.append(rectangle_cell_2d(project.period_nm, project.period_y_nm, wx, wy, inclusion, background))
        thicknesses.append(layer.thickness_nm)
    return cells, thicknesses


def conv_matrices_2d(cells, hx, hy):
    """meent's continuous Fourier matrices, with epx rebuilt in Li's directional order.

    Pinned meent forms epy as Laurent-in-x of the inverse-rule-in-y matrices, but
    epx as inverse-rule-in-x of inverted Laurent-in-y matrices. The two orders
    differ for genuinely 2D cells and break x/y (C4) symmetry. epx is therefore
    built exactly like epy on the transposed cell, then permuted back to the
    m-fastest basis.
    """
    from meent.on_numpy.emsolver.convolution_matrix import to_conv_mat_vector
    from meent.on_numpy.emsolver.fourier_analysis import cfs2d

    epx, epy, epz_inverse = to_conv_mat_vector(cells, hx, hy, type_complex=np.complex128, use_pinv=False)
    nx, ny = 2 * hx + 1, 2 * hy + 1
    swap = np.array([ix * ny + iy for iy in range(ny) for ix in range(nx)])
    for i, (values, xs, ys) in enumerate(cells):
        epx[i] = cfs2d(values.T ** 2, ys, xs, 1, 0, hy, hx, np.complex128)[np.ix_(swap, swap)]
    return epx, epy, epz_inverse


def _solve_2d_with_ports(kx, ky, n0, ns, angle, phi, wavelength, thicknesses, epx, epy, epz_inverse):
    from meent.on_numpy.emsolver.transfer_method import transfer_2d_2, transfer_2d_3, transfer_2d_4

    xx, yy = np.meshgrid(kx, ky)
    rho2 = xx**2 + yy**2
    kz_top = np.sqrt((n0**2 - rho2).astype(np.complex128)).ravel().conjugate()
    kz_bottom = np.sqrt(ns**2 - rho2.astype(np.complex128)).ravel().conjugate()
    # atan2 preserves all quadrants and axial orders. At normal zero order the
    # requested azimuth defines the polarization reference, without perturbing k.
    azimuths = np.arctan2(yy, xx)
    azimuths[rho2 == 0] = phi
    size = len(kz_top)
    identity, zero = np.eye(size, dtype=np.complex128), np.zeros((size, size), dtype=np.complex128)
    internal_ns = ns.conjugate()
    f = np.block([[identity, zero], [zero, 1j * np.diag(kz_bottom) / internal_ns**2]])
    g = np.block([[1j * np.diag(kz_bottom), zero], [zero, identity]])
    t = np.eye(2 * size, dtype=np.complex128)
    for i in reversed(range(len(thicknesses))):
        w, v, q = transfer_2d_2(kx, ky, epx[i], epy[i], epz_inverse[i], use_pinv=False)
        _, f, g, t, _, _ = transfer_2d_3(
            2 * np.pi / wavelength,
            w,
            v,
            q,
            thicknesses[i],
            azimuths.ravel(),
            f,
            g,
            t,
            use_pinv=False,
        )
    # One cascade/inverse supplies both incident s and p; no double solving.
    result, _ = transfer_2d_4(
        len(kx),
        len(ky),
        f,
        g,
        t,
        kz_top,
        kz_bottom,
        np.pi / 2,
        angle,
        n0,
        internal_ns,
        use_pinv=False,
    )
    return result


def forward_2d(
    project: Project2D, *, reference_basis: tuple[int, int] | None = None, reference_circle_strips: int | None = None
) -> dict:
    """Offline production formulation. Higher bases are an explicit test override.

    Public worker/API dispatch must not call this until its separate admission,
    result/storage and UI integration gates pass. The override cannot alter the
    input hash silently: actual basis and offline override are explicit metadata.
    """
    return _forward_2d(
        project, reference_basis=reference_basis, laurent_diagnostic=False, reference_circle_strips=reference_circle_strips
    )


def laurent_diagnostic_2d(project: Project2D, *, reference_basis=None):
    """Same-formulation algebraic control only, never the production algorithm."""
    return _forward_2d(project, reference_basis=reference_basis, laurent_diagnostic=True)


def _forward_2d(project, *, reference_basis, laurent_diagnostic, reference_circle_strips=None):
    project = Project2D.model_validate(project.model_dump())
    from .circular_geometry import CIRCLE_STRIPS, validate_circle_strips

    circle_strips = CIRCLE_STRIPS if reference_circle_strips is None else validate_circle_strips(reference_circle_strips)
    circular = any(layer.geometry == "circular_hole_2d" for layer in project.layers)
    if reference_circle_strips is not None and not circular:
        raise ValueError("Circle spatial refinement requires at least one circular-hole layer")
    basis = reference_basis or (project.solver.harmonics_x, project.solver.harmonics_y)
    if not isinstance(basis, tuple) or len(basis) != 2 or any(type(h) is not int or not 0 <= h <= 15 for h in basis):
        raise ValueError("Offline reference basis must contain two integer half-widths from 0 through 15")
    diagnostics = ensure_preflight_2d(project, basis=basis)
    engine = ensure_engine_available()
    start = perf_counter()
    partials = [
        _solve_wavelength(project, wavelength, basis, circle_strips, laurent_diagnostic)
        for wavelength in project.illumination.wavelengths_nm
    ]
    return _assemble(
        project,
        partials,
        diagnostics,
        engine,
        basis,
        circle_strips,
        reference_basis=reference_basis,
        reference_circle_strips=reference_circle_strips,
        laurent_diagnostic=laurent_diagnostic,
        elapsed=perf_counter() - start,
    )


def solve_wavelengths_2d(project: Project2D, indices) -> list[dict]:
    """Production solve of selected wavelength indices, for sharded browser/worker runs.

    Each partial is plain JSON. assemble_forward_2d merges all partials into the
    same result forward_2d returns for the whole spectrum.
    """
    from .circular_geometry import CIRCLE_STRIPS

    project = Project2D.model_validate(project.model_dump())
    basis = (project.solver.harmonics_x, project.solver.harmonics_y)
    ensure_preflight_2d(project, basis=basis)
    ensure_engine_available()
    wavelengths = project.illumination.wavelengths_nm
    return [_solve_wavelength(project, wavelengths[i], basis, CIRCLE_STRIPS, False) for i in indices]


def assemble_forward_2d(project: Project2D, partials, *, elapsed_seconds: float) -> dict:
    from .circular_geometry import CIRCLE_STRIPS

    project = Project2D.model_validate(project.model_dump())
    if [p["wavelength_nm"] for p in partials] != project.illumination.wavelengths_nm:
        raise ValueError("Partials must cover every project wavelength in order")
    basis = (project.solver.harmonics_x, project.solver.harmonics_y)
    diagnostics = ensure_preflight_2d(project, basis=basis)
    engine = ensure_engine_available()
    return _assemble(project, partials, diagnostics, engine, basis, CIRCLE_STRIPS, elapsed=elapsed_seconds)


def _solve_wavelength(project, wavelength, basis, circle_strips, laurent_diagnostic):
    hx, hy = basis
    angle, phi = np.deg2rad([project.illumination.angle_deg, project.illumination.azimuth_deg])
    labels = [(m, n) for n in range(-hy, hy + 1) for m in range(-hx, hx + 1)]
    pols = ["s", "p"] if project.illumination.polarization == "both" else [project.illumination.polarization]
    n0 = refractive_index(project.ambient, wavelength).real
    ns = refractive_index(project.substrate, wavelength)
    has_loss = stack_has_loss_2d(project, wavelength)
    kx, ky = wavevectors(project, wavelength, hx, hy)
    xx, yy = np.meshgrid(kx, ky)
    q_top, q_bottom = n0**2 - xx**2 - yy**2, ns**2 - xx**2 - yy**2
    cells, thicknesses = stack_cells_2d(project, wavelength, circle_strips=circle_strips)
    # Uniform stacks couple only the specular order. Solving it alone is exact and
    # avoids degenerate eigenproblems when another order grazes inside a film.
    patterned = has_patterned_slab_2d(project)
    sx, sy = (hx, hy) if patterned else (0, 0)
    try:
        with np.errstate(divide="raise", invalid="raise", over="raise"):
            if cells:
                ex, ey, ezi = conv_matrices_2d(cells, sx, sy)
                if laurent_diagnostic:
                    ex = np.linalg.inv(ezi)
                    ey = ex.copy()
            else:
                ex, ey, ezi = [], [], []
            skx, sky = (kx, ky) if patterned else (kx[hx : hx + 1], ky[hy : hy + 1])
            raw = _solve_2d_with_ports(skx, sky, n0, ns, angle, phi, wavelength, thicknesses, ex, ey, ezi)
    except (np.linalg.LinAlgError, FloatingPointError) as exc:
        raise SolverError(f"2D RCWA failed at {wavelength:g} nm: {exc}") from exc
    if not patterned:
        for key in ("res_te_inc", "res_tm_inc"):
            embedded = {}
            for channel in RAW_CHANNELS:
                full = np.zeros((2 * hy + 1, 2 * hx + 1))
                full[hy, hx] = np.asarray(raw[key][channel], dtype=float).reshape(-1)[0]
                embedded[channel] = full
            raw[key] = embedded
    partial = {"wavelength_nm": wavelength, "has_loss": bool(has_loss), "absorbing_port": bool(ns.imag != 0),
               "lossless_error": 0.0, "series": {}}
    for pol in pols:
        result = raw["res_te_inc" if pol == "s" else "res_tm_inc"]
        arrays = [np.asarray(result[k], dtype=float) for k in RAW_CHANNELS]
        if any(a.shape != (2 * hy + 1, 2 * hx + 1) for a in arrays):
            raise SolverError("2D RCWA output shape does not match its x/y basis")
        values = np.stack(arrays)
        if not np.all(np.isfinite(values)):
            raise SolverError(f"2D RCWA produced nonfinite output at {wavelength:g} nm ({pol})")
        r_orders, t_orders = arrays[0] + arrays[1], arrays[2] + arrays[3]
        reflection, transmission = float(r_orders.sum()), float(t_orders.sum())
        balance = 1 - reflection - transmission
        if values.min() < -1e-8 or balance < -1e-6:
            raise SolverError(f"2D passive flux check failed at {wavelength:g} nm ({pol}); no clipping")
        if not has_loss:
            partial["lossless_error"] = max(partial["lossless_error"], abs(balance))
            if abs(balance) > 1e-6:
                raise SolverError(f"2D lossless flux check failed at {wavelength:g} nm ({pol})")
        rows = []
        for m, n in labels:
            iy, ix = n + hy, m + hx
            rows.append(
                {
                    "m": m,
                    "n": n,
                    "kx_over_k0": float(xx[iy, ix]),
                    "ky_over_k0": float(yy[iy, ix]),
                    "R": float(r_orders[iy, ix]),
                    "T": float(t_orders[iy, ix]),
                    **{k: float(a[iy, ix]) for k, a in zip(CHANNELS, arrays)},
                    "reflection_propagating": bool(q_top[iy, ix] > 0),
                    "transmission_propagating": None if ns.imag else bool(q_bottom[iy, ix].real > 0),
                    "transmission_class": "absorbing_half_space"
                    if ns.imag
                    else ("propagating" if q_bottom[iy, ix].real > 0 else "evanescent"),
                }
            )
        partial["series"][pol] = {
            "R": reflection,
            "T": transmission,
            "A_balance": balance,
            "R_specular": float(r_orders[hy, hx]),
            "T_specular": float(t_orders[hy, hx]),
            "orders": rows,
        }
    return partial


def _assemble(project, partials, diagnostics, engine, basis, circle_strips, *, reference_basis=None,
              reference_circle_strips=None, laurent_diagnostic=False, elapsed):
    from .circular_geometry import circle_approximation_metadata

    hx, hy = basis
    circular = any(layer.geometry == "circular_hole_2d" for layer in project.layers)
    labels = [(m, n) for n in range(-hy, hy + 1) for m in range(-hx, hx + 1)]
    pols = ["s", "p"] if project.illumination.polarization == "both" else [project.illumination.polarization]
    spectra = {pol: {k: [] for k in ("R", "T", "R_specular", "T_specular", "A_balance", "orders")} for pol in pols}
    max_lossless_error, any_loss, absorbing_port = 0.0, False, False
    for partial in partials:
        any_loss |= partial["has_loss"]
        absorbing_port |= partial["absorbing_port"]
        if not partial["has_loss"]:
            max_lossless_error = max(max_lossless_error, partial["lossless_error"])
        for pol in pols:
            for k, value in partial["series"][pol].items():
                spectra[pol][k].append(value)
    warnings = ["Convergence not assessed for this input. A single run and flux balance do not certify accuracy."]
    warnings.extend(dict.fromkeys(d.message for d in diagnostics if d.severity == "warning"))
    if circular:
        warnings.append(
            f"Circular boundaries use {circle_strips} midpoint strips; spatial and harmonic convergence are separate. "
            "Geometry area bounds are not optical-error bounds."
        )
    if absorbing_port:
        warnings.append("T is entrance-plane flux into an absorbing half-space, not backside transmission.")
    if any_loss:
        warnings.append("A_balance is finite-stack flux deficit, not independently integrated absorption.")
    if laurent_diagnostic:
        warnings.append("DIAGNOSTIC ONLY: Laurent algebraic agreement does not validate production convergence.")
    return {
        "result_type": "forward",
        "schema_version": "1.2",
        "wavelengths_nm": project.illumination.wavelengths_nm,
        "spectra": spectra,
        "metadata": {
            "stage": "bounded_forward",
            "engine": "meent",
            "version": engine.installed_version,
            "adapter_version": ADAPTER_VERSION_2D,
            "precision": "complex128",
            "backend": "numpy",
            "input_hash": input_hash_2d(project),
            "harmonics_x": hx,
            "harmonics_y": hy,
            "basis_size": len(labels),
            "retained_orders": [list(label) for label in labels],
            "offline_reference_override": reference_basis is not None,
            "factorization": "diagnostic_laurent" if laurent_diagnostic else "directional_inverse_rule",
            "layer_count": len(project.layers),
            "active_slab_count": sum(layer.thickness_nm > 0 for layer in project.layers),
            "total_thickness_nm": sum(layer.thickness_nm for layer in project.layers),
            "stack_order": "top_to_bottom",
            "units": "nm; vacuum wavelength",
            "geometry": (
                "Centered circles (midpoint-strip approximation), axis-aligned rectangles and uniform films; common x/y periods"
                if circular else "Centered axis-aligned rectangles; common x/y periods"
            ),
            **({"circular_geometry": circle_approximation_metadata(project, circle_strips, reference_circle_strips is not None)}
               if circular else {}),
            "polarization_convention": "Incident s=(-sin(phi),cos(phi),0); each outgoing order uses local s/p; zero transverse vector uses incident azimuth",
            "port_adapter": "q=conj(sqrt(N_public^2-kx^2-ky^2)); TM admittance q/conj(N_public)^2",
            "power_normalization": "Unit incident normal Poynting flux; semi-infinite substrate entrance-plane T",
            "material_interpolation": "Linear n and k separately; extrapolation forbidden",
            "convergence_checked": False,
            "max_lossless_flux_error": None if any_loss else max_lossless_error,
            "regularization": "none; no damping, pseudoinverse, angular perturbation, or clipping",
            "elapsed_seconds": elapsed,
        },
        "warnings": warnings,
    }
