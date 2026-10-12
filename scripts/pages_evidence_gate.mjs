#!/usr/bin/env node
// Read-only evidence validation, not an authorization or independent-review service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const POLICY = Object.freeze({
  repository: 'phykn/rcwa', repositoryId: 1412777097,
  checksId: 380302294, checksPath: '.github/workflows/checks.yml',
  pagesId: 380302295, pagesPath: '.github/workflows/pages.yml',
  jobs: ['backend', 'mcp-windows', 'independent-reference', 'circular-reference', 'frontend', 'browser'],
});
const API = `https://api.github.com/repos/${POLICY.repository}`;
const SHA = /^[a-f0-9]{40}$/;
// Deliberately one nonempty segment: the reviewed release convention is test/*.
const TEST_BRANCH = /^test\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const integer = (n) => Number.isSafeInteger(n) && n > 0;
const requireThat = (ok, reason) => assert.ok(ok, reason);

export async function publicGet(path) {
  requireThat(path.startsWith('/') && !path.startsWith('//'), 'Invalid API path');
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  requireThat(response.ok, `Public GitHub API failed: HTTP ${response.status}`);
  return response.json();
}

function repository(repo) {
  requireThat(repo?.id === POLICY.repositoryId && repo.full_name === POLICY.repository &&
    repo.private === false && repo.fork === false, 'Wrong, private, or fork repository');
}
function workflow(run, id, path, sha, tree) {
  repository(run?.repository);
  repository(run?.head_repository);
  requireThat(integer(run.id) && integer(run.run_number) && integer(run.run_attempt), 'Invalid run identity');
  requireThat(run.workflow_id === id && run.path === path, 'Wrong workflow ID/path');
  requireThat(run.head_sha === sha && run.head_commit?.id === sha &&
    run.head_commit?.tree_id === tree, 'Run commit SHA/tree mismatch');
}
function checks(run, sha, tree) {
  workflow(run, POLICY.checksId, POLICY.checksPath, sha, tree);
  requireThat(run.name === 'Checks' && run.event === 'push', 'Checks must be a push run');
  requireThat(Array.isArray(run.referenced_workflows) && run.referenced_workflows.length === 0,
    'Unexpected reusable workflow');
}
function successful(run) {
  requireThat(run.status === 'completed' && run.conclusion === 'success', 'Latest Checks run/attempt is not successful');
}
function completeList(data, key) {
  // A bounded, fail-closed read, never an incomplete first-page approval.
  requireThat(Array.isArray(data?.[key]) && data.total_count === data[key].length &&
    data.total_count <= 100, `Incomplete ${key} listing`);
  return data[key];
}
function newest(runs) {
  return [...runs].sort((a, b) => b.run_number - a.run_number)[0];
}
function sameAttempt(before, after) {
  for (const key of ['id', 'run_number', 'run_attempt', 'head_branch', 'status', 'conclusion']) {
    requireThat(before[key] === after[key], `Run changed while reading evidence: ${key}`);
  }
}
function jobs(data, run, requireSuccess) {
  const rows = completeList(data, 'jobs');
  const names = new Set();
  const ids = new Set();
  for (const job of rows) {
    requireThat(POLICY.jobs.includes(job.name) && !names.has(job.name) &&
      integer(job.id) && !ids.has(job.id), 'Unexpected or duplicate Checks job');
    names.add(job.name); ids.add(job.id);
    requireThat(job.run_id === run.id && job.run_attempt === run.run_attempt &&
      job.head_sha === run.head_sha && job.head_branch === run.head_branch &&
      job.workflow_name === 'Checks', 'Job run/attempt/SHA/branch mismatch');
    if (requireSuccess || job.status === 'completed') {
      requireThat(job.status === 'completed' && job.conclusion === 'success', `Job is not successful: ${job.name}`);
    } else {
      requireThat(['queued', 'in_progress', 'waiting', 'pending'].includes(job.status) &&
        job.conclusion === null, 'Invalid pending main job');
    }
  }
  if (requireSuccess) requireThat(names.size === POLICY.jobs.length, 'Missing required Checks job');
  return rows.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
async function currentMain(get, sha) {
  const ref = await get('/git/ref/heads/main');
  requireThat(ref.ref === 'refs/heads/main' && ref.object?.type === 'commit' &&
    ref.object.sha === sha, 'Remote main no longer matches candidate SHA');
}
async function runList(get, sha, tree) {
  const runs = completeList(await get(`/actions/workflows/${POLICY.checksId}/runs?head_sha=${sha}&event=push&per_page=100`), 'workflow_runs');
  const ids = new Set(); const numbers = new Set();
  for (const run of runs) {
    checks(run, sha, tree);
    requireThat(!ids.has(run.id) && !numbers.has(run.run_number), 'Duplicate Checks run');
    ids.add(run.id); numbers.add(run.run_number);
  }
  return runs;
}
async function validateAttempt(get, listed, sha, tree, requireSuccess) {
  const run = await get(`/actions/runs/${listed.id}`);
  checks(run, sha, tree); sameAttempt(listed, run);
  if (requireSuccess || run.status === 'completed') successful(run);
  else requireThat(['queued', 'in_progress', 'waiting', 'pending'].includes(run.status) &&
    run.conclusion === null && run.run_attempt === 1, 'Invalid or rerunning pending main Checks run');
  const jobIds = jobs(await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`), run, requireSuccess || run.status === 'completed');
  const after = await get(`/actions/runs/${run.id}`);
  checks(after, sha, tree); sameAttempt(run, after);
  return { run, jobIds };
}

export async function validateChecks({ sha, source, trigger, get = publicGet }) {
  requireThat(SHA.test(sha) && ['test', 'main'].includes(source), 'Invalid candidate/source');
  await currentMain(get, sha);
  const commit = await get(`/git/commits/${sha}`);
  requireThat(commit.sha === sha && SHA.test(commit.tree?.sha), 'Invalid candidate commit tree');
  const tree = commit.tree.sha;
  const runs = await runList(get, sha, tree);
  const eligible = runs.filter((r) => source === 'test' ? TEST_BRANCH.test(r.head_branch) : r.head_branch === 'main');
  const chosen = newest(eligible);
  requireThat(chosen, 'No eligible exact-SHA Checks run; await full main Checks fallback');
  if (source === 'main') {
    checks(trigger, sha, tree);
    requireThat(trigger.head_branch === 'main' && trigger.id === chosen.id &&
      trigger.run_attempt === chosen.run_attempt, 'Stale or invalid workflow_run trigger');
    successful(trigger);
  }
  const { run, jobIds } = await validateAttempt(get, chosen, sha, tree, true);
  const main = newest(runs.filter((r) => r.head_branch === 'main'));
  // A still-running duplicate is allowed only while none of its jobs has failed.
  if (source === 'test' && main) await validateAttempt(get, main, sha, tree, false);
  const latest = await runList(get, sha, tree);
  const stillChosen = newest(latest.filter((r) => source === 'test' ? TEST_BRANCH.test(r.head_branch) : r.head_branch === 'main'));
  requireThat(stillChosen?.id === run.id, 'Newer eligible Checks run appeared');
  sameAttempt(run, stillChosen);
  if (source === 'test') {
    const latestMain = newest(latest.filter((r) => r.head_branch === 'main'));
    requireThat(latestMain?.id === main?.id, 'Main Checks run changed during validation');
    if (main) sameAttempt(main, latestMain);
  }
  await currentMain(get, sha);
  return { schema: 1, repository: POLICY.repository, sha, tree, source,
    checks_workflow_id: POLICY.checksId, checks_workflow_path: POLICY.checksPath,
    checks_run_id: run.id, checks_run_attempt: run.run_attempt, checks_branch: run.head_branch,
    jobs: jobIds };
}

export async function validateContext(env, event, get = publicGet) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === POLICY.repository &&
    env.GITHUB_REPOSITORY_ID === String(POLICY.repositoryId), 'Wrong Actions repository context');
  repository(event.repository);
  requireThat(env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === `${POLICY.repository}/${POLICY.pagesPath}@refs/heads/main`, 'Wrong Pages workflow ref');
  requireThat(['push', 'workflow_run'].includes(env.GITHUB_EVENT_NAME), 'Manual/unsupported Pages event');
  const sha = env.GITHUB_EVENT_NAME === 'push' ? event.after : event.workflow_run?.head_sha;
  requireThat(SHA.test(sha) && env.GITHUB_SHA === sha && env.GITHUB_WORKFLOW_SHA === sha,
    'Pages context/candidate workflow SHA mismatch');
  if (env.GITHUB_EVENT_NAME === 'push') {
    requireThat(event.ref === 'refs/heads/main' && event.deleted === false, 'Invalid main push');
  }
  requireThat(/^\d+$/.test(env.GITHUB_RUN_ID) && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT), 'Invalid Pages run context');
  const pageRun = await get(`/actions/runs/${env.GITHUB_RUN_ID}`);
  workflow(pageRun, POLICY.pagesId, POLICY.pagesPath, sha, pageRun.head_commit?.tree_id);
  requireThat(SHA.test(pageRun.head_commit?.tree_id) && pageRun.id === Number(env.GITHUB_RUN_ID) &&
    pageRun.run_attempt === Number(env.GITHUB_RUN_ATTEMPT) && pageRun.head_branch === 'main' &&
    pageRun.event === env.GITHUB_EVENT_NAME && pageRun.status === 'in_progress' &&
    pageRun.conclusion === null, 'Pages run identity/status mismatch');
  return { sha, pages_tree: pageRun.head_commit.tree_id,
    source: env.GITHUB_EVENT_NAME === 'push' ? 'test' : 'main', trigger: event.workflow_run };
}

export async function validateArtifact(env, proof, get = publicGet) {
  const id = Number(env.EXPECTED_ARTIFACT_ID);
  requireThat(integer(id), 'Missing Pages artifact ID');
  const artifacts = completeList(await get(`/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100`), 'artifacts');
  const name = `rcwa-pages-${proof.sha}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const matches = artifacts.filter((item) => item.name === name);
  requireThat(matches.length === 1, 'Missing or duplicate named Pages artifact');
  const artifact = matches[0];
  const run = artifact.workflow_run;
  requireThat(artifact.id === id && artifact.name === name && artifact.expired === false &&
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest) && run?.id === Number(env.GITHUB_RUN_ID) &&
    run.repository_id === POLICY.repositoryId && run.head_repository_id === POLICY.repositoryId &&
    run.head_sha === proof.sha && run.head_branch === 'main', 'Wrong/expired/unbound Pages artifact');
  return { id, name, digest: artifact.digest };
}
export function verifyBuildProof(proof, expected) {
  assert.deepEqual(proof, expected, 'Evidence changed since build');
}
function localIdentity(proof) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  requireThat(git('rev-parse', 'HEAD') === proof.sha && git('rev-parse', 'HEAD^{tree}') === proof.tree,
    'Checkout SHA/tree differs from evidence');
  git('diff', '--exit-code', 'HEAD', '--');
  return { checks_blob: git('rev-parse', `HEAD:${POLICY.checksPath}`),
    pages_blob: git('rev-parse', `HEAD:${POLICY.pagesPath}`) };
}
async function main() {
  const [mode, sha] = process.argv.slice(2);
  if (mode === '--audit' && SHA.test(sha)) {
    // Cannot authorize a build/deployment: intentionally emits no Actions outputs.
    console.log(JSON.stringify({ audit_only: true, ...await validateChecks({ sha, source: 'test' }) }, null, 2));
    return;
  }
  requireThat(['build', 'deploy'].includes(mode) && process.argv.length === 3, 'Use build, deploy, or --audit <SHA>');
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const context = await validateContext(env, event);
  const proof = await validateChecks(context);
  requireThat(proof.tree === context.pages_tree, 'Pages/Checks commit tree mismatch');
  Object.assign(proof, localIdentity(proof));
  if (mode === 'deploy') {
    verifyBuildProof(proof, JSON.parse(env.EXPECTED_EVIDENCE));
    const artifact = await validateArtifact(env, proof);
    // Last operation before returning to deploy-pages: current-main read.
    await currentMain(publicGet, proof.sha);
    console.log(JSON.stringify({ ...proof, artifact }, null, 2));
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Pages artifact ${artifact.id}: ${artifact.digest}\n`);
  } else {
    writeFileSync('pages-evidence.json', `${JSON.stringify(proof, null, 2)}\n`);
    appendFileSync(env.GITHUB_OUTPUT, `sha=${proof.sha}\nevidence=${JSON.stringify(proof)}\n`);
  }
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    `Validated ${proof.sha} (tree ${proof.tree}) against Checks run ${proof.checks_run_id}, attempt ${proof.checks_run_attempt}, branch ${proof.checks_branch}.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Pages evidence gate rejected: ${error.message}`); process.exitCode = 1; });
}
