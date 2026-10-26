#!/usr/bin/env python3
"""Bounded local HTTP example: compare finite 1D CDs or explicit circular-hole diameters.

No backend/core imports, language model, optimizer, or hosted-agent integration.
See docs/agent-api.md. Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
from urllib import error, parse, request

MAX_CANDIDATES = 8
MAX_RESPONSE_BYTES = 8_000_000
OBJECTIVE = {"direction": "maximize", "observable": "R", "polarization": "s", "wavelength_nm": 650.0}
CIRCULAR_EXAMPLE = "circular_hole_2d"
# This example deliberately supports only the named seed's 150 x 140 nm cell.
CIRCULAR_MAX_DIAMETER_NM = 140.0
CIRCULAR_LIMITATIONS = (
    "Synthetic materials, not real HBM data. Hx=Hy=1 is an intentionally small nine-order basis; "
    "convergence is not assessed. Circles use 64 midpoint strips; spatial and harmonic convergence "
    "are separate, and flux balance or geometry area bounds do not certify optical accuracy. "
    "Edited inputs do not inherit the stored example's convergence evidence."
)


def input_hash(project):
    """Public canonical hash of already normalized JSON; no schema/solver imports."""
    raw = json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ExampleError(Exception):
    pass


class DeadlineExceeded(ExampleError):
    pass


class UnknownPostOutcome(ExampleError):
    """The request may have reached the server; it must not be resubmitted."""


class ApiError(ExampleError):
    def __init__(self, status: int, payload: dict):
        self.status, self.payload = status, payload
        structured = payload.get("error")
        self.code = structured.get("code") if isinstance(structured, dict) else None
        super().__init__(f"HTTP {status}: {payload.get('detail', structured or payload)}")


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalHTTP:
    """No redirects, proxies, retries, or non-loopback URLs.

    urllib's timeout limits socket inactivity, not total response wall-clock time.
    The experiment checks its cooperative deadline between requests and sleeps.
    """

    def __init__(self, base_url: str):
        url = parse.urlsplit(base_url)
        if (
            url.scheme != "http"
            or url.hostname not in {"127.0.0.1", "localhost", "::1"}
            or url.username is not None
            or url.password is not None
            or url.path not in {"", "/"}
            or url.query
            or url.fragment
        ):
            raise ValueError("Use a loopback HTTP URL, for example http://127.0.0.1:8000")
        # Also reject malformed/out-of-range ports before any request.
        _ = url.port
        self.base_url = base_url.rstrip("/")
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())

    def request(self, method: str, path: str, body=None, *, timeout: float):
        data = None if body is None else json.dumps(body, allow_nan=False).encode("utf-8")
        req = request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(req, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError("API response exceeds the example's 8 MB limit")
            payload = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            json.dumps(payload, allow_nan=False)
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object from the API")
            return payload
        except error.HTTPError as exc:
            try:
                payload = json.loads(exc.read(MAX_RESPONSE_BYTES))
                if not isinstance(payload, dict):
                    raise ValueError("Expected an error object")
            except (ValueError, UnicodeError):
                payload = {"detail": f"API returned HTTP {exc.code}"}
            raise ApiError(exc.code, payload) from exc
        except (OSError, error.URLError, http.client.HTTPException, ValueError) as exc:
            message = f"{method} {path}: {exc}"
            if method == "POST":
                raise UnknownPostOutcome(message + "; outcome unknown, do not automatically resubmit") from exc
            raise ExampleError(message) from exc


def score_result(result: dict) -> float:
    """Total reflected power at exactly 650 nm, s polarization; never specular R."""
    try:
        if result["result_type"] != "forward":
            raise ValueError("Only a forward result can be scored")
        wavelengths = result["wavelengths_nm"]
        if wavelengths.count(OBJECTIVE["wavelength_nm"]) != 1:
            raise ValueError("Objective wavelength must occur exactly once")
        values = result["spectra"][OBJECTIVE["polarization"]][OBJECTIVE["observable"]]
        if len(values) != len(wavelengths):
            raise ValueError("Spectrum length does not match the wavelength list")
        value = values[wavelengths.index(OBJECTIVE["wavelength_nm"])]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Objective must be a finite power value")
        return float(value)
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        raise ExampleError(f"Cannot score forward result: {exc}") from exc


def check_options(candidates, budget, deadline_seconds, request_timeout, example="legacy_1d"):
    if example not in {"legacy_1d", CIRCULAR_EXAMPLE}:
        raise ValueError("Choose legacy_1d or circular_hole_2d; arbitrary templates are unsupported")
    if isinstance(budget, bool) or not isinstance(budget, int) or not 1 <= budget <= MAX_CANDIDATES:
        raise ValueError(f"Candidate budget must be an integer from 1 to {MAX_CANDIDATES}")
    if not 1 <= len(candidates) <= budget:
        raise ValueError("The explicit candidate list must be nonempty and fit inside the candidate budget")
    if any(isinstance(cd, bool) or not isinstance(cd, (int, float)) or not math.isfinite(cd) for cd in candidates):
        raise ValueError("Every CD candidate must be finite")
    if len(set(candidates)) != len(candidates):
        raise ValueError("CD candidates must be distinct")
    if example == CIRCULAR_EXAMPLE and any(not 0 <= diameter <= CIRCULAR_MAX_DIAMETER_NM for diameter in candidates):
        raise ValueError("Circular diameters must be between 0 and 140 nm for the named example")
    if not math.isfinite(deadline_seconds) or not 0 < deadline_seconds <= 600:
        raise ValueError("Overall deadline must be greater than zero and at most 600 seconds")
    if not math.isfinite(request_timeout) or not 0 < request_timeout <= 30:
        raise ValueError("Per-request timeout must be greater than zero and at most 30 seconds")


class Experiment:
    def __init__(
        self,
        client,
        *,
        candidates,
        example="legacy_1d",
        budget=3,
        deadline_seconds=180.0,
        request_timeout=10.0,
        clock=time.monotonic,
        sleep=time.sleep,
    ):
        check_options(candidates, budget, deadline_seconds, request_timeout, example)
        self.circular = example == CIRCULAR_EXAMPLE
        self.candidate_key = "diameter_nm" if self.circular else "cd_nm"
        self.client, self.clock, self.sleep = client, clock, sleep
        self.deadline_seconds, self.request_timeout = deadline_seconds, request_timeout
        self.deadline = clock() + deadline_seconds
        self.active_job = None
        self.current = None
        self.post_in_flight = None
        self.report = {
            "objective": dict(OBJECTIVE),
            "claim": "Best among evaluated candidates only; no convergence or manufacturing-feasibility certification.",
            "budget": budget,
            "deadline_seconds": deadline_seconds,
            "request_timeout_seconds": request_timeout,
            "deadline_kind": "Cooperative checks between requests and sleeps; not a hard wall-clock guarantee",
            "request_timeout_kind": "Socket inactivity timeout; a trickled response can exceed the work deadline",
            "candidates": [{self.candidate_key: float(cd), "status": "not_evaluated", "warnings": []}
                           for cd in candidates],
            "status": "running",
            "stop_reason": None,
            "best": None,
            "snapshot": None,
        }
        self.export = None
        self.completed_pairs = {}
        if self.circular:
            self.report.update(example=example, varied_input="layers[0].diameter_nm",
                               solver={"harmonics_x": 1, "harmonics_y": 1}, limitations=CIRCULAR_LIMITATIONS)

    def remaining(self):
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise DeadlineExceeded("Overall deadline reached; remaining candidates were not evaluated")
        return remaining

    def call(self, method, path, body=None):
        timeout = min(self.request_timeout, self.remaining())
        self.post_in_flight = path if method == "POST" else None
        try:
            response = self.client.request(method, path, body, timeout=timeout)
        except ApiError:
            self.post_in_flight = None  # A definitive HTTP rejection is not an ambiguous submission.
            raise
        self.post_in_flight = None
        # Keep a returned job ID before checking the clock, so a late accepted job can be cancelled.
        if method == "POST" and path == "/api/jobs" and isinstance(response, dict):
            job_id = response.get("id")
            if isinstance(job_id, str) and job_id:
                self.active_job = job_id
                if self.current is not None:
                    self.current["job_id"] = job_id
        self.remaining()
        return response

    def cancel_active(self):
        if not self.active_job:
            return
        job_id, self.active_job = self.active_job, None
        # One bounded best-effort cleanup request is allowed after the work deadline.
        try:
            cancelled = self.client.request(
                "DELETE", f"/api/jobs/{parse.quote(job_id, safe='')}", timeout=min(self.request_timeout, 5.0)
            )
            self.report["cancellation"] = {"job_id": job_id, "status": cancelled.get("status")}
        except (ExampleError, KeyboardInterrupt) as exc:
            self.report["cancellation"] = {"job_id": job_id, "status": "unconfirmed", "error": str(exc)}

    def poll(self, job):
        delay = 0.1
        self.check_job_binding(job)
        while job.get("status") in {"queued", "running"}:
            self.sleep(min(delay, self.remaining()))
            self.remaining()
            job = self.call("GET", f"/api/jobs/{parse.quote(self.active_job, safe='')}")
            self.check_job_binding(job)
            delay = min(2.0, delay * 1.5)
        if job.get("status") not in {"succeeded", "failed", "cancelled"}:
            raise ExampleError(f"Unexpected job status: {job.get('status')!r}")
        self.active_job = None
        return job

    def check_job_binding(self, job):
        if self.circular and (
            job.get("id") != self.active_job or job.get("kind") != "forward"
            or job.get("input_hash") != self.current["input_hash"]
        ):
            raise ExampleError("Job ID, kind or input hash differs from the validated circular candidate")

    def check_result_binding(self, result, record):
        if self.circular and (
            not isinstance(result, dict) or result.get("schema_version") != "1.2"
            or not isinstance(result.get("metadata"), dict)
            or result.get("metadata", {}).get("input_hash") != record["input_hash"]
            or result.get("wavelengths_nm") != [OBJECTIVE["wavelength_nm"]]
            or set(result.get("spectra", {})) != {OBJECTIVE["polarization"]}
        ):
            raise ExampleError("Result differs from the circular candidate's exact input, wavelength or polarization")

    def run(self):
        try:
            self.report["capabilities"] = self.call("GET", "/api/capabilities")
            engine = self.report["capabilities"].get("engine", {})
            if engine.get("available") is not True:
                raise ExampleError(f"Required engine is unavailable: {engine.get('message', engine)}")
            path = f"/api/example?example={CIRCULAR_EXAMPLE}" if self.circular else "/api/example"
            base = self.call("GET", path)
            if self.circular:
                layers = base.get("layers")
                if (base.get("schema_version") != "1.2" or not isinstance(layers, list) or not layers
                        or not isinstance(layers[0], dict) or layers[0].get("geometry") != CIRCULAR_EXAMPLE
                        or base.get("period_nm") != 150.0 or base.get("period_y_nm") != 140.0):
                    raise ExampleError("The named circular example no longer matches this bounded recipe")
                base["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
            # The objective and all other settings remain identical across this finite list.
            base["illumination"]["wavelengths_nm"] = [OBJECTIVE["wavelength_nm"]]
            base["illumination"]["polarization"] = OBJECTIVE["polarization"]
            for record in self.report["candidates"]:
                self.current = record
                self.remaining()
                record["status"] = "validating"  # Invalid/failed trials also consume the candidate budget.
                project = deepcopy(base)
                project["layers"][0][self.candidate_key] = record[self.candidate_key]
                validation = self.call("POST", "/api/validate", project)
                record["validation_diagnostics"] = validation.get("diagnostics", [])
                record["warnings"] = [
                    d["message"] for d in record["validation_diagnostics"] if d.get("severity") == "warning"
                ]
                if validation.get("valid") is not True or not isinstance(validation.get("project"), dict):
                    record["status"] = "invalid"
                    raise ExampleError("Invalid configuration; inspect validation_diagnostics before another run")
                record["input_hash"] = validation.get("input_hash")
                if self.circular and (input_hash(validation["project"]) != input_hash(project)
                                      or record["input_hash"] != input_hash(validation["project"])):
                    raise ExampleError("Normalized circular input or hash differs from the requested candidate")
                record["status"] = "submitting"
                job = self.call("POST", "/api/jobs", {"kind": "forward", "project": validation["project"]})
                if not isinstance(job.get("id"), str) or not job["id"]:
                    raise UnknownPostOutcome("Job submission returned no usable ID; do not automatically resubmit")
                record["job_id"], record["status"] = job["id"], "running"
                job = self.poll(job)
                record["status"] = job["status"]
                if job["status"] == "succeeded":
                    result = job.get("result")
                    if isinstance(result, dict):
                        record["warnings"] = list(dict.fromkeys(record["warnings"] + result.get("warnings", [])))
                    try:
                        self.check_result_binding(result, record)
                        record["score"] = score_result(result)
                        self.completed_pairs[record["job_id"]] = {"project": validation["project"], "result": result}
                    except ExampleError as exc:
                        record.update(status="failed", error=str(exc))
                        raise
                else:
                    record["error"] = job.get("error")
                    record["error_code"] = job.get("error_code")
                    code = job.get("error_code", "")
                    if code in {"engine_unavailable", "engine_version_mismatch", "invalid_input", "unsupported_scope"}:
                        raise ExampleError(f"Configuration/engine failure: {code}")
            self.current = None
            self.select_best()
            if self.report["best"] is None:
                raise ExampleError("No candidate produced a scoreable successful forward result")
            saved = self.call("POST", "/api/snapshots", {"job_id": self.report["best"]["job_id"]})
            snapshot_id = saved.get("id")
            if not isinstance(snapshot_id, str) or not snapshot_id:
                raise UnknownPostOutcome("Snapshot save returned no usable ID; do not automatically resubmit")
            self.report["snapshot"] = {"id": snapshot_id}
            stored = self.call("GET", f"/api/projects/{parse.quote(snapshot_id, safe='')}")
            fetched_pair = {"project": stored["project"], "result": stored["result"]}
            if fetched_pair != self.completed_pairs[self.report["best"]["job_id"]]:
                raise ExampleError("Fetched snapshot differs from the selected normalized input/result pair")
            provenance = stored.get("provenance") or {}
            if (
                provenance.get("source") != "server_computed"
                or provenance.get("job_id") != self.report["best"]["job_id"]
            ):
                raise ExampleError("Fetched snapshot lacks matching server-owned job provenance")
            if self.circular and (stored.get("id") != snapshot_id
                                  or provenance.get("input_hash") != input_hash(fetched_pair["project"])):
                raise ExampleError("Fetched snapshot ID or provenance hash differs from the selected circular input")
            self.report["snapshot"] = {"id": snapshot_id, "provenance": provenance}
            self.export = fetched_pair
            self.report["status"] = "completed"
        except KeyboardInterrupt:
            self.report.update(status="interrupted", stop_reason="Interrupted; no further candidates were submitted")
            if self.post_in_flight:
                self.report["unknown_post_outcome"] = True
                self.report["stop_reason"] += f". POST {self.post_in_flight} outcome unknown; do not resubmit blindly"
            if self.current is not None and self.current["status"] in {"validating", "submitting", "running"}:
                self.current["status"] = "interrupted"
        except (ExampleError, KeyError, TypeError, ValueError, AttributeError, IndexError) as exc:
            self.report.update(status="stopped", stop_reason=str(exc))
            if isinstance(exc, UnknownPostOutcome):
                self.report["unknown_post_outcome"] = True
            if isinstance(exc, ApiError):
                self.report["api_error"] = {"status": exc.status, "code": exc.code, "response": exc.payload}
                if self.current is not None:
                    structured = exc.payload.get("error")
                    structured = structured if isinstance(structured, dict) else {}
                    self.current["error_code"] = exc.code
                    self.current["validation_diagnostics"] = structured.get("diagnostics", [])
            if self.current is not None and self.current["status"] in {"validating", "submitting", "running"}:
                self.current.update(status="failed", error=str(exc))
        finally:
            self.cancel_active()
            self.select_best()
        return self.report, self.export

    def select_best(self):
        successful = [r for r in self.report["candidates"] if r["status"] == "succeeded" and "score" in r]
        self.report["evaluated_count"] = len(successful)
        self.report["attempted_count"] = sum(r["status"] != "not_evaluated" for r in self.report["candidates"])
        if successful:
            best = max(successful, key=lambda record: record["score"])
            self.report["best"] = {key: best[key] for key in (self.candidate_key, "score", "job_id")}
            self.report["best"]["description"] = "Best among evaluated candidates"


def write_json(path, value):
    # Serialize before touching the destination; replacement is atomic per file,
    # not a transaction across the separate report and export.
    payload = json.dumps(value, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def check_output_paths(output, report):
    resolved = [path.resolve() for path in (output, report)]
    if resolved[0] == resolved[1] or (output.exists() and report.exists() and output.samefile(report)):
        raise ValueError("--output and --report must be different files")
    if resolved[0] in resolved[1].parents or resolved[1] in resolved[0].parents:
        raise ValueError("--output and --report cannot be each other's parent directory")
    for path in resolved:
        if path.is_dir():
            raise ValueError(f"Output destination is a directory: {path}")
        if any(parent.exists() and not parent.is_dir() for parent in path.parents):
            raise ValueError(f"Output destination has a non-directory parent: {path}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--example", choices=["legacy_1d", CIRCULAR_EXAMPLE], default="legacy_1d",
                        help="Named API seed; default keeps the original 1D behavior")
    parser.add_argument(
        "--cd", type=float, nargs="+", help="Legacy 1D CD candidates in nm (default: 140 180 220)"
    )
    parser.add_argument("--diameters", type=float, nargs="+",
                        help="Circular top-layer diameters, 0–140 nm (default: 45 65 85); requires circular_hole_2d")
    parser.add_argument(
        "--max-candidates", type=int, default=3, help=f"Budget including failures; hard limit {MAX_CANDIDATES}"
    )
    parser.add_argument(
        "--deadline-seconds", type=float, default=180.0, help="Cooperative work deadline, at most 600 s"
    )
    parser.add_argument("--request-timeout", type=float, default=10.0, help="Socket inactivity timeout, at most 30 s")
    parser.add_argument("--output", type=Path, default=Path("artifacts/agent-best.json"), help="UI-compatible export")
    parser.add_argument(
        "--report", type=Path, default=Path("artifacts/agent-report.json"), help="Every trial and warning"
    )
    args = parser.parse_args(argv)
    if args.example == CIRCULAR_EXAMPLE:
        if args.cd is not None:
            parser.error("--cd is only for legacy_1d; use --diameters with circular_hole_2d")
        candidates = args.diameters if args.diameters is not None else [45.0, 65.0, 85.0]
    else:
        if args.diameters is not None:
            parser.error("--diameters requires --example circular_hole_2d")
        candidates = args.cd if args.cd is not None else [140.0, 180.0, 220.0]
    try:
        check_output_paths(args.output, args.report)
        experiment = Experiment(
            LocalHTTP(args.base_url),
            candidates=candidates,
            example=args.example,
            budget=args.max_candidates,
            deadline_seconds=args.deadline_seconds,
            request_timeout=args.request_timeout,
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    report, exported = experiment.run()
    export_written, report_written = False, False
    if exported is not None:
        try:
            write_json(args.output, exported)
            export_written = True
        except (OSError, ValueError) as exc:
            report.update(status="stopped", stop_reason=f"Could not write export {args.output}: {exc}")
    try:
        write_json(args.report, report)
        report_written = True
    except (OSError, ValueError) as exc:
        report.update(status="stopped", stop_reason=f"Could not write report {args.report}: {exc}")
    label, key = ("Top diameter", "diameter_nm") if args.example == CIRCULAR_EXAMPLE else ("CD", "cd_nm")
    if report.get("limitations"):
        print(report["limitations"])
    for record in report["candidates"]:
        print(
            f"{label} {record[key]:g} nm: {record['status']}"
            + (f", R={record['score']:.8g}" if "score" in record else "")
        )
        for warning in record["warnings"]:
            print(f"  Warning: {warning}")
        if record.get("error"):
            print(f"  Failure: {record['error']}")
        for diagnostic in record.get("validation_diagnostics", []):
            if diagnostic.get("severity") == "error":
                print(f"  {diagnostic.get('code')}: {diagnostic.get('message')}")
    if report["best"]:
        print(f"Best among evaluated candidates: {label}={report['best'][key]:g} nm, R={report['best']['score']:.8g}")
    if export_written:
        print(f"Saved snapshot {report['snapshot']['id']}; import {args.output} in the local UI.")
    elif args.output.exists():
        print(f"No new export was written; existing {args.output} belongs to an earlier run.", file=sys.stderr)
    if report["stop_reason"]:
        print(report["stop_reason"], file=sys.stderr)
        if report["snapshot"]:
            print(f"Saved snapshot ID {report['snapshot']['id']}; retrieve it with GET /api/projects/"
                  f"{parse.quote(report['snapshot']['id'], safe='')}. No new solve or save is needed.", file=sys.stderr)
        elif report["best"]:
            print(f"Keep original job ID {report['best']['job_id']}. Recover a possible save by provenance.job_id "
                  "using GET /api/projects?view=index; do not resubmit a job or save blindly.", file=sys.stderr)
    if report_written:
        print(f"Full report: {args.report}")
    return 0 if report["status"] == "completed" else (130 if report["status"] == "interrupted" else 1)


if __name__ == "__main__":

    def stop_on_signal(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_signal)
    raise SystemExit(main())
