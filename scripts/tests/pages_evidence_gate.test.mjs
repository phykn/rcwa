import assert from 'node:assert/strict';
import test from 'node:test';
import { POLICY, publicGet, validateArtifact, validateChecks, validateContext, verifyBuildProof } from '../pages_evidence_gate.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), other = 'c'.repeat(40);
const repo = { id: POLICY.repositoryId, full_name: POLICY.repository, private: false, fork: false };
function run(id = 10, branch = 'test/release') {
  return { id, run_number: id, run_attempt: 1, workflow_id: POLICY.checksId,
    path: POLICY.checksPath, name: 'Checks', event: 'push', head_branch: branch,
    head_sha: sha, head_commit: { id: sha, tree_id: tree }, repository: structuredClone(repo),
    head_repository: structuredClone(repo), status: 'completed', conclusion: 'success', referenced_workflows: [] };
}
function jobList(r) {
  return { total_count: 6, jobs: POLICY.jobs.map((name, i) => ({ id: 100 + i, name,
    run_id: r.id, run_attempt: r.run_attempt, head_sha: sha, head_branch: r.head_branch,
    workflow_name: 'Checks', status: 'completed', conclusion: 'success' })) };
}
function fixture() {
  const r = run(), main = run(11, 'main');
  main.status = 'in_progress'; main.conclusion = null;
  const mainJobs = jobList(main);
  for (const job of mainJobs.jobs) { job.status = 'in_progress'; job.conclusion = null; }
  const data = {
    '/git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha } },
    [`/git/commits/${sha}`]: { sha, tree: { sha: tree } },
    [`/actions/workflows/${POLICY.checksId}/runs?head_sha=${sha}&event=push&per_page=100`]: {
      total_count: 2, workflow_runs: [main, r],
    },
    '/actions/runs/10': r, '/actions/runs/11': main,
    '/actions/runs/10/attempts/1/jobs?per_page=100': jobList(r),
    '/actions/runs/11/attempts/1/jobs?per_page=100': mainJobs,
  };
  const calls = {};
  return { data, calls, run: r, main, list: data[`/actions/workflows/${POLICY.checksId}/runs?head_sha=${sha}&event=push&per_page=100`],
    jobs: data['/actions/runs/10/attempts/1/jobs?per_page=100'], mainJobs,
    get: async (path) => {
      calls[path] = (calls[path] || 0) + 1;
      assert.ok(path in data, `Unexpected API read: ${path}`);
      const result = typeof data[path] === 'function' ? data[path](calls[path]) : data[path];
      if (result instanceof Error) throw result;
      return structuredClone(result);
    } };
}
async function reject(change, pattern = /./) {
  const f = fixture(); change(f);
  await assert.rejects(validateChecks({ sha, source: 'test', get: f.get }), pattern);
}

