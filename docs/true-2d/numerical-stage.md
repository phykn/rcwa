# True-2D numerical stage, not application release

Historical numerical-stage plan, completed at
`cdfa4609ca35851dd5f058f84a9d65869b5f18f6`. The later separately approved
[backend-first integration plan](integration-plan.md) supersedes its application
boundary; see [current verification](backend-integration-validation.md).

That isolated stage started at released commit 41b81d56ce1c6f19c37d3c732ea46c36d71f53c6.
It left released 1D source, public schema dispatch, HTTP/MCP, fitting, worker
admission, frontend and static default untouched. New modules were then imported
only by the offline numerical harness, with proposed schema 1.2 unexposed.

## Incorporated independent review conditions

1. Gate the actual intended H5 example at every wavelength against H7 and H9 production refinements and independently converged S4. Record H5-to-H9 and H5-to-reference explicitly, not just high-basis agreement.
2. Retain every integer (m,n), all R_s/R_p/T_s/T_p channels, R/T sums, signed common-order residuals, and summed newly added-order tails. Archive complete inputs, exact source/build hashes and settings.
3. Fixed acceptance tolerances: each of two successive production and S4 basis changes at most 5e-4 absolute, and actual H5 versus converged S4 at most 2e-3 absolute. Inspect dense wavelength sampling around sharp features/cutoffs. Pattern sensitivity must exceed measured numerical uncertainty. Failed high-contrast candidates remain failed.
4. Every ordinary forward result says convergence not assessed. Example evidence is bound to the exact normalized input, basis and wavelength grid; edits do not inherit certification. The example is synthetic, not fabricated-device or HBM evidence.
5. Add non-air ambient, unequal Hx/Hy, both x-only and y-only 1D reductions, normal phi45 and quadrants, mixed layers, multiple channels, exact centered x/y mirrors and 180-degree rotation. Keep finite-basis x/y transpose error a separate refinement-aware test.
6. H<=5, 31 wavelengths, eight finite layers and one heavy computation are provisional. This numerical phase measures standalone runtime/RSS/bytes only. Actual worker two-user admission, heavy-plus-legacy, cancellation/deadline cleanup and restart tests are required in the next phase before exposing 2D. No deployment-resource guarantee follows from a local timing.
7. Freeze 1.0/1.1 normalization, hashes and spectra now. Later explicit 1.2 conversion, no 2D fitting, full hash/result/preview contract, and true geometry rendering remain separate gates; no UI or default publication in this phase.

Read the original plan and independent review alongside this amendment. They preserve historical exploratory failures and limits. The numerical-stage summary will record executed, failed and deferred checks separately.

## Legacy reproducibility

Frozen normalization and canonical SHA256 are exact. A pre-edit baseline run and the initial 338-test run on this machine also preserved old spectra bit-for-bit. The portable regression allows 2e-12 absolute power variation for different BLAS/CPU builds; this does not loosen any new physics threshold. All released tracked files remain byte-identical in this additive phase.

## Later public-contract parity gate

The numerical Project2D parser requires explicit schema_version="1.2" and explicit geometry discriminator tags. Existing legacy Layer/HomogeneousLayer classes retain their historical constructor defaults. Before exposing JSON Schema, TypeScript, HTTP, MCP or storage dispatch, test omitted geometry tags against both the actual Pydantic parser and exported schema; do not assume a discriminator annotation alone makes a tag required in ordinary JSON Schema. Test all three layer types, missing/unknown tags, missing version (still legacy 1.0), explicit 1.0/1.1/1.2, unsupported versions, and unrequested automatic migration. Keep the offline schema unexposed until these contracts agree. These are deferred integration acceptance criteria, not completed public compatibility claims.

The offline 2D input_hash helper currently uses sorted compact JSON with default Unicode escaping; existing storage canonical_hash uses ensure_ascii=False UTF-8. They agree for the ASCII numerical fixtures but differ for non-ASCII names/source strings. No 2D result reaches existing storage now. Before 1.2 public integration, unify the canonical serialization deliberately (without changing historical 1.0/1.1 hashes) and test Korean/other Unicode project, layer and material names through normalize → validate → solve → save → reload and HTTP/MCP binding. Preserve the original generation hashes on this phase's numerical evidence; do not relabel already generated samples with a new source fingerprint.

Hash parity tests must also compare equivalent integer/float JSON inputs after normalization and in-memory edits. The offline forward function revalidates/coerces its Project2D copy, while the standalone hash helper assumes its caller already holds the normalized model. Assigning an int directly to a float-typed field without revalidation can therefore change the raw helper digest while preserving the normalized physical input. Public binding must use the shared version-dispatch normalizer on both sides before hashing; mutable model objects must not define a second canonical form.
