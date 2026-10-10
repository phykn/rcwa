#!/usr/bin/env python3
"""Measure the real bounded worker, saved snapshot and SDK stdio envelope.

No reference override is used. Run one invocation at a time with BLAS=1. Optional
--mixed-fit measures one maximum-public legacy fit beside the one 2D worker.
Linux /proc measurements are sampled observations, not deployment guarantees.
"""

import argparse
import hashlib
import json
from importlib import metadata
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from api.jobs import JobManager, retained_size  # noqa: E402
from api.contracts import ServerSnapshot  # noqa: E402
from api.storage import ProjectStore  # noqa: E402
from mcp.server.runner import ServerRunner  # noqa: E402
from mcp.types.version import HANDSHAKE_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS  # noqa: E402
from mcp_adapter.server import create_server, result as mcp_result, stdio_response_bytes  # noqa: E402
from rcwa_core.project_io import normalized_project_and_hash  # noqa: E402
from rcwa_core.schemas import Project  # noqa: E402


def encoded(value):
    return json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def materials(project):
    yield project["ambient"]
    yield project["substrate"]
    for layer in project["layers"]:
        yield layer["material"]
        if "background" in layer:
            yield layer["background"]


def bounded_project(case, tables=False):
    project = {
        "schema_version": "1.2", "name": f"Bounded spawned worker resource {case}",
        "period_nm": 460.0, "period_y_nm": 420.0, "ambient": {"n": 1.0},
        "substrate": {"n": 0.4, "k": 3.1}, "layers": [],
        "illumination": {"angle_deg": 37.0, "azimuth_deg": 25.0,
                         "wavelengths_nm": [450 + i * (400 / 30) for i in range(31)]},
        "solver": {"harmonics_x": 5, "harmonics_y": 5},
    }
    for i in range(8):
        project["layers"].append({
            "geometry": "rectangle_2d", "thickness_nm": 2000.0,
            "cd_x_nm": 100.0 + 37 * i, "cd_y_nm": 90.0 + 35 * i,
            "material": {"n": 10.0 if case == "extreme" else 2.5 + 0.17 * i,
                         "k": 10.0 if case == "extreme" else 0.03 + 0.01 * i},
            "background": {"n": 1 + 0.07 * i, "k": 0.01 + 0.003 * i},
        })
    _, project, _ = normalized_project_and_hash(project)
    if tables:
        wavelengths = [200.0 + i * (2300.0 / 1999) for i in range(2000)]
        for index, material in enumerate(materials(project)):
            n, k = material["n"], material["k"]
            # Long but physical float spellings stress transport bytes. Keep the
            # incident ambient exactly lossless; changes are synthetic inputs.
            n = min(9.999999999999998, n + 1.234567891234e-10)
            k = 0.0 if index == 0 else min(9.999999999999998, k + 1.234567891234e-10)
            material.update(kind="tabulated", wavelengths_nm=wavelengths,
                            n_values=[n] * 2000, k_values=[k] * 2000,
                            source="가상😀" * 166 + "가상", name=f"Synthetic table {index}")
        # Keep every table at the maximum 2000 rows. Shorten only a bounded
        # prefix of wavelength decimal spellings to fit the 2 MB intake cap.
        # Constant n/k columns keep this formatting choice physics-equivalent.
        for shortened in range(0, 2001, 50):
            bounded_wavelengths = [round(w, 6) if i < shortened else w for i, w in enumerate(wavelengths)]
            for material in materials(project):
                material["wavelengths_nm"] = bounded_wavelengths
            if len(encoded({"kind": "forward", "project": project})) <= 1_995_000:
                break
        _, project, _ = normalized_project_and_hash(project)
    request_bytes = len(encoded({"kind": "forward", "project": project}))
    if request_bytes > 2_000_000:
        raise ValueError(f"Table fixture is not request-admissible: {request_bytes} bytes")
    return project


def rss(pid):
    try:
        text = Path(f"/proc/{pid}/status").read_text()
        values = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
        return {key: int(values[key].split()[0]) for key in ("VmRSS", "VmHWM") if key in values}
    except (FileNotFoundError, ProcessLookupError):
        return {}


def snapshot_provenance(job, project):
    result = job["result"]
    return {
        "source": "server_computed", "job_id": job["id"], "input_hash": job["input_hash"],
        "project_schema_version": project["schema_version"], "result_schema_version": result["schema_version"],
        "engine": result["metadata"]["engine"], "engine_version": result["metadata"]["version"],
        "adapter_version": result["metadata"]["adapter_version"],
        "submitted_at": job["created_at"], "completed_at": job["completed_at"],
        "canonicalization": "SHA-256; normalized Project; sorted JSON keys; compact separators; UTF-8; finite numbers",
    }


