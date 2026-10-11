"""One explicit version dispatcher for requests, workers and stored projects.

Missing version remains legacy 1.0. Normalization always copies/revalidates,
including model instances, so mutable objects cannot create another hash form.
"""

from copy import deepcopy
import json
from typing import Annotated

from pydantic import BeforeValidator

from .identity import canonical_hash
from .schemas import Project
from .schemas_2d import Project2D


def parse_project(value, *, strict=True) -> Project | Project2D:
    if isinstance(value, (Project, Project2D)):
        value = value.model_dump(mode="python")
    if not isinstance(value, dict):
        raise ValueError("Project must be a JSON object")
    value = deepcopy(value)
    version = value.get("schema_version", "1.0")
    if not isinstance(version, str) or version not in {"1.0", "1.1", "1.2"}:
        raise ValueError("Unsupported project schema_version; expected 1.0, 1.1 or explicit 1.2")
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise ValueError("Project must contain finite JSON values and valid Unicode") from error
    model = Project2D if version == "1.2" else Project
    # Only historical legacy readers retain permissive numeric decoding.
    return model.model_validate(value, strict=strict or version == "1.2")


def normalized_project_and_hash(value, *, strict=True):
    model = parse_project(value, strict=strict)
    normalized = model.model_dump(mode="json")
    return model, normalized, canonical_hash(normalized)


def _read_project(value):
    return parse_project(value, strict=False)


InputProject = Annotated[Project | Project2D, BeforeValidator(parse_project)]
ProjectDocument = Annotated[Project | Project2D, BeforeValidator(_read_project)]


def preflight_project_any(project):
    project = parse_project(project)
    if isinstance(project, Project2D):
        from .preflight_2d import preflight_2d

        return preflight_2d(project)
    from .preflight import preflight_project

    return preflight_project(project)


def forward_project(project):
    project = parse_project(project)
    if isinstance(project, Project2D):
        from .solver_2d import forward_2d

        return forward_2d(project)
    from .solver import forward

    return forward(project)


def validate_result_for_project(kind, result, project, fit=None):
    model = parse_project(project)
    if isinstance(model, Project2D):
        if kind != "forward" or fit is not None:
            raise ValueError("Schema 1.2 supports forward calculations only")
        from .contracts_2d import PublicForwardResult2D, validate_result_2d

        validated = validate_result_2d(result, model)
        return PublicForwardResult2D.model_validate(validated.model_dump(mode="json"), strict=True)
    from .contracts import validate_result

    return validate_result(kind, result, model.model_dump(mode="json"), fit)
