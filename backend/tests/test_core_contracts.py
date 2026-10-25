"""Engine-independent admissibility and strict typed numerical result contracts."""

import copy
from importlib import metadata

import pytest
from pydantic import TypeAdapter, ValidationError

from rcwa_core import preflight
from rcwa_core.contracts import ForwardResult, Result, SyntheticFitResult, validate_result
from rcwa_core.fitting import fit_cd
from rcwa_core.preflight import EngineUnavailableError, PreflightError, ensure_preflight, preflight_project
from rcwa_core.schemas import HomogeneousLayer, Layer, Material, Project
from rcwa_core.solver import SolverError, forward
from test_stack_physics import planar_tmm


@pytest.fixture(scope="module")
def forward_pair():
    project = Project()
    project.illumination.wavelengths_nm = [550.0]
    project.solver.harmonics = 3
    return project, forward(project)


@pytest.fixture(scope="module")
def fit_triple():
    project = Project()
    project.illumination.wavelengths_nm = [450.0, 530.0, 610.0, 690.0, 770.0]
    project.solver.harmonics = 3
    fit = {"target_cd_nm": 207.0, "lower_cd_nm": 100.0, "upper_cd_nm": 300.0}
    return project, fit, fit_cd(project, fit)


def test_actual_json_schema_exposes_bounded_layers_and_discriminated_results():
    assert Project.model_json_schema()["properties"]["layers"]["maxItems"] == 8
    schema = TypeAdapter(Result).json_schema()
    assert schema["discriminator"]["propertyName"] == "result_type"
    assert set(schema["discriminator"]["mapping"]) == {"forward", "synthetic_fit"}
    assert "metadata" in schema["$defs"]["ForwardResult"]["required"]
    assert "orders" in schema["$defs"]["PolarizationSpectrum"]["required"]
    assert schema["$defs"]["OrderPower"]["additionalProperties"] is False


