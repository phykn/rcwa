# Exact-commit Pages delivery

The release process remains: publish a candidate on `test/*`, pass the complete
Checks workflow, independently review that exact candidate (including numerical
and rendered browser evidence), then deliberately promote the **same commit** to
`main`. Nothing in the Pages workflow changes `main` or establishes that review
happened. Repository write access and that review/promotion process are the trust
boundary; a branch prefix is only an eligibility filter.

## Two deployment paths, one set of checks

- A `main` push can immediately build Pages when the same SHA already has trusted
  successful test-branch Checks evidence. The duplicate main Checks still runs
  all six jobs; none is removed or conditionally skipped.
- The existing successful-main-Checks `workflow_run` path remains the fallback.
  A push without eligible evidence fails closed; the later successful main run
  can authorize its own fresh Pages build. Manual dispatch is not a bypass and
  is no longer exposed by the Pages workflow.
- The existing `pages` concurrency group serializes deployments. Version 1
  intentionally permits a second small same-SHA build/deployment after main
  Checks finishes rather than maintaining deployment-deduplication state.

The measured historical example was test Checks **26m17s**, identical-SHA main
Checks **27m21s**, then Pages **50s**. Reusing test-run evidence removes the second
wait before the first deployment; it does not reduce numerical/browser coverage
or claim that the remaining checks are faster. Source: [test Checks][test-run],
[main Checks][main-run], [Pages][pages-run] for commit
`1b43dc9c92b6df039387e00f9bbee7146afca496`.

## Fail-closed evidence policy

`scripts/pages_evidence_gate.mjs` makes unauthenticated, read-only public GitHub
REST requests. There are no new tokens, secrets, permissions or paid services.
The repository ID and the numeric IDs/paths of Checks and Pages are fixed in
code, and both run/head repositories must be the same public, non-fork
`phykn/rcwa` repository.

The gate requires:

1. The candidate is the exact current remote `main` SHA and Git tree. The Pages
   workflow context, checked-out HEAD/tree and candidate workflow blobs match.
   A different SHA with an identical tree is never interchangeable.
2. Evidence comes from a `push` run of the exact Checks workflow. The fast path
   permits one nonempty `test/` branch segment containing letters, numbers,
   dots, underscores or hyphens, starting with a letter or number. Nested paths,
   forks, pull-request runs and manually dispatched runs cannot qualify.
3. Select the newest eligible run first, regardless of conclusion; then require
   its latest attempt to be completed/successful. Never search only successful
   runs and silently use an older green result.
4. The attempt has exactly one successful completed job named `backend`,
   `mcp-windows`, `independent-reference`, `circular-reference`, `frontend` and
   `browser`, all belonging to that run, attempt, branch and SHA. Missing,
   duplicated, unexpected, pending, failed or skipped jobs reject the evidence.
5. The newest same-SHA main Checks run is not a known terminal non-success, and
   none of its already-completed jobs failed or was skipped. An initial queued
   or running duplicate may coexist with successful test evidence. A pending
   rerun is rejected until it succeeds, so a previous failure is not hidden.
6. Re-fetch run details after job inspection and re-list runs to reject changing
   attempts, status, conclusions or newly superseding runs. The main fallback
   must match its exact latest triggering run and attempt.

Both before building and immediately before deployment, the gate validates the
proof again and reads current remote `main`. The deploy proof must equal the
build proof, including the Checks run/attempt/job IDs and candidate workflow
blob IDs. Any API error, malformed response, redirect, or incomplete listing
fails closed. Listings are bounded to 100 records; larger candidate histories
require a reviewed policy change rather than truncation or an override.

These checks are point-in-time observations. A remote branch or run can still
change immediately after the final read; this is not an atomic branch lock.
The workflow never claims to certify its own independent review. CI/workflow/gate
changes must themselves receive independent exact-commit review before promotion.

## Build and artifact identity

The frontend Checks job now runs normal tests/build and explicit
`VITE_STATIC_PREVIEW=true` tests/build. The existing browser static build and
reference hash/source-binding checks remain in place. Pages still performs its
own static-mode install, lint, tests and build before upload.

Pages builds the verified commit and uploads a new current-run artifact named
with its SHA, Pages run ID and attempt. It includes `release-evidence.json` with
the source SHA/tree, Checks run/attempt/jobs and workflow blob identities.
Before deploy, the gate requires one matching named artifact with the exact
uploaded artifact ID, owning Pages run/repository/SHA, non-expired state and a
GitHub SHA-256 digest. The ID/digest are recorded in the run summary. This is
artifact identity and digest provenance, not an independent download/re-hash of
the artifact. `actions/deploy-pages` deploys that current-run artifact by name;
no build artifact is borrowed from the test branch. Retain ordinary post-deploy
asset/hash and browser verification before calling delivery complete.

Permissions stay `contents: read` for the workflow and `pages: write` plus
`id-token: write` for the deploy job. The latter reads the exact public candidate
using credential-free Git and needs no new contents permission.

## Local checks and read-only audit

```sh
node --test scripts/tests/pages_evidence_gate.test.mjs
node scripts/pages_evidence_gate.mjs --audit <40-character-current-main-SHA>
```

The synthetic tests cover accepted paths and rejection of wrong repo/workflow,
forks, branches, events, SHA/tree, incomplete or duplicate lists, unsuccessful
jobs, stale runs/attempts, rerun races, main advancement/failures, manual bypass,
API errors and wrong artifact ownership/digests. The audit reads real public
Checks evidence, emits `audit_only: true`, and cannot produce Actions outputs or
authorize deployment. It does not substitute for full CI on the final candidate.

For the first release of this workflow, verify the exact candidate's six Checks
jobs, independently review the script/workflow diff and rendered evidence,
promote that unchanged commit, and inspect both Pages paths and the deployed
`release-evidence.json`. If the gate rejects, inspect the specific reason; do not
relax the proof, add permissions, substitute a same-tree SHA or deploy manually.

[test-run]: https://github.com/phykn/rcwa/actions/runs/38123137016
[main-run]: https://github.com/phykn/rcwa/actions/runs/38124746611
[pages-run]: https://github.com/phykn/rcwa/actions/runs/38126373561