test('accepts exact-SHA latest trusted test run while duplicate main is running', async () => {
  const f = fixture();
  const proof = await validateChecks({ sha, source: 'test', get: f.get });
  assert.equal(proof.sha, sha); assert.equal(proof.tree, tree); assert.equal(proof.checks_run_id, 10);
  assert.equal(proof.jobs.length, 6); assert.equal(proof.checks_run_attempt, 1);
  assert.equal(f.calls['/actions/runs/10'], 2);
  assert.equal(f.calls['/git/ref/heads/main'], 2);
});
test('accepts matching latest full main Checks workflow_run fallback', async () => {
  const f = fixture(); f.main.status = 'completed'; f.main.conclusion = 'success';
  f.data['/actions/runs/11/attempts/1/jobs?per_page=100'] = jobList(f.main);
  const proof = await validateChecks({ sha, source: 'main', trigger: f.main, get: f.get });
  assert.equal(proof.source, 'main'); assert.equal(proof.checks_run_id, 11);
});
for (const [name, change] of Object.entries({
  'fork head': (f) => { f.run.head_repository.fork = true; },
  'wrong repository ID': (f) => { f.run.repository.id++; },
  'wrong repository name': (f) => { f.run.head_repository.full_name = 'other/rcwa'; },
  'private repository': (f) => { f.run.repository.private = true; },
  'wrong workflow ID': (f) => { f.run.workflow_id++; },
  'wrong workflow path': (f) => { f.run.path = '.github/workflows/fake.yml'; },
  'wrong workflow name': (f) => { f.run.name = 'Fake'; },
  'wrong event': (f) => { f.run.event = 'workflow_dispatch'; },
  'pull request event': (f) => { f.run.event = 'pull_request'; },
  'wrong head SHA with same tree': (f) => { f.run.head_sha = other; },
  'wrong commit ID': (f) => { f.run.head_commit.id = other; },
  'wrong tree': (f) => { f.run.head_commit.tree_id = other; },
  'wrong branch': (f) => { f.run.head_branch = 'feature/release'; },
  'test prefix lookalike': (f) => { f.run.head_branch = 'test-other/release'; },
  'nested test branch': (f) => { f.run.head_branch = 'test/release/nested'; },
  'empty test branch': (f) => { f.run.head_branch = 'test/'; },
  'reusable workflow': (f) => { f.run.referenced_workflows = [{}]; },
  'failed run': (f) => { f.run.conclusion = 'failure'; },
  'skipped run': (f) => { f.run.conclusion = 'skipped'; },
  'in-progress run': (f) => { f.run.status = 'in_progress'; f.run.conclusion = null; },
  'missing job': (f) => { f.jobs.jobs.pop(); f.jobs.total_count--; },
  'unexpected job': (f) => { f.jobs.jobs[0].name = 'bonus'; },
  'duplicate job name': (f) => { f.jobs.jobs[0].name = f.jobs.jobs[1].name; },
  'duplicate job ID': (f) => { f.jobs.jobs[0].id = f.jobs.jobs[1].id; },
  'skipped job': (f) => { f.jobs.jobs[0].conclusion = 'skipped'; },
  'neutral job': (f) => { f.jobs.jobs[0].conclusion = 'neutral'; },
  'in-progress job': (f) => { f.jobs.jobs[0].status = 'in_progress'; },
  'job wrong run': (f) => { f.jobs.jobs[0].run_id++; },
  'job wrong attempt': (f) => { f.jobs.jobs[0].run_attempt++; },
  'job wrong SHA': (f) => { f.jobs.jobs[0].head_sha = other; },
  'job wrong branch': (f) => { f.jobs.jobs[0].head_branch = 'main'; },
  'job wrong workflow': (f) => { f.jobs.jobs[0].workflow_name = 'Other'; },
  'incomplete jobs page': (f) => { f.jobs.total_count = 101; },
  'incomplete runs page': (f) => { f.list.total_count = 101; },
  'duplicate run': (f) => { f.list.workflow_runs.push(f.run); f.list.total_count++; },
  'current main advanced': (f) => { f.data['/git/ref/heads/main'].object.sha = other; },
  'API failure': (f) => { f.data['/actions/runs/10'] = new Error('API unavailable'); },
  'newer failed test run': (f) => { const bad = run(20); bad.conclusion = 'failure'; f.list.workflow_runs.push(bad); f.list.total_count++; f.data['/actions/runs/20'] = bad; },
  'newer pending test run': (f) => { const bad = run(20); bad.status = 'queued'; bad.conclusion = null; f.list.workflow_runs.push(bad); f.list.total_count++; f.data['/actions/runs/20'] = bad; },
  'newer terminal main failure': (f) => { f.main.status = 'completed'; f.main.conclusion = 'failure'; },
  'main required job failed while running': (f) => { f.mainJobs.jobs[0].status = 'completed'; f.mainJobs.jobs[0].conclusion = 'failure'; },
  'main required job skipped while running': (f) => { f.mainJobs.jobs[0].status = 'completed'; f.mainJobs.jobs[0].conclusion = 'skipped'; },
  'main job belongs to earlier attempt': (f) => { f.mainJobs.jobs[0].run_attempt = 2; },
  'rerun during job reads': (f) => { const old = structuredClone(f.run); f.data['/actions/runs/10'] = (n) => ({ ...old, run_attempt: n === 1 ? 1 : 2 }); },
  'status changed during job reads': (f) => { const old = structuredClone(f.run); f.data['/actions/runs/10'] = (n) => ({ ...old, conclusion: n === 1 ? 'success' : 'cancelled' }); },
  'main advanced on final read': (f) => { const old = structuredClone(f.data['/git/ref/heads/main']); f.data['/git/ref/heads/main'] = (n) => n === 1 ? old : { ...old, object: { type: 'commit', sha: other } }; },
  'newer eligible run appears during check': (f) => { const key = `/actions/workflows/${POLICY.checksId}/runs?head_sha=${sha}&event=push&per_page=100`; const old = structuredClone(f.list); f.data[key] = (n) => n === 1 ? old : { total_count: 3, workflow_runs: [...old.workflow_runs, run(20)] }; },
})) test(`rejects ${name}`, async () => reject(change));
for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale', 'neutral', 'skipped']) {
  test(`vetoes terminal main ${conclusion}`, async () => reject((f) => { f.main.status = 'completed'; f.main.conclusion = conclusion; }));
}
test('fallback rejects stale triggering run', async () => {
  const f = fixture();
  await assert.rejects(validateChecks({ sha, source: 'main', trigger: { ...f.main, id: 9 }, get: f.get }));
});
test('fallback rejects stale triggering attempt', async () => {
  const f = fixture();
  await assert.rejects(validateChecks({ sha, source: 'main', trigger: { ...f.main, run_attempt: 2 }, get: f.get }));
});
function contextFixture() {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: POLICY.repository,
    GITHUB_REPOSITORY_ID: String(POLICY.repositoryId), GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${POLICY.repository}/${POLICY.pagesPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '30', GITHUB_RUN_ATTEMPT: '1' };
  const event = { after: sha, ref: 'refs/heads/main', deleted: false, repository: structuredClone(repo) };
  const page = { ...run(30, 'main'), workflow_id: POLICY.pagesId, path: POLICY.pagesPath,
    status: 'in_progress', conclusion: null };
  return { env, event, page, get: async () => page };
}
test('accepts exact current main push Pages context', async () => {
  const f = contextFixture(); assert.equal((await validateContext(f.env, f.event, f.get)).sha, sha);
});
for (const [name, change] of Object.entries({
  'manual bypass': (f) => { f.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; },
  'foreign context repo': (f) => { f.env.GITHUB_REPOSITORY = 'other/rcwa'; },
  'non-main ref': (f) => { f.env.GITHUB_REF = 'refs/heads/test/release'; },
  'wrong workflow ref': (f) => { f.env.GITHUB_WORKFLOW_REF = 'other'; },
  'wrong candidate workflow SHA': (f) => { f.env.GITHUB_WORKFLOW_SHA = other; },
  'wrong event SHA': (f) => { f.event.after = other; },
  'deleted main': (f) => { f.event.deleted = true; },
  'wrong Pages ID': (f) => { f.page.workflow_id++; },
  'wrong Pages attempt': (f) => { f.page.run_attempt++; },
  'wrong Pages branch': (f) => { f.page.head_branch = 'test/release'; },
})) test(`rejects ${name}`, async () => { const f = contextFixture(); change(f); await assert.rejects(validateContext(f.env, f.event, f.get)); });
function artifactFixture() {
  const env = { GITHUB_RUN_ID: '30', GITHUB_RUN_ATTEMPT: '1', EXPECTED_ARTIFACT_ID: '50' };
  const artifact = { id: 50, name: `rcwa-pages-${sha}-30-1`, expired: false,
    size_in_bytes: 500, digest: `sha256:${'a'.repeat(64)}`,
    workflow_run: { id: 30, repository_id: POLICY.repositoryId, head_repository_id: POLICY.repositoryId, head_sha: sha, head_branch: 'main' } };
  return { env, artifact, get: async () => ({ total_count: 1, artifacts: [artifact] }) };
}
test('accepts immutable current-run Pages artifact identity/digest', async () => {
  const f = artifactFixture(); assert.equal((await validateArtifact(f.env, { sha }, f.get)).id, 50);
});
for (const [name, change] of Object.entries({
  'wrong artifact ID': (a) => { a.id++; },
  'wrong artifact name': (a) => { a.name = 'github-pages'; },
  'expired artifact': (a) => { a.expired = true; },
  'wrong artifact run': (a) => { a.workflow_run.id++; },
  'foreign artifact repo': (a) => { a.workflow_run.head_repository_id++; },
  'wrong artifact SHA': (a) => { a.workflow_run.head_sha = other; },
  'missing artifact digest': (a) => { delete a.digest; },
  'malformed artifact digest': (a) => { a.digest = 'sha256:bad'; },
})) test(`rejects ${name}`, async () => { const f = artifactFixture(); change(f.artifact); await assert.rejects(validateArtifact(f.env, { sha }, f.get)); });
test('HTTP errors and redirects fail closed without credentials or retries', async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
      return { ok: false, status: 403 };
    };
    await assert.rejects(publicGet('/git/ref/heads/main'), /HTTP 403/);
  } finally { globalThis.fetch = old; }
});