def test_preflight_is_deterministic_without_engine_or_process(monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("Preflight must not inspect/import the engine or allocate a process")

    monkeypatch.setattr(preflight, "engine_info", unexpected)
    monkeypatch.setattr("multiprocessing.Process", unexpected)
    monkeypatch.setattr("rcwa_core.solver._solve_with_ports", unexpected)
    project = Project()
    before = project.model_dump()
    assert preflight_project(project) == []
    assert ensure_preflight(project) == []
    assert project.model_dump() == before


def test_material_coverage_is_shared_and_field_located():
    material = Material(kind="tabulated", wavelengths_nm=[400, 800], n_values=[2, 3], k_values=[0, 0])
    project = Project()
    project.layers[0].material = material
    diagnostics = preflight_project(project)
    assert diagnostics[0].code == "material_coverage"
    assert diagnostics[0].location == ["layers", 0, "material", "wavelengths_nm"]
    with pytest.raises(ValidationError, match="extrapolation") as validation:
        Project.model_validate(project.model_dump())
    source = validation.value.errors()[0]["ctx"]["error"]
    assert isinstance(source, PreflightError)
    assert source.diagnostics == diagnostics
    with pytest.raises(PreflightError, match="extrapolation") as error:
        ensure_preflight(project)
    assert error.value.diagnostics == diagnostics


def test_omitted_orders_fail_both_preflight_and_worker():
    project = Project()
    project.period_nm = 4000
    project.solver.harmonics = 1
    project.illumination.wavelengths_nm = [450.0]
    diagnostics = preflight_project(project)
    assert diagnostics[0].code == "insufficient_harmonics"
    assert diagnostics[0].location == ["solver", "harmonics"]
    with pytest.raises(SolverError, match="propagating"):
        forward(project)


@pytest.mark.parametrize("k", [0.0, 1e-12, 1e-4, 0.1])
def test_substrate_absorption_does_not_hide_its_open_orders(k):
    project = Project()
    project.period_nm = 3000
    project.solver.harmonics = 3
    project.illumination.angle_deg = 0.0
    project.illumination.wavelengths_nm = [901.0]
    project.substrate = Material(n=3.6, k=k)
    assert "insufficient_harmonics" in [item.code for item in preflight_project(project)]
    project.substrate = Material(n=0.2, k=3.5)  # metal: no order propagates beyond the ambient light cone
    assert "insufficient_harmonics" not in [item.code for item in preflight_project(project)]


def normal_stack_at_800(layers):
    # wavelength / period = 2: orders ±1 graze inside an n=2 slab.
    data = Project().model_dump()
    data.update(schema_version="1.1", layers=layers)
    data["illumination"].update(angle_deg=0.0, wavelengths_nm=[800.0])
    return Project.model_validate(data)


def test_exact_internal_cutoff_in_uniform_stack_is_solved_exactly():
    # A uniform stack couples only the specular order, so it is solved alone, without perturbation.
    project = normal_stack_at_800([HomogeneousLayer(thickness_nm=150, material=Material(n=2.0)).model_dump()])
    assert preflight_project(project) == []
    result = forward(project)
    for pol in ("s", "p"):
        series = result["spectra"][pol]
        expected = planar_tmm(800.0, 0, 1.0, [(150, 2.0)], 1.5, pol)
        assert abs(series["R"][0] - expected[0]) < 1e-12 and abs(series["T"][0] - expected[1]) < 1e-12
        assert [order["m"] for order in series["orders"][0]] == list(range(-7, 8))
        assert all(order["R"] == order["T"] == 0 for order in series["orders"][0] if order["m"])


def test_a_rectangle_of_one_material_is_solved_like_the_equivalent_film():
    same = Layer(thickness_nm=150, cd_nm=180, material=Material(n=2.0), background=Material(n=2.0))
    film = HomogeneousLayer(thickness_nm=150, material=Material(n=2.0))
    a, b = (forward(normal_stack_at_800([layer.model_dump()])) for layer in (same, film))
    for pol in ("s", "p"):
        assert a["spectra"][pol]["R"] == b["spectra"][pol]["R"] and a["spectra"][pol]["T"] == b["spectra"][pol]["T"]


@pytest.mark.parametrize("cd,material", [(None, 2.0), (0.0, 1.0), (400.0, 2.0), (180.0, 2.0)])
def test_exact_internal_cutoff_in_a_uniform_slab_of_a_patterned_stack_is_rejected(cd, material):
    if cd is None:
        uniform = HomogeneousLayer(thickness_nm=150, material=Material(n=material))
    else:  # degenerate or no-contrast rectangles are uniform slabs too
        uniform = Layer(thickness_nm=150, cd_nm=cd, material=Material(n=material), background=Material(n=2.0))
    project = normal_stack_at_800([Project().layers[0].model_dump(), uniform.model_dump()])
    assert [(item.code, item.severity) for item in preflight_project(project)] == [("rayleigh_cutoff", "error")]
    with pytest.raises(PreflightError, match="grazes inside a uniform layer"):
        forward(project)


def test_cutoff_errors_and_near_cutoff_warnings_share_thresholds():
    project = Project()
    project.illumination.angle_deg = 0.0
    project.illumination.wavelengths_nm = [600.0]
    diagnostics = preflight_project(project)
    assert [(item.code, item.severity) for item in diagnostics] == [("rayleigh_cutoff", "error")]
    assert diagnostics[0].location == ["illumination", "wavelengths_nm", 0]
    with pytest.raises(PreflightError, match="cutoff"):
        forward(project)
    project.illumination.wavelengths_nm = [600.001]
    diagnostics = ensure_preflight(project)
    assert [(item.code, item.severity) for item in diagnostics] == [("near_rayleigh_cutoff", "warning")]
    result = forward(project)
    assert diagnostics[0].message in result["warnings"]


@pytest.mark.parametrize(
    "installed,exists,status",
    [
        (None, False, "not_installed"),
        ("0.13.2", False, "not_installed"),
        ("9.0", True, "version_mismatch"),
        ("0.13.2", True, "available"),
    ],
)
def test_engine_information_is_actual_and_does_not_solve(monkeypatch, installed, exists, status):
    def get_version(name):
        assert name == "meent"
        if installed is None:
            raise metadata.PackageNotFoundError(name)
        return installed

    monkeypatch.setattr(preflight.metadata, "version", get_version)
    monkeypatch.setattr(preflight.util, "find_spec", lambda name: object() if exists else None)
    info = preflight.engine_info()
    assert info.installed_version == installed
    assert info.status == status
    assert info.available == (status == "available")
    if not info.available:
        with pytest.raises(EngineUnavailableError) as error:
            forward(Project())
        assert error.value.engine == info


def test_real_forward_result_roundtrips_strict_contract(forward_pair):
    project, result = forward_pair
    validated = validate_result("forward", result, project)
    assert isinstance(validated, ForwardResult)
    assert validated.model_dump(mode="json") == result
    assert validated.metadata.adapter_version == "1.1.0"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(extra="unsupported"),
        lambda r: r.pop("result_type"),
        lambda r: r.update(result_type="synthetic_fit"),
        lambda r: r["metadata"].update(extra="unsupported"),
        lambda r: r["metadata"].update(elapsed_seconds=float("inf")),
        lambda r: r["metadata"].update(harmonics=True),
        lambda r: r["metadata"].update(version="9.0"),
        lambda r: r["metadata"].update(convergence_checked=True),
        lambda r: r["metadata"].update(convergence_checked=0),
        lambda r: r["metadata"].update(basis_size=99),
        lambda r: r["wavelengths_nm"].append(560.0),
        lambda r: r["spectra"]["s"]["R"].__setitem__(0, float("nan")),
        lambda r: r["spectra"]["s"]["R"].__setitem__(0, "0.1"),
        lambda r: r["spectra"]["s"]["R"].__setitem__(0, 0.12345),
        lambda r: r["spectra"]["s"]["R_specular"].__setitem__(0, 0.12345),
        lambda r: r["spectra"]["s"]["A_balance"].__setitem__(0, 0.12345),
        lambda r: r["spectra"]["s"]["orders"][0].pop(),
        lambda r: r["spectra"]["s"]["orders"][0][0].update(m="-3"),
        lambda r: r["spectra"]["s"]["orders"][0][0].update(m=True),
        lambda r: r["spectra"]["s"]["orders"][0][0].update(kx_over_k0=float("inf")),
        lambda r: r["spectra"]["s"]["orders"][0][0].update(transmission_class="absorbing_half_space"),
    ],
)
def test_malformed_forward_worker_results_rejected(forward_pair, mutate):
    project, result = forward_pair
    mutated = copy.deepcopy(result)
    mutate(mutated)
    with pytest.raises((ValidationError, ValueError)):
        validate_result("forward", mutated, project)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.illumination.wavelengths_nm.__setitem__(0, 551.0),
        lambda p: setattr(p.illumination, "polarization", "s"),
        lambda p: setattr(p.solver, "harmonics", 4),
        lambda p: setattr(p, "period_nm", 401.0),
        lambda p: setattr(p.substrate, "k", 0.1),
    ],
)
def test_forward_result_is_bound_to_declared_input_fields(forward_pair, mutate):
    project, result = forward_pair
    different = project.model_copy(deep=True)
    mutate(different)
    with pytest.raises(ValueError):
        validate_result("forward", result, different)


