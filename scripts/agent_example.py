#!/usr/bin/env python3
"""Bounded local HTTP example: compare a finite CD list, save and export its best run.

No backend/core imports, language model, optimizer, or hosted-agent integration.
See docs/agent-api.md. Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import http.client
import json
import math
from pathlib import Path
import signal
import sys
import time
from urllib import error, parse, request

MAX_CANDIDATES = 8
MAX_RESPONSE_BYTES = 8_000_000
OBJECTIVE = {"direction": "maximize", "observable": "R", "polarization": "s", "wavelength_nm": 650.0}


class ExampleError(Exception):
    """A bounded, reportable client failure."""


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


def check_options(candidates, budget, deadline_seconds, request_timeout):
    if isinstance(budget, bool) or not isinstance(budget, int) or not 1 <= budget <= MAX_CANDIDATES:
        raise ValueError(f"Candidate budget must be an integer from 1 to {MAX_CANDIDATES}")
    if not 1 <= len(candidates) <= budget:
        raise ValueError("The explicit candidate list must be nonempty and fit inside the candidate budget")
    if any(isinstance(cd, bool) or not isinstance(cd, (int, float)) or not math.isfinite(cd) for cd in candidates):
        raise ValueError("Every CD candidate must be finite")
    if len(set(candidates)) != len(candidates):
        raise ValueError("CD candidates must be distinct")
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
        budget=3,
        deadline_seconds=180.0,
        request_timeout=10.0,
        clock=time.monotonic,
        sleep=time.sleep,
    ):
        check_options(candidates, budget, deadline_seconds, request_timeout)
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
            "candidates": [{"cd_nm": float(cd), "status": "not_evaluated", "warnings": []} for cd in candidates],
            "status": "running",
            "stop_reason": None,
            "best": None,
            "snapshot": None,
        }
        self.export = None
        self.completed_pairs = {}

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
            self.active_job = response.get("id")
            if self.current is not None and self.active_job:
                self.current["job_id"] = self.active_job
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
        while job.get("status") in {"queued", "running"}:
            self.sleep(min(delay, self.remaining()))
            self.remaining()
            job = self.call("GET", f"/api/jobs/{parse.quote(self.active_job, safe='')}")
            delay = min(2.0, delay * 1.5)
        if job.get("status") not in {"succeeded", "failed", "cancelled"}:
            raise ExampleError(f"Unexpected job status: {job.get('status')!r}")
        self.active_job = None
        return job

    def run(self):
        try:
            self.report["capabilities"] = self.call("GET", "/api/capabilities")
            engine = self.report["capabilities"].get("engine", {})
            if engine.get("available") is not True:
                raise ExampleError(f"Required engine is unavailable: {engine.get('message', engine)}")
            base = self.call("GET", "/api/example")
            # The objective and all other settings remain identical across this finite list.
            base["illumination"]["wavelengths_nm"] = [OBJECTIVE["wavelength_nm"]]
            base["illumination"]["polarization"] = OBJECTIVE["polarization"]
            for record in self.report["candidates"]:
                self.current = record
                self.remaining()
                record["status"] = "validating"  # Invalid/failed trials also consume the candidate budget.
                project = deepcopy(base)
                project["layers"][0]["cd_nm"] = record["cd_nm"]
                validation = self.call("POST", "/api/validate", project)
                record["validation_diagnostics"] = validation.get("diagnostics", [])
                record["warnings"] = [
                    d["message"] for d in record["validation_diagnostics"] if d.get("severity") == "warning"
                ]
                if validation.get("valid") is not True or not isinstance(validation.get("project"), dict):
                    record["status"] = "invalid"
                    raise ExampleError("Invalid configuration; inspect validation_diagnostics before another run")
                record["input_hash"] = validation.get("input_hash")
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
        except (ExampleError, KeyError, TypeError, ValueError) as exc:
            self.report.update(status="stopped", stop_reason=str(exc))
            if isinstance(exc, UnknownPostOutcome):
                self.report["unknown_post_outcome"] = True
            if isinstance(exc, ApiError):
                self.report["api_error"] = {"status": exc.status, "code": exc.code, "response": exc.payload}
                if self.current is not None:
                    structured = exc.payload.get("error") or {}
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
            self.report["best"] = {key: best[key] for key in ("cd_nm", "score", "job_id")}
            self.report["best"]["description"] = "Best among evaluated candidates"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--cd", type=float, nargs="+", default=[140.0, 180.0, 220.0], help="Explicit CD candidates in nm"
    )
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
    if args.output.resolve() == args.report.resolve():
        parser.error("--output and --report must be different files")
    try:
        experiment = Experiment(
            LocalHTTP(args.base_url),
            candidates=args.cd,
            budget=args.max_candidates,
            deadline_seconds=args.deadline_seconds,
            request_timeout=args.request_timeout,
        )
    except ValueError as exc:
        parser.error(str(exc))
    report, exported = experiment.run()
    write_json(args.report, report)
    for record in report["candidates"]:
        print(
            f"CD {record['cd_nm']:g} nm: {record['status']}"
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
        print(f"Best among evaluated candidates: CD={report['best']['cd_nm']:g} nm, R={report['best']['score']:.8g}")
    if exported is not None:
        write_json(args.output, exported)
        print(f"Saved snapshot {report['snapshot']['id']}; import {args.output} in the local UI.")
    elif args.output.exists():
        print(f"No new export was written; existing {args.output} belongs to an earlier run.", file=sys.stderr)
    if report["stop_reason"]:
        print(report["stop_reason"], file=sys.stderr)
    print(f"Full report: {args.report}")
    return 0 if report["status"] == "completed" else (130 if report["status"] == "interrupted" else 1)


if __name__ == "__main__":

    def stop_on_signal(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_signal)
    raise SystemExit(main())
