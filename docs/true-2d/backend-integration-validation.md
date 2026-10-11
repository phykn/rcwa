# Backend-only schema 1.2 integration verification

Status: numerical audit, initial live CI reference/browser checks and refreshed
local resource/full-suite gates passed. The initial held-open-stdin shutdown race
has a deterministic regression and correction. Corrected exact-candidate CI
acceptance remains pending. This document does not approve publication.

## Source identity and scope

- Accepted first-use release: `d89f066885abde585ba4d7660b6bc0a84187a225`,
  tree `f87fa6d2d8b524283fe990a7325cf95c91facc45`.
- The separate integration branch starts from local `2d21140989655f97dc3bacb6e3021879f1ba8da2`,
  whose tree is identical to that release.
- Shared numerical/core checkpoint: `d2c00e55a699e75b58cc20de69d0f148718dc0c2`.
- Backend/transport checkpoint: `6ba8f0406a9e426434bc6a008104ab2fb7650882`.
- All pre-existing `backend/rcwa_core` files and every frontend file remain
  byte-identical to the accepted first-use release. Core additions share one
  project parser, canonical hash and version dispatch; there is one JobManager,
  one database and one thin HTTP-backed MCP adapter.

The frozen numerical module retains its historical "offline / awaiting integration"
docstrings from the numerical-only stage. The approved backend-first plan and
the checked `project_io` entry point now define admission; those old comments do
not mean reference overrides or UI support are exposed. This wording is a known
nonfunctional cleanup item for the next numerical-source refresh, rather than a
reason to relabel an existing generation's source fingerprint.

Explicit schema 1.2 supports forward calculation, validation, polling, cancellation,
snapshot save and import/reload. The frontend, example/default, fitting and change
proposals retain their released scope. Numerical success never certifies arbitrary
edited inputs as converged. The synthetic fixture is not a calibrated HBM device.

## Identity and public contracts

Six exact legacy 1.0/1.1 Unicode/signed-zero fixtures were generated from the
accepted release before integration edits. Shared canonicalization preserves its
sorted compact UTF-8 finite JSON representation without Unicode/numeric
normalization. Missing project version remains 1.0. Only explicit string `1.2`
selects the new model, whose layer geometry tags must all be explicit.

Strict integer runtime validation intentionally rejects `harmonics: 3.0` although
JSON Schema treats mathematically integral numbers as integers. Generated
OpenAPI/MCP schemas, runtime tests and descriptions expose this exception. Public
results are bound to the exact normalized input, requested axes, wavelengths,
polarizations, complete integer order lattice, production factorization and
actual adapter version. Reference overrides remain inaccessible through requests.

## Fresh numerical evidence

The current default/dense archive is `default-convergence-evidence.tar.gz`,
8,322,017 bytes, SHA-256
`8aeebeef8a85ef203c902952a3b9e3906b3ff5b6ed235ab8fba71f4a1faa8a2d`.
It contains 973 indexed files, 438 freshly generated accepted basis samples and
401 source-bound exploratory H3 samples. All 839 complete component arrays round
trip losslessly through NPZ packaging. The 21 default and 40 dense records cover
60 unique wavelengths. Three physical perturbations remain larger than observed
numerical discrepancies. No earlier sample cache was relabelled or imported.

All four outgoing s/p components, integer orders, totals, signed residuals and
summed added-order tails are retained. Fixed absolute thresholds remain 5e-4 for
each successive refinement and 2e-3 for shipped H5 versus converged independent
S4. Worst default production refinements are 2.55349e-6 and 1.09484e-6; S4
refinements are 3.04785e-5 and 2.00924e-5. Worst default H5/S4-H9 difference is
7.17488e-5. Dense equivalents are 2.54600e-6 / 1.09169e-6, 2.75574e-5 /
1.80947e-5 and 6.38935e-5. Ordinary full21 H5 output passes the public/shared
binder and exactly replays archived per-wavelength powers.

The synthetic subwavelength default has only specular propagating output. Separate
fresh production fixtures cover ten open channels with non-air ambient and an
unequal-axis absorbing eight-layer stack. Their shipped/reference discrepancies
are 9.82203e-6 and 6.67798e-5, with both refinement steps passing unchanged bounds.
The latter retains nonzero absorbing added-order tails. The distinct same-Laurent
channel/port diagnostic reaches 2.68230e-13; it is not production convergence.

