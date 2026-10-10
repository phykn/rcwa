"""Released legacy identities and one normalized UTF-8 identity for explicit 2D."""

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import unicodedata

import pytest
from pydantic import ValidationError

from api.storage import canonical_hash as storage_hash
from rcwa_core.identity import canonical_hash
from rcwa_core.project_io import normalized_project_and_hash, parse_project
from rcwa_core.solver_2d import input_hash_2d
from test_project_dispatch import small_2d_project


FIXTURE = Path(__file__).parent / "fixtures" / "true-2d" / "released-legacy-identities.json"
FROZEN = json.loads(FIXTURE.read_text(encoding="utf-8"))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def reverse_keys(value):
    if isinstance(value, dict):
        return {key: reverse_keys(value[key]) for key in reversed(value)}
    if isinstance(value, list):
        return [reverse_keys(item) for item in value]
    return value


def integral_float_fields(value):
    if isinstance(value, dict):
        return {key: integral_float_fields(item) for key, item in value.items()}
    if isinstance(value, list):
        return [integral_float_fields(item) for item in value]
    # Signed zero is intentionally NOT collapsed in tests of representation parity.
    if isinstance(value, float) and value.is_integer() and (value != 0 or math.copysign(1, value) > 0):
        return int(value)
    return value


def replace_path(project, path, value):
    target = project
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value


def table_project():
    project = parse_project(small_2d_project()).model_dump(mode="json")
    project["substrate"].update(kind="tabulated", wavelengths_nm=[400.0, 900.0],
                                n_values=[1.5, 1.6], k_values=[0.0, 0.0],
                                name="기판 🧪 e\u0301", source="가상 표 e\u0301 / 🇰🇷")
    project["layers"][0]["name"] = "층 🧪"
    project["layers"][0]["material"]["source"] = "비보정 합성 e\u0301"
    return project


def test_frozen_source_is_the_accepted_first_use_release():
    assert FROZEN["released_remote_commit"] == "d89f066885abde585ba4d7660b6bc0a84187a225"
    assert FROZEN["source_tree"] == "f87fa6d2d8b524283fe990a7325cf95c91facc45"
    assert {case["name"] for case in FROZEN["cases"]} == {
        f"{version}-{kind}" for version in ("1.0", "1.1")
        for kind in ("unicode", "signed-zero", "unicode-signed-zero")
    }


@pytest.mark.parametrize("case", FROZEN["cases"], ids=lambda case: case["name"])
def test_legacy_normalized_bytes_and_hashes_match_frozen_release(case):
    original = deepcopy(case["project"])
    for project in (deepcopy(original), reverse_keys(original)):
        model, normalized, digest = normalized_project_and_hash(project)
        assert encoded(normalized) == encoded(case["project"])
        assert digest == case["hash"] == hashlib.sha256(encoded(normalized)).hexdigest()
        assert storage_hash(normalized) == canonical_hash(normalized) == digest
        assert normalized_project_and_hash(model)[2] == digest
        # Missing schema_version has the historical 1.0 interpretation only.
        if model.schema_version == "1.0":
            del project["schema_version"]
            assert normalized_project_and_hash(project)[2] == digest
    assert case["project"] == original


def test_unicode_nested_tables_and_ordering_have_one_canonical_identity():
    project = table_project()
    model, normalized, digest = normalized_project_and_hash(project)
    assert normalized == project
    assert input_hash_2d(model) == storage_hash(normalized) == canonical_hash(normalized) == digest
    assert normalized_project_and_hash(reverse_keys(project))[2] == digest
    assert b"\\u" not in encoded(normalized)
    assert "e\u0301" in normalized["name"] and "e\u0301" in normalized["substrate"]["source"]
    composed = deepcopy(project)
    composed["name"] = unicodedata.normalize("NFC", composed["name"])
    assert composed["name"] != project["name"]
    assert normalized_project_and_hash(composed)[2] != digest
    assert normalized_project_and_hash(integral_float_fields(project))[2] == digest


@pytest.mark.parametrize("version", ["1.0", "1.1", "1.2"])
def test_integer_number_spelling_for_float_fields_normalizes_before_hash(version):
    project = table_project() if version == "1.2" else next(
        deepcopy(case["project"]) for case in FROZEN["cases"] if case["name"] == f"{version}-unicode"
    )
    expected = normalized_project_and_hash(project)
    actual = normalized_project_and_hash(integral_float_fields(project))
    assert encoded(actual[1]) == encoded(expected[1])
    assert actual[2] == expected[2]