def test_real_synthetic_fit_roundtrips_distinct_contract(fit_triple):
    project, fit, result = fit_triple
    validated = validate_result("fit", result, project, fit)
    assert isinstance(validated, SyntheticFitResult)
    assert validated.result_type == "synthetic_fit"
    assert validated.model_dump(mode="json") == result
    with pytest.raises(ValueError, match="fit parameters"):
        validate_result("forward", result, project, fit)
    with pytest.raises(ValueError, match="requires"):
        validate_result("fit", result, project)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(extra="unsupported"),
        lambda r: r.update(fit_cd_nm="207"),
        lambda r: r.update(rmse=float("nan")),
        lambda r: r.update(status="not_converged"),
        lambda r: r["fitted_project"]["layers"][0].update(cd_nm=210),
        lambda r: r["fitted_project"].update(name="Different input"),
        lambda r: r["diagnostics"]["residuals"].pop(),
        lambda r: r["diagnostics"]["residuals"].__setitem__(0, 0.12345),
        lambda r: r["diagnostics"].update(refined_harmonics=9),
        lambda r: r["diagnostics"]["starts"][0].update(initial_cd_nm=101),
        lambda r: r["prediction"].update(extra="unsupported"),
    ],
)
def test_synthetic_fit_contract_and_request_binding(fit_triple, mutate):
    project, fit, result = fit_triple
    mutated = copy.deepcopy(result)
    mutate(mutated)
    with pytest.raises((ValidationError, ValueError)):
        validate_result("fit", mutated, project, fit)


def test_fit_target_is_bound_to_request(fit_triple):
    project, fit, result = fit_triple
    different = {**fit, "target_cd_nm": 208.0}
    with pytest.raises(ValueError, match="target CD"):
        validate_result("fit", result, project, different)


@pytest.mark.parametrize("polarization", ["s", "p", "both"])
@pytest.mark.parametrize("substrate_k", [0.0, 0.1])
@pytest.mark.parametrize("layer_k", [0.0, 0.2])
def test_contract_retains_absorbing_port_and_polarization_semantics(polarization, substrate_k, layer_k):
    project = Project()
    project.illumination.wavelengths_nm = [510.0, 650.0, 810.0]
    project.illumination.polarization = polarization
    project.substrate.k = substrate_k
    project.layers[0].material.k = layer_k
    result = forward(project)
    assert validate_result("forward", result, project).model_dump(mode="json") == result


def test_contract_with_wavelength_dependent_layer_loss():
    project = Project()
    project.illumination.wavelengths_nm = [510.0, 650.0, 810.0]
    project.layers[0].material = Material(
        kind="tabulated", wavelengths_nm=[450, 650, 850], n_values=[2, 2.1, 2.2], k_values=[0.1, 0, 0]
    )
    result = forward(project)
    assert validate_result("forward", result, project).metadata.max_lossless_flux_error is None