test('rejects pending main rerun rather than ignoring a previous failure', async () => {
  await reject((f) => { f.main.run_attempt = 2; });
});
test('rejects duplicate named Pages artifacts', async () => {
  const f = artifactFixture();
  await assert.rejects(validateArtifact(f.env, { sha }, async () => ({ total_count: 2, artifacts: [f.artifact, { ...f.artifact, id: 51 }] })));
});

test('accepts the main workflow_run Pages context', async () => {
  const f = contextFixture(); f.env.GITHUB_EVENT_NAME = 'workflow_run';
  f.page.event = 'workflow_run'; f.event.workflow_run = run(11, 'main');
  const context = await validateContext(f.env, f.event, f.get);
  assert.equal(context.source, 'main'); assert.equal(context.sha, sha);
  assert.equal(context.pages_tree, tree); assert.equal(context.trigger.id, 11);
});
test('accepts an unchanged build proof at deploy', async () => {
  const f = fixture(); const proof = await validateChecks({ sha, source: 'test', get: f.get });
  verifyBuildProof(proof, structuredClone(proof));
});
for (const key of ['sha', 'tree', 'source', 'checks_run_id', 'checks_run_attempt', 'checks_blob', 'pages_blob', 'jobs']) {
  test(`rejects predeploy build-proof mismatch: ${key}`, async () => {
    const f = fixture(); const proof = await validateChecks({ sha, source: 'test', get: f.get });
    proof.checks_blob = 'd'.repeat(40); proof.pages_blob = 'e'.repeat(40);
    const expected = structuredClone(proof); expected[key] = 'changed';
    assert.throws(() => verifyBuildProof(proof, expected), /Evidence changed since build/);
  });
}