@pytest.mark.parametrize("path,value", [
    (("period_y_nm",), 421.0), (("layers", 0, "cd_y_nm"), 181.0),
    (("illumination", "azimuth_deg"), 26.0), (("layers", 0, "material", "n"), 1.66),
    (("substrate", "n_values", 0), 1.51), (("substrate", "source"), "다른 표 🧪"),
    (("illumination", "wavelengths_nm", 0), 651.0), (("illumination", "polarization"), "s"),
    (("layers", 0, "name"), "다른 층"), (("solver", "harmonics_y"), 2),
])
def test_every_semantic_or_source_change_has_a_distinct_identity(path, value):
    original = table_project()
    edited = deepcopy(original)
    replace_path(edited, path, value)
    assert normalized_project_and_hash(edited)[2] != normalized_project_and_hash(original)[2]


def test_signed_zero_identity_remains_distinct():
    project = table_project()
    negative = deepcopy(project)
    negative["illumination"]["azimuth_deg"] = -0.0
    project["illumination"]["azimuth_deg"] = 0.0
    assert normalized_project_and_hash(negative)[2] != normalized_project_and_hash(project)[2]
    assert b'"azimuth_deg":-0.0' in encoded(normalized_project_and_hash(negative)[1])


@pytest.mark.filterwarnings("ignore:Pydantic serializer warnings:UserWarning")
def test_models_are_copied_and_revalidated_after_mutation():
    model, normalized, digest = normalized_project_and_hash(table_project())
    copy, copy_json, copy_hash = normalized_project_and_hash(model)
    assert copy is not model and copy.layers[0] is not model.layers[0]
    assert copy_hash == digest and copy_json == normalized
    model.layers[0].cd_y_nm += 1
    assert normalized_project_and_hash(model)[2] != digest
    assert input_hash_2d(model) == normalized_project_and_hash(model)[2]
    assert copy.layers[0].cd_y_nm == normalized["layers"][0]["cd_y_nm"]
    model.layers[0].cd_y_nm = "180"
    with pytest.raises(ValidationError):
        normalized_project_and_hash(model)
    with pytest.raises(ValidationError):
        input_hash_2d(model)


PHYSICAL_PATHS_2D = [
    ("period_nm",), ("period_y_nm",), ("ambient", "n"), ("ambient", "k"),
    ("substrate", "n"), ("substrate", "k"), ("substrate", "wavelengths_nm", 0),
    ("substrate", "n_values", 0), ("substrate", "k_values", 0),
    ("layers", 0, "thickness_nm"), ("layers", 0, "cd_x_nm"), ("layers", 0, "cd_y_nm"),
    ("layers", 0, "material", "n"), ("layers", 0, "material", "k"),
    ("layers", 0, "background", "n"), ("layers", 0, "background", "k"),
    ("illumination", "angle_deg"), ("illumination", "azimuth_deg"),
    ("illumination", "wavelengths_nm", 0), ("solver", "harmonics_x"), ("solver", "harmonics_y"),
]


@pytest.mark.parametrize("path", PHYSICAL_PATHS_2D)
@pytest.mark.parametrize("value", [True, "1"])
def test_nested_numbers_never_coerce_before_identity(path, value):
    project = table_project()
    replace_path(project, path, value)
    with pytest.raises(ValidationError):
        normalized_project_and_hash(project)


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("path", [("period_y_nm",), ("layers", 0, "material", "n"),
                                   ("substrate", "n_values", 0)])
def test_nonfinite_values_never_reach_hashes(path, bad):
    project = table_project()
    replace_path(project, path, bad)
    with pytest.raises(ValueError, match="finite JSON"):
        normalized_project_and_hash(project)
    with pytest.raises(ValueError):
        canonical_hash(project)


@pytest.mark.parametrize("path", [("name",), ("layers", 0, "material", "source"), ("substrate", "name")])
@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
def test_surrogate_values_are_rejected_before_hashing(path, surrogate):
    project = table_project()
    replace_path(project, path, surrogate)
    with pytest.raises(ValueError, match="valid Unicode"):
        normalized_project_and_hash(project)
    with pytest.raises(UnicodeError):
        canonical_hash(project)


def test_surrogate_keys_and_mutated_model_text_are_rejected():
    project = table_project()
    project["substrate"]["\ud800"] = "untrusted"
    with pytest.raises(ValueError, match="valid Unicode"):
        normalized_project_and_hash(project)
    model = parse_project(table_project())
    model.layers[0].material.source = "\ud800"
    with pytest.raises(ValueError, match="valid Unicode"):
        normalized_project_and_hash(model)


def test_default_float_fields_have_the_same_identity_as_explicit_values():
    explicit = small_2d_project()
    explicit["illumination"]["azimuth_deg"] = 0.0
    omitted = deepcopy(explicit)
    del omitted["illumination"]["azimuth_deg"]
    del omitted["layers"][0]["thickness_nm"]
    first = normalized_project_and_hash(omitted)
    assert first[2] == normalized_project_and_hash(explicit)[2]
    assert first[2] == normalized_project_and_hash(first[0])[2]
    assert first[2] == normalized_project_and_hash(first[1])[2]
