"""Explicit, bounded projections of validated records; never replacement results.

No numerical quantities are recomputed. Full records remain stored and available
through the existing routes. Warning entries are never cut mid-message: any
omission is counted explicitly, requiring the caller to inspect the full record.
"""

from copy import deepcopy
import json

from .contracts import (
    ForwardResultSummary, JobSummary, SnapshotReceipt, SnapshotSummary, SyntheticFitResultSummary,
    MAX_SUMMARY_BYTES as MAX_SUMMARY_BYTES, MAX_SUMMARY_WARNING_BYTES as MAX_SUMMARY_WARNING_BYTES,
    MAX_SUMMARY_WARNINGS as MAX_SUMMARY_WARNINGS,
)
from rcwa_core.project_io import normalized_project_and_hash

class SummaryUnavailable(ValueError):
    """The stored record cannot provide a complete, bounded totals projection."""


def _warnings(warnings):
    if not isinstance(warnings, list) or not all(isinstance(warning, str) for warning in warnings):
        raise SummaryUnavailable("Result warnings are not a list of strings")
    kept = []
    for warning in warnings[:MAX_SUMMARY_WARNINGS]:
        candidate = [*kept, warning]
        if len(json.dumps(candidate, ensure_ascii=False).encode("utf-8")) > MAX_SUMMARY_WARNING_BYTES:
            break
        kept = candidate
    return {"warnings": kept, "warnings_omitted_count": len(warnings) - len(kept)}


def forward_summary(result):
    try:
        if result.get("result_type", "forward") != "forward":
            raise ValueError("Expected a forward result")
        summary = ForwardResultSummary.model_validate({
            "summary_schema_version": "rcwa-forward-summary/1.0",
            "source_result_schema_version": result["schema_version"],
            "result_type": "forward",
            "input_hash": result.get("metadata", {}).get("input_hash"),
            "wavelengths_nm": deepcopy(result["wavelengths_nm"]),
            "spectra": {
                polarization: {key: deepcopy(series[key]) for key in ("R", "T", "R_specular", "T_specular", "A_balance")}
                for polarization, series in result["spectra"].items()
            },
            **_warnings(result["warnings"]),
        }, strict=True)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise SummaryUnavailable("Result does not have supported, finite wavelength-aligned totals") from error
    return summary.model_dump(mode="json")


def result_summary(result):
    if result is None:
        return None
    if result.get("result_type") == "synthetic_fit":
        return SyntheticFitResultSummary.model_validate({
            "summary_schema_version": "rcwa-fit-summary/1.0",
            **{key: result[key] for key in ("result_type", "status", "fit_cd_nm", "target_cd_nm", "rmse", "nfev")},
            "prediction": forward_summary(result["prediction"]),
            "target": forward_summary(result["target"]),
            **_warnings(result["warnings"]),
        }, strict=True).model_dump(mode="json")
    return forward_summary(result)


def _bounded(model):
    payload = model.model_dump(mode="json")
    if len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_SUMMARY_BYTES:
        raise SummaryUnavailable("Summary exceeds its 128 KB limit; request the full record through its existing route")
    return payload


def summarize_job(job):
    return _bounded(JobSummary.model_validate({
        **{key: value for key, value in job.items() if key != "result"},
        "view": "summary", "result_summary": result_summary(job["result"]),
    }, strict=True))


def summarize_snapshot(saved, *, receipt=False):
    model = SnapshotReceipt if receipt else SnapshotSummary
    try:
        _, _, input_hash = normalized_project_and_hash(saved["project"], strict=False)
        return _bounded(model.model_validate({
            **{key: value for key, value in saved.items() if key not in {"project", "result"}},
            "view": "receipt" if receipt else "summary",
            "status": "stored",
            "input_hash": input_hash,
            "result_summary": result_summary(saved["result"]),
        }, strict=True))
    except SummaryUnavailable:
        raise
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise SummaryUnavailable("Saved record cannot provide a supported bounded totals projection; use its full route") from error