See `integration-numerical-delivery.json`, `default-evidence-package.json`,
`integration-default-exact-replay.json`, `integration-engine-provenance.json` and
`integration-representative-generation.json` for hashes, exact inputs, immutable
generation IDs, source/dependency binding and verified byte-identical reference
binary reuse. Historical source/archive remain unchanged in their original
checkpoint; `validation.md` is explicitly labelled as that historical report.
The independent audit is preserved in `independent-integration-numerical-review.md`.
It recomputed all 919,632 signed comparison/tail values, all feature windows and
sampled extrema, with no numerical blocker.

## Process and memory bounds

There are two total numerical slots, at most one for any explicit 1.2 input,
including planar inputs. Admission, completion, cancellation and snapshot capture
are atomic. Deadline means observation/acceptance time: a result is not committed
at or after the monotonic deadline, including time spent validating/sizing it.
Failed starts, partial output, result tampering, cleanup exceptions and concurrent
terminal transitions have deterministic regression coverage.

Completed history has a 100-record cap plus a 64,000,000-byte recursive Python
object-size estimate, including captured inputs. Sizes are cached once per
terminal record; oldest evictable completed records and inputs are removed
together. A real maximum-table payload test inserts ten validated completed
outputs without rerunning physics: each estimates 8,555,379 bytes, retaining only
the newest seven at 59,887,653 bytes. Persisted snapshots survive eviction/restart.
An individually oversized successful result becomes a `history_limit` failure.

The byte bound applies after cleanup to evictable completed history. Protected
terminal records can temporarily exceed it while owning resources. Unreaped
children still consume slots; cleanup-pending records block further admission.
This is not a total-RSS cap, nor a bound on concurrent serialization copies.

Final-source maximum-table H5/31-wavelength/eight-layer cases succeeded in 34.01 s
and 33.70 s. The first ran alongside a bounded legacy H12/41-wavelength fit,
which succeeded in 5.58 s; their sampled API-plus-children peak was 400,260 KiB
(390.88 MiB). Peak 2D-child RSS was 151,384 KiB and 153,080 KiB respectively.
Both verified output binding, SQLite idempotence/restart, all owned handles closed,
outputs removed and temporary directories removed. These cases test resource and
transport behavior; they are not independently converged physical fixtures.

`backend-resource-evidence.tar.gz` retains both complete inputs/snapshots, all
reports, source/dependency manifest and full-suite XML/log. Its SHA-256 is
`9a29ffa6da133fa3ae4d87694389e4c1fb908c73f6eba5075f452adadc4953e8`;
`backend-resource-evidence.json` indexes the package and watchdog result.

## HTTP and MCP transport limits

The existing incoming HTTP cap stays 2,000,000 bytes. A real maximum-table compact
full-result import is 4,233,784 bytes and returns structured 413 before persistence;
its project-only form is 1,993,455 bytes and remains usable. Save by succeeded job
ID avoids resubmitting large powers. Known persisted snapshots have the existing
HTTP GET retrieval path.

MCP enforces 8,000,000 bytes on the actual SDK-serialized UTF-8 JSON-RPC line,
including request ID, escape expansion, duplicated text/structured results,
version-dependent fields/serverInfo and newline. The fixed maximum-table transport-regression
snapshot is 4,234,489 HTTP bytes but 8,983,931 legacy MCP bytes and 8,984,046 modern
MCP bytes. It produces a small `response_too_large` error, never truncated powers.
A mutation sets `outcome_unknown` and says not to blindly resubmit.

The error directs callers to existing HTTP save-by-job-ID while the volatile job
is retained. After expiry/restart, existing latest-100 project summaries expose
`provenance.job_id` for finding the snapshot ID. Retain IDs for older records. An
MCP-only client cannot retrieve a complete payload blocked by its tool response
limit; the recovery instructions do not claim otherwise.

Protocol IDs are limited to 1,024 serialized UTF-8 JSON bytes. Oversized IDs close
stdio before any tool/API invocation, with no truncation or oversized echo. The
pinned SDK's standard input read otherwise uses a non-daemon AnyIO thread:
abandoning its coroutine alone cannot guarantee process shutdown. A small
readline wrapper now uses one daemon read while preserving the SDK's private
descriptor ownership/diversion, parser and writer. The private descriptor is
never closed or recycled under a blocked read. A cancelled read lasts only until
this standalone adapter process exits; it does not alter the global thread pool.
The real-process regression observes entry into the next blocking read before
releasing the oversized-ID rejection, and checks empty stdout/stderr, clean exit,
no API mutation and fresh-client recovery. Windows execution of the same cases
is required before acceptance.

