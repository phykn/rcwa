"""JSON-in/JSON-out glue between the browser engine and rcwa_core.

Every call returns {"ok": true, "value": ...} or {"ok": false, "code", "message"}
so the worker never has to parse Python tracebacks.
"""

import json
import time

from pydantic import ValidationError

from rcwa_core.preflight import PreflightError, SolverError
from rcwa_core.project_io import normalized_project_and_hash, parse_project, preflight_project_any
from rcwa_core.solver_2d import assemble_forward_2d, solve_wavelengths_2d


def _call(fn):
    try:
        return json.dumps({"ok": True, "value": fn()}, allow_nan=False)
    except PreflightError as error:
        first = error.diagnostics[0]
        return json.dumps({"ok": False, "code": first.code, "message": first.message,
                           "diagnostics": [d.model_dump() for d in error.diagnostics]})
    except SolverError as error:
        return json.dumps({"ok": False, "code": "numerical_failure", "message": str(error)})
    except ValidationError as error:
        message = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in error.errors()[:5])
        return json.dumps({"ok": False, "code": "invalid_project", "message": message})
    except (ValueError, TypeError) as error:
        return json.dumps({"ok": False, "code": "invalid_project", "message": str(error)[:400]})


def validate(project_json):
    def run():
        _, normalized, digest = normalized_project_and_hash(json.loads(project_json))
        diagnostics = preflight_project_any(parse_project(normalized))
        return {"project": normalized, "input_hash": digest, "diagnostics": [d.model_dump() for d in diagnostics]}

    return _call(run)


def solve(project_json, indices_json):
    return _call(lambda: solve_wavelengths_2d(parse_project(json.loads(project_json)), json.loads(indices_json)))


def assemble(project_json, partials_json, elapsed_seconds):
    return _call(lambda: assemble_forward_2d(
        parse_project(json.loads(project_json)), json.loads(partials_json), elapsed_seconds=float(elapsed_seconds)
    ))


def forward(project_json):
    def run():
        project = parse_project(json.loads(project_json))
        start = time.perf_counter()
        partials = solve_wavelengths_2d(project, range(len(project.illumination.wavelengths_nm)))
        return assemble_forward_2d(project, partials, elapsed_seconds=time.perf_counter() - start)

    return _call(run)
