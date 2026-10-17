"""Electric-field intensity maps for one wavelength, from meent's own field reconstruction.

meent rebuilds fields from its native port convention. The production solver uses
its own port adapter (conjugated kz for absorbing substrates). A field map is only
returned when meent's native powers at the same wavelength agree with the production
powers, so the picture always belongs to the reported spectrum.
"""

from __future__ import annotations

import numpy as np

from .preflight import SolverError, ensure_engine_available, refractive_index
from .preflight_2d import ensure_preflight_2d, has_patterned_slab_2d
from .schemas_2d import Project2D
from .solver_2d import _solve_wavelength, stack_cells_2d

AGREEMENT_TOLERANCE = 1e-6
MAX_POINTS = 64


class FieldUnavailable(SolverError):
    """The native field reconstruction does not reproduce the production powers."""


def field_2d(project: Project2D, wavelength: float, polarization: str, resolution: int = 40) -> dict:
    from meent.on_numpy.emsolver.convolution_matrix import to_conv_mat_vector
    from meent.on_numpy.emsolver.rcwa import RCWANumpy

    project = Project2D.model_validate(project.model_dump())
    if polarization not in ("s", "p"):
        raise ValueError("Field maps need one incident polarization: s or p")
    if not 8 <= resolution <= MAX_POINTS:
        raise ValueError(f"Field resolution must be 8 to {MAX_POINTS} points")
    single = project.model_copy(update={"illumination": project.illumination.model_copy(update={"wavelengths_nm": [wavelength]})})
    single = Project2D.model_validate(single.model_dump())
    basis = (project.solver.harmonics_x, project.solver.harmonics_y)
    ensure_preflight_2d(single, basis=basis)
    ensure_engine_available()
    from .circular_geometry import CIRCLE_STRIPS

    production = _solve_wavelength(single, wavelength, basis, CIRCLE_STRIPS, False)["series"]
    production = production.get(polarization) or _solve_wavelength(
        single.model_copy(update={"illumination": single.illumination.model_copy(update={"polarization": polarization})}),
        wavelength, basis, CIRCLE_STRIPS, False,
    )["series"][polarization]

    cells, thicknesses = stack_cells_2d(single, wavelength)
    if not cells:
        raise FieldUnavailable("The stack has no finite layers to map")
    # Uniform stacks couple only the specular order (see solver_2d._solve_wavelength).
    hx, hy = basis if has_patterned_slab_2d(single) else (0, 0)
    n0 = refractive_index(project.ambient, wavelength).real
    ns = refractive_index(project.substrate, wavelength)
    angle, phi = np.deg2rad([project.illumination.angle_deg, project.illumination.azimuth_deg])
    try:
        with np.errstate(divide="raise", invalid="raise", over="raise"):
            ex, ey, ezi = to_conv_mat_vector(cells, hx, hy, type_complex=np.complex128, use_pinv=False)
            mee = RCWANumpy(
                n_top=n0, n_bot=ns.conjugate(), theta=angle, phi=phi, psi=np.pi / 2,
                period=[project.period_nm, project.period_y_nm], wavelength=wavelength,
                thickness=thicknesses, fto=[hx, hy], type_complex=np.complex128, use_pinv=False,
            )
            mee._grating_type_assigned = 2
            native = mee.solve_2d(wavelength, ex, ey, ezi)
            key = "res_te_inc" if polarization == "s" else "res_tm_inc"
            r = float(np.sum(native[key]["de_ri"]))
            t = float(np.sum(native[key]["de_ti"]))
            if abs(r - production["R"]) > AGREEMENT_TOLERANCE or abs(t - production["T"]) > AGREEMENT_TOLERANCE:
                raise FieldUnavailable(
                    "The field reconstruction does not reproduce this spectrum here "
                    f"(ΔR {abs(r - production['R']):.1e}, ΔT {abs(t - production['T']):.1e})."
                )
            selector = (False, True, False) if polarization == "s" else (False, False, True)
            field = mee.calculate_field(res_x=resolution, res_y=resolution, res_z=max(8, resolution // 2),
                                        set_field_input=selector)[0]
    except (np.linalg.LinAlgError, FloatingPointError) as exc:
        raise SolverError(f"Field calculation failed at {wavelength:g} nm: {exc}") from exc

    intensity = np.sum(np.abs(field[..., :3]) ** 2, axis=-1)  # (z, y, x), top layer first
    res_z = max(8, resolution // 2)
    tops = np.concatenate([[0], np.cumsum(thicknesses)])
    # meent samples each layer from its top through its bottom interface inclusive.
    z = np.concatenate([np.linspace(tops[i], tops[i + 1], res_z) for i in range(len(thicknesses))])
    centre = intensity.shape[1] // 2
    active = [i for i, layer in enumerate(project.layers) if layer.thickness_nm > 0]
    return {
        "wavelength_nm": wavelength,
        "polarization": polarization,
        "x_nm": np.linspace(0, project.period_nm, resolution).tolist(),
        "y_nm": np.linspace(0, project.period_y_nm, resolution)[::-1].tolist(),
        "depth_nm": z.tolist(),
        "layer_tops_nm": tops.tolist(),
        "layer_indices": active,
        "xz": intensity[:, centre, :].tolist(),
        "xy": [intensity[i * res_z + res_z // 2].tolist() for i in range(len(thicknesses))],
        "R": production["R"],
        "T": production["T"],
        "max_intensity": float(intensity.max()),
        "note": "|E|² relative to a unit-amplitude incident plane wave; depth measured from the top of the stack.",
    }