Initial remote candidate `8aed11d0fae320a27d6c2905ca888923871200d5`
(tree `2589d542efb5eba36cb68aac0505233327f49fd1`) ran Checks
`38096261712`. Frontend, all browser suites and live S4 checks passed. Linux reported 1,425 passed,
one optional-watchdog skip and one held-stdin exit timeout; Windows also failed
its new transport suite. These failures are retained as failed evidence, not
rerun away. The transport-only correction leaves numerical core and archives
byte-identical. The original resource bundle remains in commit `0a7a317c`;
the newly generated package above supersedes its transport acceptance.

MCP local diagnostics now share the HTTP 50-diagnostic/512-byte message-and-location
policy. The diagnostic payload stays below 64 KB; its duplicated MCP representation
can be about 98 KB and is still subject to the complete wire cap.

## Executed checks

These counts overlap and must not be added together.

- Complete final local backend suite: **1,424 passed, three PostgreSQL-service
  skips**, 257.30 s, with `RCWA_RUN_120S_WATCHDOG=1`. Actual watchdog passed in
  120.35 s, actual spawned full-default H5 in 8.20 s and direct full-default H5 in
  7.76 s. All fresh archive/core/dependency checks passed. Source hashes remained
  unchanged throughout probes and tests. JUnit is retained in the resource package.
- Broad lightweight backend pass: 1,358 passed, three PostgreSQL-service skips,
  two heavy cases deselected; old numerical archive/default tests were held for
  fresh generation, and transport cases were run separately.
- Pre-fix full transport plus lightweight worker/history pass: 121 passed,
  two heavy cases deselected. All 48 transport boundary/recovery cases passed.
- New shared dispatch/identity/API/MCP suites: 349 passed, one PostgreSQL skip;
  four subsequently added stored-record integrity cases also pass.
- Corrected deterministic transport suite: 48 passed in 52.24 s. Independent
  reviewer reran 20 forced-read ID tests, plus 30 private-wrapper cancellation
  stress subprocesses. The old reader fails the same forced-read negative control
  until the parent closes stdin. No timeout or numerical threshold was relaxed.
- Unchanged frontend: 205 tests passed, ESLint passed, production/static builds
  passed. The pre-existing bundle-size warning remains informational.
- Ruff, whitespace checks and `pip check` passed. The full-suite XML run also
  emitted a test-framework `record_property`/xunit2 warning; the property and
  test result remain in the XML. It does not indicate a solver/runtime failure.
- Actual local HTTP agent-example candidate calculation/save passed.
- Local browser suites could not launch Chromium because process-singleton
  `socket()` was denied. An identical supported-escalation retry also failed.
  No page assertions or screenshots from these attempts count as passing evidence.
  No further local browser attempts are made; exact-commit CI must run every suite.
- Initial CI browser artifact: 173 files, seven passing suites with 92 checks,
  no page errors; ten representative mobile/desktop images independently inspected.
  ZIP SHA-256 `0330b92bd8b867ffac9a80a77900471e551f634ef06525942698d4b48392369c`.
  This intermediate artifact is bound to `8aed11d0`, not the corrected candidate.
- Initial live S4 artifact: all 29,184 signed 2D gate residual/tail values replay
  exactly; production values match archived evidence. Fresh official Makefile/RNP
  S4 reference values differ from the local BLAS/LAPACK build by at most 2.07e-10.
  Both unchanged convergence gates pass; Laurent worst 2.87e-13. The builds are
  explicitly distinct, not claimed byte-identical. Corrected CI must rerun them.
- Windows CI now retains pytest JUnit and console-log artifacts even on failure,
  preserving the test exit status. The first run's specialized Windows log fetch
  failed in two independent connector sessions; its overall failure remains held.

## Remaining release gates

1. Final exact-candidate independent review, including the completed resource
   package. Numerical archive audit is already approved.
2. One immutable candidate must pass all GitHub Checks: PostgreSQL backend,
   Windows MCP, independent reference, frontend and all live/static browser suites.
   Preserve screenshot/report binding to that exact candidate.

Pinned-S4 CI now runs the existing legacy checks, the 2D Laurent channel/port
control and both genuine production refinement/reference fixtures. Its timeout is
15 minutes; timeout is failure, never permission to relax numerical thresholds.
The full default/dense archive is not regenerated on every push when byte, core,
dependency and input binding remain unchanged. Every CI run audits that binding
and executes actual H5 regression. A changed bound source/dependency/reference
formulation/input requires fresh full evidence. Laurent agreement remains a
mapping diagnostic, not a substitute for production convergence.