def snapshot_measurements(snapshot, request_id=1, *, supplied_request_id=False):
    """Use the installed runner's full per-version serialization and stamp.

    These are reproducible wire-size calculations for an existing snapshot,
    before the adapter's bounded-response fallback, not a live transport trace.
    """
    ServerSnapshot.model_validate(snapshot, strict=True)
    call = mcp_result(snapshot)
    server = create_server(SimpleNamespace(url="http://127.0.0.1:8000"))
    # Serialization uses no connection or request dispatch. The pinned SDK's
    # own runner supplies its per-version sieve, resultType and serverInfo stamp.
    runner = ServerRunner(server, None, None)
    versions = {}
    for version in (*HANDSHAKE_PROTOCOL_VERSIONS, *MODERN_PROTOCOL_VERSIONS):
        payload = runner._serialize("tools/call", version, call)
        wire = stdio_response_bytes(payload, request_id)
        versions[version] = {
            "jsonrpc_line_bytes": len(wire), "under_8MB": len(wire) <= 8_000_000,
            "sha256": hashlib.sha256(wire).hexdigest(),
            "server_info_stamp": payload.get("_meta"),
            "result_type": payload.get("resultType"),
        }
    job = {"id": snapshot["provenance"]["job_id"], "kind": "forward", "status": "succeeded",
           "created_at": snapshot["provenance"]["submitted_at"],
           "completed_at": snapshot["provenance"]["completed_at"],
           "input_hash": snapshot["provenance"]["input_hash"], "result": snapshot["result"],
           "error": None, "error_code": None}
    return {
        "measurement_kind": "offline full per-version SDK serialization before bounded-response fallback",
        "request_id": request_id,
        "request_id_source": "caller-supplied; no live request claimed" if supplied_request_id else "synthetic default",
        "sdk_version": metadata.version("mcp"), "wire_versions": versions,
        "result_bytes": len(encoded(snapshot["result"])), "full_snapshot_bytes": len(encoded(snapshot)),
        "snapshot_under_8MB": len(encoded(snapshot)) <= 8_000_000,
        "full_result_post_bytes": len(encoded({"project": snapshot["project"], "result": snapshot["result"]})),
        "project_only_post_bytes": len(encoded({"project": snapshot["project"], "result": None})),
        "snapshot_sha256": hashlib.sha256(encoded(snapshot)).hexdigest(),
        "estimated_project_object_bytes": retained_size(snapshot["project"]),
        "estimated_result_object_bytes": retained_size(snapshot["result"]),
        "estimated_completed_job_input_bytes": retained_size(job, {"project": snapshot["project"], "fit": None}),
        "source_sha256": {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in ("scripts/true_2d_worker_resources.py", "backend/api/jobs.py", "backend/mcp_adapter/server.py",
                         "backend/rcwa_core/project_io.py")
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["high_contrast", "extreme"])
    parser.add_argument("--tables", action="store_true")
    parser.add_argument("--mixed-fit", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--snapshot-file", type=Path, help="Re-measure an existing snapshot without spawning or solving")
    parser.add_argument("--request-id-json", help="JSON string or integer ID for reproducible frame accounting")
    parser.add_argument("--overwrite", action="store_true", help="Explicitly allow replacing this report and sidecars")
    args = parser.parse_args()
    if args.output.exists() and not args.overwrite:
        parser.error("Output exists; choose a new report path to preserve historical measurements")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    request_id = json.loads(args.request_id_json) if args.request_id_json is not None else 1
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        parser.error("Request ID must be a JSON string or integer")
    if args.snapshot_file:
        if args.case or args.tables or args.mixed_fit:
            parser.error("Snapshot re-measurement does not accept computation options")
        snapshot = json.loads(args.snapshot_file.read_text())
        report = snapshot_measurements(snapshot, request_id, supplied_request_id=args.request_id_json is not None)
        report["source_snapshot_file"] = str(args.snapshot_file)
        report["source_snapshot_file_sha256"] = hashlib.sha256(args.snapshot_file.read_bytes()).hexdigest()
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(report, ensure_ascii=False))
        return 0
    if not args.case:
        parser.error("Choose --case for a solve or --snapshot-file for offline accounting")
    for suffix in (".snapshot.json", ".project.json"):
        if args.output.with_suffix(suffix).exists() and not args.overwrite:
            parser.error("Output sidecar exists; choose a new report path")
    project = bounded_project(args.case, args.tables)
    manager = JobManager()
    started = time.monotonic()
    report = {"case": args.case, "tables": args.tables, "mixed_fit": args.mixed_fit,
              "input_hash": normalized_project_and_hash(project)[2],
              "request_bytes": len(encoded({"kind": "forward", "project": project})),
              "table_count": sum(m["kind"] == "tabulated" for m in materials(project)),
              "rows_per_table": 2000 if args.tables else 0,
              "blas_threads": {key: os.environ.get(key) for key in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS")},
              "worker_timeout_seconds": manager.timeout, "processes": {}, "peak_combined_rss_KiB": 0}
    try:
        job = manager.submit("forward", project, None)
        primary = job["id"]
        ids = [primary]
        if args.mixed_fit:
            legacy = Project().model_dump(mode="json")
            legacy["illumination"]["wavelengths_nm"] = [450.0 + 10 * i for i in range(41)]
            legacy["solver"]["harmonics"] = 12
            fit = manager.submit("fit", legacy, {"target_cd_nm": 205.0, "lower_cd_nm": 40.0, "upper_cd_nm": 360.0})
            ids.append(fit["id"])
        active = {job_id: manager.running[job_id] for job_id in ids}
        for job_id, worker in active.items():
            report["processes"][job_id] = {"pid": worker.process.pid, "peak_RSS_KiB": 0, "peak_HWM_KiB": 0}
        while any(manager.jobs[job_id]["status"] == "running" for job_id in ids):
            combined = rss(os.getpid()).get("VmRSS", 0)
            for job_id, entry in report["processes"].items():
                memory = rss(entry["pid"])
                combined += memory.get("VmRSS", 0)
                entry["peak_RSS_KiB"] = max(entry["peak_RSS_KiB"], memory.get("VmRSS", 0))
                entry["peak_HWM_KiB"] = max(entry["peak_HWM_KiB"], memory.get("VmHWM", 0))
            report["peak_combined_rss_KiB"] = max(report["peak_combined_rss_KiB"], combined)
            manager.poll()
            for job_id in ids:
                entry = report["processes"][job_id]
                outcome = manager.jobs[job_id]
                if outcome["status"] != "running" and "status" not in entry:
                    entry.update(status=outcome["status"], error_code=outcome["error_code"],
                                 seconds=time.monotonic() - started)
            time.sleep(0.01)
        job, captured = manager.capture(primary)
        report["status"] = job["status"]
        report["error"] = job["error"]
        if job["status"] == "succeeded":
            assert job["input_hash"] == job["result"]["metadata"]["input_hash"] == report["input_hash"]
            provenance = snapshot_provenance(job, captured["project"])
            with tempfile.TemporaryDirectory(prefix="rcwa-profile-snapshot-") as database:
                url = f"sqlite:///{Path(database) / 'snapshot.db'}"
                store = ProjectStore(url)
                snapshot = store.save(captured["project"], job["result"], provenance=provenance)
                ServerSnapshot.model_validate(snapshot, strict=True)
                assert store.save(captured["project"], job["result"], provenance=provenance) == snapshot
                store.engine.dispose()
                restarted = ProjectStore(url)
                assert restarted.get(snapshot["id"]) == snapshot
                restarted.engine.dispose()
            snapshot_bytes = encoded(snapshot)
            report.update(snapshot_measurements(snapshot, request_id, supplied_request_id=args.request_id_json is not None))
            report.update(
                worker_output_bytes=len(json.dumps({"result": job["result"], "error": None, "error_code": None}, allow_nan=False).encode()),
                sqlite_restart_verified=True,
            )
            args.output.with_suffix(".snapshot.json").write_bytes(snapshot_bytes)
            args.output.with_suffix(".project.json").write_bytes(encoded(project))
        report["cleanup"] = {
            "running": list(manager.running), "pending": list(manager.cleanup_pending), "errors": manager.cleanup_errors,
            "all_process_handles_closed": all(worker.process._closed for worker in active.values()),
            "all_outputs_removed": all(not worker.output.exists() for worker in active.values()),
        }
        report["wall_seconds"] = time.monotonic() - started
    finally:
        directory = Path(manager.directory.name)
        manager.close()
        report["directory_removed"] = not directory.exists()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get("status") == "succeeded" and not manager.cleanup_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
