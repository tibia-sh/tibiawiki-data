import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type Call, code, keys, read, runScripts, runStep, scalar, stepBody, stepIf, stepIndex, stepInputs, stepName, steps, stepScript, under } from './workflow.ts';

/**
 * The drift workflow cannot run inside the suite, and its mistakes are quiet. A detector
 * that never sees a change looks exactly like a wiki that did not move, and a pull request
 * that does not bump the version merges without publishing. So its shape is pinned from
 * the file here, and every script that decides something runs against stand-in commands.
 */

const workflow = (): string => read('drift.yml');
const jobs = (): string => under(code(workflow()), 'jobs');
const buildJob = (): string => under(jobs(), 'build');
const prJob = (): string => under(jobs(), 'pr');
const alertJob = (): string => under(jobs(), 'alert');
const proposeStep = (): string => steps(prJob())[stepIndex(steps(prJob()), 'propose')]!;

/** A permissions block as sorted `scope: level` lines. */
const grants = (block: string): string[] =>
  block.split('\n').map((line) => line.trim()).filter((line) => line !== '').sort();

const DIGEST_A = '18ca2b2bf2c566fa6c7006977dea3558309bea165cb7d567daac1766a28bd27d';
const DIGEST_B = '95893758373511f414cf538f81b500c2c6bf9765704e0f0a0ff0aca9d21fbc61';

/** sha256 of the text `rebuilt index`, taken with shasum and openssl. */
const REBUILT_INDEX_SHA256 = '95893758373511f414cf538f81b500c2c6bf9765704e0f0a0ff0aca9d21fbc61';

/** What index-digest could print instead of a digest, each of which must stop the run. */
const NOT_DIGESTS: Array<[string, string]> = [
  ['nothing', ''],
  ['63 hex characters', DIGEST_A.slice(1)],
  ['65 hex characters', `${DIGEST_A}0`],
  ['uppercase hex', DIGEST_A.toUpperCase()],
  ['a digest with a second line', `${DIGEST_A}\n${DIGEST_B}`],
  ['a prefixed digest', `sha256:${DIGEST_A}`],
];

/** A stand-in for the server binary that prints `stdout` for index-digest and exits `exit`. */
const fakeServer = (stdout: string, exit = 0): string =>
  `if (process.argv[2] !== 'index-digest' || process.argv[3] !== 'index.db') { process.exitCode = 2; return; }\n` +
  `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exitCode = ${exit};\n`;

const SERVER = 'node_modules/.bin/tibiawiki-mcp';

test('the workflow runs on Tuesdays and Fridays at 06:17 UTC and by hand, and on nothing else', () => {
  // Twice a week. Daily would release almost every day, since the wiki is edited daily.
  assert.deepEqual(keys(under(code(workflow()), 'on')), ['schedule', 'workflow_dispatch'],
    'the drift workflow has a trigger other than its schedule and workflow_dispatch');
  const crons = [...workflow().matchAll(/^ *- *cron: *'([^']*)'(.*)$/gm)];
  assert.equal(crons.length, 1, 'expected exactly one cron schedule');
  assert.equal(crons[0]![1], '17 6 * * 2,5', 'the schedule is not Tuesdays and Fridays at 06:17 UTC');
  assert.match(crons[0]![2]!, /#.*\bTuesdays?\b.*\bFridays?\b/, 'the schedule comment does not name Tuesday and Friday');
});

test('no job in the drift workflow can mint an OIDC token', () => {
  // This workflow never publishes itself. A merge publishes through release.yml, and without
  // id-token a mistake here cannot publish either.
  assert.doesNotMatch(workflow(), /id-token/);
});

test('the drift workflow never publishes, and merges only through auto-merge in the propose step', () => {
  // A merge publishes through release.yml, so it has to wait for the checks the ruleset requires.
  // Auto-merge waits for them, and a held refresh turns it off. Nothing else here may merge.
  const body = code(workflow());
  for (const [what, pattern] of [
    ['npm publish', /\bnpm +publish\b/],
    ['the REST merge endpoint', /\/merge\b/],
    ['GraphQL auto-merge', /enablePullRequestAutoMerge/],
    ['an admin merge', /--admin\b/],
  ] as const) {
    assert.doesNotMatch(body, pattern, `the drift workflow runs ${what}`);
  }
  const merges = [...new Set([...body.matchAll(/\bgh +pr +merge\b.*$/gm)].map((match) => match[0].trim()))].sort();
  assert.deepEqual(merges, ['gh pr merge "$number" --auto --rebase', 'gh pr merge "$number" --disable-auto'],
    'the drift workflow merges in a way other than turning auto-merge on or off');
  const script = code(stepScript(workflow(), 'propose'));
  for (const merge of merges) assert.ok(script.includes(merge), `${merge} is not in the propose step`);
});

test('the workflow has a build, a pr and an alert job, and grants nothing by default', () => {
  assert.deepEqual(keys(jobs()), ['build', 'pr', 'alert']);
  assert.match(code(workflow()), /^permissions: *\{\}$/m, 'the workflow-level permissions grant something');
});

test('the build job can only read, and reads no secret', () => {
  // It runs the generator over content anyone can edit.
  assert.deepEqual(grants(under(buildJob(), 'permissions')), ['contents: read'],
    'the build job does not hold exactly contents: read');
  assert.doesNotMatch(buildJob(), /\bsecrets\b|\bgithub\.token\b|^ *environment:/m, 'the build job reads a token');
});

test('the pr job holds exactly contents: read, and writes only through the drift token', () => {
  // Its own token only reads, for the checkout. Every write goes through DRIFT_TOKEN, so the
  // pull request's CI starts and its merge starts release.yml.
  assert.deepEqual(grants(under(prJob(), 'permissions')), ['contents: read']);
  assert.doesNotMatch(prJob(), /\bgithub\.token\b/, 'the pr job uses github.token');
});

test('only the pr job runs in the drift environment', () => {
  // The environment gives DRIFT_TOKEN to runs on main alone, whatever a job's if says.
  assert.equal(scalar(prJob(), 'environment'), 'drift', 'the pr job does not run in the drift environment');
  assert.deepEqual([...code(workflow()).matchAll(/^ *environment:.*$/gm)].map((match) => match[0].trim()), ['environment: drift'],
    'a job other than the pr job names an environment');
});

test('the drift token is the one secret the workflow reads, and it reaches the propose step alone, through its env', () => {
  const secrets = code(workflow()).split('\n').filter((line) => /\bsecrets\b/.test(line)).map((line) => line.trim());
  assert.deepEqual(secrets, ['GH_TOKEN: ${{ secrets.DRIFT_TOKEN }}']);
  assert.equal(scalar(under(stepBody(proposeStep()), 'env'), 'GH_TOKEN'), '${{ secrets.DRIFT_TOKEN }}',
    'the token does not reach the propose step through its env as GH_TOKEN');
  assert.doesNotMatch(stepScript(workflow(), 'propose'), /DRIFT_TOKEN/, 'the propose script names the secret');
});

test('the pr job waits for the build job, and runs only on main when the digests differ', () => {
  assert.equal(scalar(prJob(), 'needs'), 'build', 'the pr job does not need the build job');
  assert.equal(scalar(prJob(), 'if'), "${{ github.ref == 'refs/heads/main' && needs.build.outputs.changed == 'true' }}",
    'the pr job is not gated on main and on a changed digest');
});

test('the pr job is bounded at 75 minutes, room for the 60 minute wait for the merge', () => {
  assert.equal(scalar(prJob(), 'timeout-minutes'), '75');
});

test('the alert job runs on main alone, after both jobs, when one did not succeed or the refresh was held', () => {
  // A dispatch from another branch builds, tests and guards, and alerts nothing. GitHub can report
  // a job that hit its timeout-minutes as cancelled rather than failed, so anything but success
  // alerts, except a pr job skipped because nothing changed.
  const alert = alertJob();
  assert.equal(scalar(alert, 'needs'), '[build, pr]', 'the alert job does not need both jobs');
  assert.equal(scalar(alert, 'if'),
    "${{ always() && github.ref == 'refs/heads/main' && (needs.build.result != 'success' || (needs.pr.result != 'success' && needs.pr.result != 'skipped') || needs.build.outputs.hold == 'true') }}",
    'the alert job is not gated on main and on a job that did not succeed or a hold');
  assert.equal(scalar(alert, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(alert, 'timeout-minutes'), '5', 'the alert job is not bounded at 5 minutes');
});

test('the alert job holds exactly issues: write, checks nothing out and comments with github.token', () => {
  const alert = alertJob();
  assert.deepEqual(grants(under(alert, 'permissions')), ['issues: write']);
  assert.doesNotMatch(alert, /^ *(?:- +)?uses:/m, 'the alert job runs an action');
  const list = steps(alert);
  assert.equal(list.length, 1, 'expected exactly one alert job step');
  stepIndex(list, 'alert');
  assert.deepEqual(keys(under(stepBody(list[0]!), 'env')).sort(), ['BUILD_RESULT', 'GH_TOKEN', 'HOLD', 'PR_RESULT', 'REASONS']);
  assert.equal(scalar(under(stepBody(list[0]!), 'env'), 'GH_TOKEN'), '${{ github.token }}', 'the alert step does not use github.token');
});

test('drift runs take turns in their own concurrency group, and none is cancelled', () => {
  const concurrency = under(code(workflow()), 'concurrency');
  assert.match(concurrency, /^ *group: *drift$/m, 'the concurrency group is not drift');
  assert.match(concurrency, /^ *cancel-in-progress: *false$/m, 'cancel-in-progress is not false');
});

test('the build job is bounded in time', () => {
  // A wiki API that keeps answering 429 with a long Retry-After must end the run, red.
  assert.match(scalar(buildJob(), 'timeout-minutes') ?? '', /^[1-9]\d*$/, 'the build job has no timeout-minutes');
});

test('every action in the drift workflow is pinned to a full commit SHA, with its version beside it', () => {
  const uses = workflow().split('\n').filter((line) => /^ *(?:- +)?uses:/.test(line));
  assert.ok(uses.length > 0, 'drift.yml uses no actions, so this check proves nothing');
  for (const line of uses) {
    assert.match(line, /uses: *[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${line.trim()} is not pinned to a SHA with its version`);
  }
});

test('no run script in the drift workflow interpolates an expression', () => {
  // Values reach the scripts through env:, so a crafted one is data, never code.
  const scripts = runScripts(workflow());
  assert.ok(scripts.length > 0, 'drift.yml has no run: scripts, so this check proves nothing');
  for (const script of scripts) {
    const line = script.split('\n').find((text) => text.includes('${{'));
    assert.equal(line, undefined, `a run: script interpolates an expression: ${line?.trim()}`);
  }
});

test('every checkout keeps no credentials and takes the commit that triggered the run', () => {
  // The build job rebuilds that commit, and the pr job commits on top of the same one.
  const checkouts = [...steps(buildJob()), ...steps(prJob())].filter((step) => /uses: *actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 2, 'expected one checkout in each job');
  for (const step of checkouts) {
    assert.match(step, /^ *persist-credentials: *false$/m, 'a checkout leaves the token in .git/config');
    assert.doesNotMatch(step, /^ *ref:/m, 'a checkout takes a ref instead of the triggering commit');
  }
});

test("the only cache either job restores or saves is pnpm/setup's lockfile-verification record", () => {
  // A cache the build job saved after the generator ran would carry whatever that run left into
  // later runs, and into ci.yml. setup-node and setup-uv cache by themselves unless told not to.
  // pnpm/setup restores and saves its lockfile-verification record whatever its inputs say. The
  // record holds no package. With `install: true` the action saves it right after its frozen
  // install, before the generator runs, and its post step tries again at the end of the job only
  // when that save does not go through.
  const all = [...steps(buildJob()), ...steps(prJob())];
  assert.doesNotMatch(all.join('\n'), /uses: *actions\/cache/, 'a step uses actions/cache');
  const nodes = all.filter((step) => /uses: *actions\/setup-node@/.test(step));
  assert.equal(nodes.length, 2, 'expected one setup-node in each job');
  for (const step of nodes) {
    const inputs = stepInputs(step);
    assert.equal(scalar(inputs, 'package-manager-cache'), 'false', 'setup-node caches the package manager store');
    assert.equal(scalar(inputs, 'cache'), undefined, 'setup-node restores a dependency cache');
  }
  const uvs = all.filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.equal(scalar(stepInputs(uvs[0]!), 'enable-cache'), 'false', 'setup-uv caches');
  const pnpms = all.filter((step) => /uses: *pnpm\/setup@/.test(step));
  assert.equal(pnpms.length, 1, 'expected one pnpm/setup, in the build job');
  const inputs = stepInputs(pnpms[0]!);
  assert.equal(scalar(inputs, 'cache'), undefined, 'pnpm/setup caches the pnpm store');
  assert.equal(scalar(inputs, 'install'), 'true',
    'pnpm/setup saves its lockfile-verification record only at the end of the job, after the generator ran');
});

test('the build job installs an exact uv version', () => {
  // setup-uv checks a download only against the checksums it ships, which stop at the uv
  // versions out when that setup-uv was released. It skips the check for any later uv, and
  // `latest` or a range can resolve to one.
  const uvs = steps(buildJob()).filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.match(uvs[0]!, /^ *version: *'?\d+\.\d+\.\d+'?$/m, 'setup-uv does not install an exact uv version');
});

test('the drift workflow leaves the PyPI cooldown to scripts/build.ts', () => {
  // build.ts gives build-index a default UV_EXCLUDE_NEWER, and the environment wins over it.
  // One set anywhere in this workflow would replace that default without failing a check.
  assert.doesNotMatch(code(workflow()), /UV_EXCLUDE_NEWER/, 'drift.yml sets UV_EXCLUDE_NEWER');
});

test('the build job digests the committed index before build-index overwrites it', () => {
  const list = steps(buildJob());
  const committed = stepIndex(list, 'committed');
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  assert.notEqual(build, -1, 'the build job never runs pnpm build-index');
  assert.ok(committed < build, 'the committed digest is taken after build-index has overwritten index.db');
  assert.match(list[committed]!, /tibiawiki-mcp index-digest index\.db/, 'the committed step does not digest index.db');
});

test('the build job tests the rebuilt index, and uploads it only after that and only when it changed', () => {
  const list = steps(buildJob());
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  const suite = list.findIndex((step) => /^ *(?:- +)?run: *pnpm test$/m.test(step));
  const digests = stepIndex(list, 'digests');
  const uploads = list.flatMap((step, index) => (/uses: *actions\/upload-artifact@/.test(step) ? [index] : []));
  assert.notEqual(suite, -1, 'the build job never runs pnpm test');
  assert.ok(build < digests, 'the rebuilt digest is taken before build-index');
  assert.ok(build < suite, 'pnpm test runs before build-index, so it tests the committed index');
  assert.equal(uploads.length, 1, 'expected exactly one upload');
  assert.ok(suite < uploads[0]!, `${stepName(list[uploads[0]!]!)} uploads before pnpm test has passed`);
  assert.equal(stepIf(list[uploads[0]!]!), "${{ steps.digests.outputs.changed == 'true' }}",
    'the upload is not gated on a changed digest');
});

/** The build job's guard command, as the workflow runs it. */
const GUARD = 'node scripts/drift-guard.ts "$RUNNER_TEMP/committed.db" index.db';

test('the build job keeps a copy of the committed index before build-index overwrites it', () => {
  const list = steps(buildJob());
  const keep = list.findIndex((step) => /^ *cp index\.db "\$RUNNER_TEMP\/committed\.db"$/m.test(step));
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  assert.notEqual(keep, -1, 'the build job never copies index.db to $RUNNER_TEMP/committed.db');
  assert.ok(keep < build, 'the committed index is copied after build-index has overwritten it');
});

test('the build job runs the guard after the suite, and only when the content changed', () => {
  const list = steps(buildJob());
  const suite = list.findIndex((step) => /^ *(?:- +)?run: *pnpm test$/m.test(step));
  const guard = stepIndex(list, 'guard');
  assert.ok(suite < guard, 'the guard runs before pnpm test has passed');
  assert.equal(stepIf(list[guard]!), "${{ steps.digests.outputs.changed == 'true' }}", 'the guard is not gated on a changed digest');
  assert.ok(stepScript(workflow(), 'guard').includes(GUARD), `the guard step does not run ${GUARD}`);
});

/** A stand-in for scripts/drift-guard.ts that checks its arguments, prints `stdout` and exits `exit`. */
const fakeGuard = (stdout: string, exit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.length !== 2 || args[0] !== process.env.RUNNER_TEMP + '/committed.db' || args[1] !== 'index.db') { process.exitCode = 2; }\n` +
  `else { process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${exit}; }\n`;

/** Runs the guard step with the stand-in guard, and reads the outputs it wrote. */
const runGuard = (stdout: string, exit = 0) => {
  const run = runStep(stepScript(workflow(), 'guard'), { files: { 'scripts/drift-guard.ts': fakeGuard(stdout, exit) } });
  const heredoc = /^reasons<<(\S+)\n(?:([\s\S]*?)\n)?\1\n/m.exec(run.output);
  return { ...run, hold: /^hold=(.*)$/m.exec(run.output)?.[1], delimiter: heredoc?.[1], reasons: heredoc ? heredoc[2] ?? '' : undefined };
};

const REASONS = 'item lost 150 of 9,800 rows (1.5%)\ntable npc_job is missing';

test('the guard step holds with the reasons the guard printed, and goes when it printed none', () => {
  const held = runGuard(`${REASONS}\n`);
  assert.equal(held.status, 0, held.log);
  assert.equal(held.hold, 'true');
  assert.equal(held.reasons, REASONS);
  assert.match(held.log, /npc_job is missing/, 'the step does not log the reasons');

  const go = runGuard('');
  assert.equal(go.status, 0, go.log);
  assert.equal(go.hold, 'false');
  assert.equal(go.reasons, '');
  assert.equal(go.output.split('\n').filter((line) => line.startsWith('hold=')).length, 1, 'hold is written more than once');
});

test('the guard step writes the reasons under a random delimiter', () => {
  // A fixed one could be ended early by a reason that holds it.
  const first = runGuard(`${REASONS}\n`);
  const second = runGuard(`${REASONS}\n`);
  assert.match(first.delimiter ?? '', /^\S{20,}$/, 'the delimiter is short enough to guess');
  assert.notEqual(first.delimiter, second.delimiter, 'two runs used the same delimiter');
});

test('the guard step fails, and writes no hold, when the guard cannot read an index', () => {
  // The guard prints nothing and exits 1, and an empty stdout must never read as go.
  const run = runGuard('', 1);
  assert.notEqual(run.status, 0, `the step passed when the guard failed\n${run.log}`);
  assert.equal(run.output, '', 'the step wrote an output when the guard failed');
  const partial = runGuard('item lost 150 of 9,800 rows (1.5%)\n', 1);
  assert.notEqual(partial.status, 0, `the step passed when the guard failed after printing\n${partial.log}`);
  assert.equal(partial.output, '', 'the step wrote an output when the guard failed after printing');
});

test('the pr job runs no pnpm script', () => {
  // R33: the job that can push runs only git, gh and node one-liners.
  assert.doesNotMatch(prJob(), /\bpnpm\b|\bnpx\b|\bnpm +(?:run|run-script|test|start|exec|install|i|ci)\b/);
});

test('every output and step value the jobs pass along is one that is written', () => {
  // A misspelt reference evaluates to an empty string, not an error. An empty `changed`
  // would skip the pr job forever, and look like a wiki that never moves.
  const outputs = under(buildJob(), 'outputs');
  const declared = new Map([...outputs.matchAll(/^ *([\w-]+): *\$\{\{ *steps\.([\w-]+)\.outputs\.([\w-]+)(?: *\|\| *'false')? *\}\}$/gm)]
    .map((match) => [match[1]!, { step: match[2]!, name: match[3]! }]));
  assert.equal(outputs.split('\n').filter((line) => line.trim() !== '').length, declared.size, 'the build job declares an output this test cannot read');
  assert.deepEqual([...declared.keys()].sort(), ['changed', 'committed', 'hold', 'reasons', 'rebuilt', 'sha256']);
  // The guard runs only when the content changed, and a skipped step's output is empty, so hold
  // falls back to false. Nothing else may fall back.
  assert.equal(scalar(outputs, 'hold'), "${{ steps.guard.outputs.hold || 'false' }}", 'hold does not fall back to false');
  assert.equal(outputs.match(/\|\|/g)?.length, 1, 'an output other than hold falls back to a value');
  const writes = (id: string) => new Set([...stepScript(workflow(), id).matchAll(/^ *echo "([\w-]+)(?:=|<<)/gm)].map((match) => match[1]!));
  for (const [output, { step, name }] of declared) {
    assert.equal(name, output, `the build output ${output} reads ${name}`);
    assert.ok(writes(step).has(name), `the build output ${output} reads ${step}.${name}, which that step never writes`);
  }
  for (const [job, block] of [['build', buildJob()], ['pr', prJob()], ['alert', alertJob()]] as const) {
    for (const [, id, name] of block.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
      stepIndex(steps(block), id!);
      assert.ok(writes(id!).has(name!), `the ${job} job reads ${id}.${name}, which that step never writes`);
    }
    for (const [, name] of block.matchAll(/needs\.build\.outputs\.([\w-]+)/g)) {
      assert.ok(declared.has(name!), `the ${job} job reads needs.build.outputs.${name}, which the build job does not declare`);
    }
  }
});

test('the pr job commits as github-actions[bot]', () => {
  const propose = steps(prJob())[stepIndex(steps(prJob()), 'propose')]!;
  const env = under(propose.replace(/^( *)- /, '$1  '), 'env');
  for (const who of ['AUTHOR', 'COMMITTER']) {
    assert.match(env, new RegExp(`^ *GIT_${who}_NAME: *github-actions\\[bot\\]$`, 'm'), `GIT_${who}_NAME is not github-actions[bot]`);
    assert.match(env, new RegExp(`^ *GIT_${who}_EMAIL: *41898282\\+github-actions\\[bot\\]@users\\.noreply\\.github\\.com$`, 'm'),
      `GIT_${who}_EMAIL is not github-actions[bot]'s`);
  }
});

test('the committed digest step writes a digest only when index-digest printed one', () => {
  const script = stepScript(workflow(), 'committed');
  const good = runStep(script, { commands: { [SERVER]: fakeServer(`${DIGEST_A}\n`) } });
  assert.equal(good.status, 0, good.log);
  assert.equal(good.output, `digest=${DIGEST_A}\n`);
  for (const [what, stdout] of NOT_DIGESTS) {
    const run = runStep(script, { commands: { [SERVER]: fakeServer(`${stdout}\n`) } });
    assert.notEqual(run.status, 0, `the step passed when index-digest printed ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote an output when index-digest printed ${what}`);
  }
  const refused = runStep(script, { commands: { [SERVER]: fakeServer('', 1) } });
  assert.notEqual(refused.status, 0, 'the step passed when index-digest refused the index');
  assert.equal(refused.output, '', 'the step wrote an output when index-digest refused the index');
});

test('the rebuilt digest step compares the digests and hashes the index it would upload', () => {
  const script = stepScript(workflow(), 'digests');
  const files = { 'index.db': 'rebuilt index' };
  const changed = runStep(script, { files, commands: { [SERVER]: fakeServer(`${DIGEST_B}\n`) }, env: { COMMITTED: DIGEST_A } });
  assert.equal(changed.status, 0, changed.log);
  assert.equal(changed.output, `committed=${DIGEST_A}\nrebuilt=${DIGEST_B}\nsha256=${REBUILT_INDEX_SHA256}\nchanged=true\n`);
  assert.match(changed.log, new RegExp(`${DIGEST_A}[\\s\\S]*${DIGEST_B}`), 'the step does not log both digests');

  const same = runStep(script, { files, commands: { [SERVER]: fakeServer(`${DIGEST_A}\n`) }, env: { COMMITTED: DIGEST_A } });
  assert.equal(same.status, 0, same.log);
  assert.equal(same.output, `committed=${DIGEST_A}\nrebuilt=${DIGEST_A}\nsha256=${REBUILT_INDEX_SHA256}\nchanged=false\n`);
});

test('the rebuilt digest step fails, and decides nothing, on a value that is not a digest', () => {
  const script = stepScript(workflow(), 'digests');
  const files = { 'index.db': 'rebuilt index' };
  for (const [what, value] of NOT_DIGESTS) {
    const committed = runStep(script, { files, commands: { [SERVER]: fakeServer(`${DIGEST_B}\n`) }, env: { COMMITTED: value } });
    assert.notEqual(committed.status, 0, `the step passed with ${what} as the committed digest\n${committed.log}`);
    assert.equal(committed.output, '', `the step wrote outputs with ${what} as the committed digest`);
    const rebuilt = runStep(script, { files, commands: { [SERVER]: fakeServer(`${value}\n`) }, env: { COMMITTED: DIGEST_A } });
    assert.notEqual(rebuilt.status, 0, `the step passed when index-digest printed ${what}\n${rebuilt.log}`);
    assert.equal(rebuilt.output, '', `the step wrote outputs when index-digest printed ${what}`);
  }
});

test('the pr job takes the artifact only when its sha256 is the one the build job output', () => {
  const script = stepScript(workflow(), 'verify');
  const files = { 'index.db': 'committed index' };
  const runnerTemp = { 'index/index.db': 'rebuilt index' };

  const good = runStep(script, { files, runnerTemp, env: { SHA256: REBUILT_INDEX_SHA256 } });
  assert.equal(good.status, 0, good.log);
  assert.equal(good.checkout['index.db'], 'rebuilt index', 'the verified artifact did not replace index.db');

  const cases: Array<[string, Parameters<typeof runStep>[1]]> = [
    ['the artifact hashes to another value', { files, runnerTemp, env: { SHA256: DIGEST_A } }],
    ['the expected sha256 is empty', { files, runnerTemp, env: { SHA256: '' } }],
    ['the expected sha256 is uppercase', { files, runnerTemp, env: { SHA256: REBUILT_INDEX_SHA256.toUpperCase() } }],
    ['the artifact holds no index.db', { files, runnerTemp: { 'index/other.db': 'rebuilt index' }, env: { SHA256: REBUILT_INDEX_SHA256 } }],
  ];
  for (const [what, options] of cases) {
    const run = runStep(script, options);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.checkout['index.db'], 'committed index', `index.db changed when ${what}`);
  }
});

/** package.json as committed, with `version` in place of its own. */
const manifestAt = (version: string): string =>
  readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`);

/** Runs the version step in a checkout at `current`, with npm printing `npmStdout` and exiting `npmExit`. */
const runVersion = (current: string, npmStdout: string, npmExit = 0) =>
  runStep(stepScript(workflow(), 'version'), {
    files: { 'package.json': manifestAt(current) },
    commands: { npm: `process.stdout.write(${JSON.stringify(npmStdout)});\nprocess.exitCode = ${npmExit};\n` },
  });

test('the version step sets the patch after the highest version npm lists in the package major', () => {
  const cases: Array<[string, string[], string]> = [
    ['3.0.0', ['3.0.0'], '3.0.1'],
    // Numbers, not strings: 3.0.10 is above 3.0.9. Other majors and prereleases do not count.
    ['3.0.10', ['2.9.9', '3.0.0', '3.0.9', '3.0.10', '3.0.11-rc.1', '4.0.0'], '3.0.11'],
    ['3.1.2', ['3.0.4', '3.1.2'], '3.1.3'],
    // npm lists versions in publish order, and a patch to an older minor can come last.
    ['3.1.0', ['3.0.0', '3.1.0', '3.0.1'], '3.1.1'],
    // A revert left package.json below the highest published version.
    ['3.0.1', ['3.0.0', '3.0.1', '3.0.2'], '3.0.3'],
  ];
  for (const [current, versions, next] of cases) {
    const list = `${JSON.stringify(versions, null, 2)}\n`;
    const run = runVersion(current, list);
    assert.equal(run.status, 0, `${current} with ${versions.join(', ')} on npm\n${run.log}`);
    assert.equal(run.output, `version=${next}\n`, `${current} with ${versions.join(', ')} on npm`);
    assert.equal(run.checkout['package.json'], manifestAt(next), 'package.json changed in more than its version');
    assert.deepEqual(run.calls, [{ command: 'npm', args: ['view', '@tibia.sh/tibiawiki-data', 'versions', '--json'] }]);
    // Run again while that pull request is open: main and npm are unchanged, and so is the answer.
    assert.equal(runVersion(current, list).output, `version=${next}\n`, 'a second run chose another version');
  }
});

test('the version step fails, and sets nothing, when it cannot find a version npm is missing', () => {
  const cases: Array<[string, string, string, number]> = [
    ['npm cannot read the registry', '3.0.0', '', 1],
    ['npm prints nothing, as it does for a registry answering {}', '3.0.0', '', 0],
    ['npm prints an empty list', '3.0.0', '[]\n', 0],
    ['npm prints something other than a list', '3.0.0', '"3.0.0"\n', 0],
    ['npm prints what is not JSON', '3.0.0', 'npm error\n', 0],
    ['npm lists nothing in the package major', '3.0.0', '["2.0.0", "4.0.0"]\n', 0],
    // Merged but not published yet. Its next patch would be package.json's own version, and
    // merging a pull request that keeps it would publish nothing once that release lands.
    ['package.json holds a version npm does not list yet', '3.0.1', '["3.0.0"]\n', 0],
  ];
  for (const [what, current, npmStdout, npmExit] of cases) {
    const run = runVersion(current, npmStdout, npmExit);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote a version when ${what}`);
    assert.equal(run.checkout['package.json'], manifestAt(current), `package.json changed when ${what}`);
  }
});

/** The commit the stand-in git names as HEAD, and another one. */
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'ffeeddccbbaa99887766554433221100ffeeddcc';

/**
 * What a read of the pull request prints, after the push or in the wait: its state, whether it
 * merged, whether auto-merge is on, and its head.
 */
const poll = (state: 'open' | 'closed', merged: boolean, armed: boolean, sha = HEAD_SHA): string =>
  `${state} ${merged} ${armed} ${sha}\n`;

const MERGED = poll('closed', true, false);
const OPEN = poll('open', false, true);
const DISARMED = poll('open', false, false);
const CLOSED = poll('closed', false, false);
/** A poll gh fails. */
const FAIL = 'FAIL';

/** How the stand-in gh answers the propose step. */
type GhScenario = {
  /** What the lookup of the open pull request prints: `<number> <auto-merge on>`, or nothing. */
  open?: string;
  /** What the read of that pull request after the push prints, as `poll` builds it. */
  reread?: string;
  /** The exit code of `gh pr merge --disable-auto`, and of `gh pr merge --auto`. */
  disable?: number;
  enable?: number;
  /** What each poll of the pull request prints, in turn, the last one repeated. FAIL makes gh fail. */
  polls?: string[];
  /** What `git rev-parse HEAD` prints. */
  head?: string;
};

/**
 * A stand-in gh for the propose step. It answers the lookup, a write, a merge, the read after the
 * push and a poll as gh would with the step's --jq filters, and fails any other call. The read
 * after the push is the first read of a pull request after the update, and every other read is a
 * poll. Each call is a process of its own, so it keeps both facts in RUNNER_TEMP.
 */
const fakeGh = ({ open = '', reread = DISARMED, disable = 0, enable = 0, polls = [MERGED] }: GhScenario = {}): string =>
  `const fs = require('node:fs');\n` +
  `const args = process.argv.slice(2);\n` +
  `const patched = process.env.RUNNER_TEMP + '/patched';\n` +
  `if (args[0] === 'pr' && args[1] === 'merge') process.exitCode = args.includes('--disable-auto') ? ${disable} : ${enable};\n` +
  `else if (args.includes('--method') && args.includes('PATCH')) { fs.writeFileSync(patched, ''); process.stdout.write('https://github.com/tibia-sh/tibiawiki-data/pull/7\\n'); }\n` +
  `else if (args.includes('--method')) process.stdout.write('12\\n');\n` +
  `else if (args[0] === 'api' && /\\/pulls\\?head=/.test(args[1])) process.stdout.write(${JSON.stringify(open)});\n` +
  `else if (args[0] === 'api' && /\\/pulls\\/\\d+$/.test(args[1]) && fs.existsSync(patched)) { fs.rmSync(patched); process.stdout.write(${JSON.stringify(reread)}); }\n` +
  `else if (args[0] === 'api' && /\\/pulls\\/\\d+$/.test(args[1])) {\n` +
  `  const counter = process.env.RUNNER_TEMP + '/polls';\n` +
  `  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\n` +
  `  fs.writeFileSync(counter, String(count + 1));\n` +
  `  const polls = ${JSON.stringify(polls)};\n` +
  `  const answer = polls[Math.min(count, polls.length - 1)];\n` +
  `  if (answer === ${JSON.stringify(FAIL)}) { process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exitCode = 1; }\n` +
  `  else process.stdout.write(answer);\n` +
  `} else { process.stderr.write('the stand-in gh does not answer this call\\n'); process.exitCode = 98; }\n`;

/** A stand-in git that names `head` as HEAD and does nothing else. */
const fakeGit = (head = HEAD_SHA): string =>
  `if (process.argv[2] === 'rev-parse') process.stdout.write(${JSON.stringify(`${head}\n`)});\n`;

const PROPOSE_ENV = {
  GH_TOKEN: 'stand-in-token-value',
  VERSION: '3.0.1',
  COMMITTED: DIGEST_A,
  REBUILT: DIGEST_B,
  HOLD: 'false',
  REASONS: '',
  GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-data',
  GITHUB_REPOSITORY_OWNER: 'tibia-sh',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '4242',
  POLL_SECONDS: '0',
  MERGE_DEADLINE_SECONDS: '60',
  RETRY_SECONDS: '0',
};

const HELD_ENV = { ...PROPOSE_ENV, HOLD: 'true', REASONS };

const runPropose = (gh: GhScenario, env: Record<string, string> = PROPOSE_ENV) =>
  runStep(stepScript(workflow(), 'propose'), { commands: { git: fakeGit(gh.head), gh: fakeGh(gh) }, env });

/** The value after `flag` in `args`, for each time `flag` appears. */
const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));

/**
 * What the step did, in order, each call named in one word with its arguments: lookup, disable,
 * push, create, update, reread, enable, poll. A read is the reread when it is the first one after
 * the update, as the stand-in gh counts it.
 */
const label = (calls: Call[]): Array<{ action: string; args: string[] }> => {
  let updated = false;
  return calls.flatMap(({ command, args }) => {
    const as = (action: string) => [{ action, args }];
    if (command === 'git') return args.includes('push') ? as('push') : [];
    if (args[0] === 'pr' && args[1] === 'merge') return as(args.includes('--disable-auto') ? 'disable' : 'enable');
    if (args.includes('--method')) {
      updated = args.includes('PATCH');
      return as(updated ? 'update' : 'create');
    }
    if (/\/pulls\?head=/.test(args[1] ?? '')) return as('lookup');
    if (updated) {
      updated = false;
      return as('reread');
    }
    return as('poll');
  });
};

const actions = (calls: Call[]): string[] => label(calls).map(({ action }) => action);

/** The arguments of each call the step made as `action`. */
const argsOf = (calls: Call[], action: string): string[][] => label(calls).filter((call) => call.action === action).map(({ args }) => args);

const ghCalls = (calls: Call[]): string[][] => calls.filter((call) => call.command === 'gh').map((call) => call.args);

test('the pr job force-pushes drift/index and opens a pull request carrying both digests', () => {
  const run = runPropose({});
  assert.equal(run.status, 0, run.log);

  const git = run.calls.filter((call) => call.command === 'git').map((call) => call.args);
  const push = git.filter((args) => args.includes('push'));
  assert.equal(push.length, 1, 'expected exactly one git push');
  assert.deepEqual(push[0]!.slice(push[0]!.indexOf('push')), ['push', '--force', 'origin', 'HEAD:refs/heads/drift/index']);
  assert.ok(git.some((args) => args[0] === 'commit'), 'nothing was committed');
  const add = git.find((args) => args[0] === 'add');
  assert.deepEqual(add?.slice(1).sort(), ['index.db', 'package.json'], 'the commit does not take exactly index.db and package.json');
  const commit = git.findIndex((args) => args[0] === 'commit');
  const revParse = git.findIndex((args) => args[0] === 'rev-parse');
  assert.deepEqual(git[revParse], ['rev-parse', 'HEAD'], 'the step does not record the commit it pushes');
  assert.ok(commit < revParse && revParse < git.findIndex((args) => args.includes('push')), 'HEAD is not read between the commit and the push');

  const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
  assert.equal(writes.length, 1, 'expected exactly one pull request write');
  const [create] = writes as [string[]];
  assert.deepEqual(flagValues(create, '--method'), ['POST']);
  assert.ok(create.includes('repos/tibia-sh/tibiawiki-data/pulls'), `the pull request is not created: ${create.join(' ')}`);
  const fields = flagValues(create, '-f');
  assert.ok(fields.includes('head=drift/index'), 'the pull request is not from drift/index');
  assert.ok(fields.includes('base=main'), 'the pull request is not into main');
  assert.ok(fields.includes('title=chore: release a refreshed index as 3.0.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the pull request body does not carry both digests');
  assert.ok(body?.includes('https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242'), 'the body does not link the run');
  assert.doesNotMatch(body ?? '', /Held for review/, 'a refresh that was not held says it was');

  for (const call of run.calls) {
    assert.ok(!call.args.join(' ').includes(PROPOSE_ENV.GH_TOKEN), `the token appears on the command line of ${call.command}`);
  }
});

test('the pr job turns on auto-merge with a rebase on the pull request it opened, and waits for the merge of its commit', () => {
  const run = runPropose({ polls: [OPEN, OPEN, MERGED] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll', 'poll']);
  const gh = ghCalls(run.calls);
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '12', '--auto', '--rebase']);
  for (const args of argsOf(run.calls, 'poll')) {
    assert.deepEqual(args.slice(0, 2), ['api', 'repos/tibia-sh/tibiawiki-data/pulls/12']);
  }
  assert.match(run.log, new RegExp(`#12 merged ${HEAD_SHA}`), 'the step does not say the pull request merged its commit');
});

test('the pr job updates the open drift pull request instead of opening another, and turns on its auto-merge', () => {
  const run = runPropose({ open: '7 false\n' });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'enable', 'poll']);
  const gh = ghCalls(run.calls);
  const lookup = gh.filter((args) => /\/pulls\?head=/.test(args[1] ?? ''));
  assert.equal(lookup.length, 1, 'expected one lookup of the open pull request');
  assert.ok(lookup[0]!.some((arg) => arg.includes('head=tibia-sh:drift/index') && arg.includes('state=open')),
    `the lookup does not ask for an open pull request from drift/index: ${lookup[0]!.join(' ')}`);
  const writes = gh.filter((args) => args.includes('--method'));
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['PATCH']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/pulls/7'), `pull request 7 is not the one updated: ${writes[0]!.join(' ')}`);
  const fields = flagValues(writes[0]!, '-f');
  assert.ok(fields.includes('title=chore: release a refreshed index as 3.0.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the updated body does not carry both digests');
  const reread = argsOf(run.calls, 'reread')[0];
  assert.equal(reread?.[1], 'repos/tibia-sh/tibiawiki-data/pulls/7', 'the pull request is not read again by its number');
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '7', '--auto', '--rebase']);
});

test('the pr job decides auto-merge from the pull request as it is after the push', () => {
  const armed = runPropose({ open: '7 true\n', reread: OPEN, polls: [OPEN, MERGED] });
  assert.equal(armed.status, 0, armed.log);
  assert.deepEqual(actions(armed.calls), ['lookup', 'push', 'update', 'reread', 'poll', 'poll'], 'auto-merge was turned on again');
  const cleared = runPropose({ open: '7 true\n', reread: DISARMED });
  assert.equal(cleared.status, 0, cleared.log);
  assert.deepEqual(actions(cleared.calls), ['lookup', 'push', 'update', 'reread', 'enable', 'poll'], 'auto-merge found off after the push stayed off');
});

test('a pull request that merged between the lookup and the push is replaced by a new one, which the job waits on', () => {
  // Waiting on the old number would take its earlier merge for this run's.
  const run = runPropose({ open: '7 true\n', reread: poll('closed', true, false, OTHER_SHA), polls: [OPEN, MERGED] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'create', 'enable', 'poll', 'poll']);
  const gh = ghCalls(run.calls);
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '12', '--auto', '--rebase']);
  for (const args of argsOf(run.calls, 'poll')) assert.equal(args[1], 'repos/tibia-sh/tibiawiki-data/pulls/12', 'the wait reads the old pull request');
});

test('a pull request that merged the pushed commit before the read after the push ends the step green', () => {
  // That merge is this run's, so no pull request is opened in its place.
  for (const env of [PROPOSE_ENV, HELD_ENV]) {
    const run = runPropose({ open: '7 true\n', reread: MERGED }, env);
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(actions(run.calls), ['lookup', ...(env === HELD_ENV ? ['disable'] : []), 'push', 'update', 'reread']);
    assert.match(run.log, new RegExp(`#7 merged ${HEAD_SHA}`), 'the step does not say the pull request merged its commit');
  }
  // Closed without merging is not this run's, and a new one is opened.
  const closed = runPropose({ open: '7 false\n', reread: CLOSED });
  assert.equal(closed.status, 0, closed.log);
  assert.deepEqual(actions(closed.calls), ['lookup', 'push', 'update', 'reread', 'create', 'enable', 'poll']);
});

test('the pr job fails when the pull request is closed unmerged, or still open at the deadline', () => {
  const closed = runPropose({ polls: [OPEN, CLOSED] });
  assert.notEqual(closed.status, 0, `the step passed when the pull request was closed unmerged\n${closed.log}`);
  assert.match(closed.log, /^::error::.*closed/m, 'the step does not say the pull request was closed');
  assert.deepEqual(actions(closed.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll']);

  const late = runPropose({ polls: [OPEN] }, { ...PROPOSE_ENV, MERGE_DEADLINE_SECONDS: '0' });
  assert.notEqual(late.status, 0, `the step passed when the pull request was still open at the deadline\n${late.log}`);
  assert.match(late.log, /^::error::.*not merged/m, 'the step does not say the pull request has not merged');
  assert.deepEqual(actions(late.calls), ['lookup', 'push', 'create', 'enable', 'poll']);

  for (const odd of ['open\nfalse\n', `open maybe true ${HEAD_SHA}\n`, `open false true ${HEAD_SHA.slice(1)}\n`]) {
    const run = runPropose({ polls: [odd] });
    assert.notEqual(run.status, 0, `the step passed on the poll answer ${JSON.stringify(odd)}\n${run.log}`);
  }
});

test('the pr job fails when the pull request merged a head other than the commit it pushed', () => {
  const run = runPropose({ polls: [poll('closed', true, false, OTHER_SHA)] });
  assert.notEqual(run.status, 0, `the step passed on a merge of another head\n${run.log}`);
  assert.match(run.log, new RegExp(`^::error::.*${OTHER_SHA}.*${HEAD_SHA}`, 'm'), 'the error does not name both commits');
});

test('the pr job turns auto-merge on again once when it finds it off during the wait', () => {
  const run = runPropose({ polls: [OPEN, DISARMED, OPEN, MERGED] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll', 'enable', 'poll', 'poll']);
  assert.match(run.log, /auto-merge .*off.*turned on again/i, 'the step does not log that it turned auto-merge on again');

  const twice = runPropose({ polls: [DISARMED] });
  assert.notEqual(twice.status, 0, `the step passed when auto-merge was found off a second time\n${twice.log}`);
  assert.deepEqual(actions(twice.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'enable', 'poll']);
  assert.match(twice.log, /^::error::.*second time/m);
});

test('the wait reads the pull request again after a failed read, and fails on the third in a row', () => {
  const twice = runPropose({ polls: [FAIL, FAIL, MERGED] });
  assert.equal(twice.status, 0, `two failed reads ended the wait\n${twice.log}`);
  assert.deepEqual(actions(twice.calls).filter((action) => action === 'poll').length, 3);

  const reset = runPropose({ polls: [FAIL, FAIL, OPEN, FAIL, FAIL, MERGED] });
  assert.equal(reset.status, 0, `a good read did not reset the count\n${reset.log}`);

  const thrice = runPropose({ polls: [FAIL, FAIL, FAIL, MERGED] });
  assert.notEqual(thrice.status, 0, `the step passed after three failed reads in a row\n${thrice.log}`);
  assert.deepEqual(actions(thrice.calls).filter((action) => action === 'poll').length, 3, 'the step read a fourth time');
  assert.match(thrice.log, /^::error::.*3 times/m);
});

test('a held refresh turns off auto-merge before it pushes, and opens or updates the pull request with the reasons', () => {
  const run = runPropose({ open: '7 true\n' }, HELD_ENV);
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'disable', 'push', 'update', 'reread']);
  assert.deepEqual(ghCalls(run.calls).find((args) => args[0] === 'pr'), ['pr', 'merge', '7', '--disable-auto']);
  const body = flagValues(ghCalls(run.calls).find((args) => args.includes('--method'))!, '-f').find((field) => field.startsWith('body='));
  assert.ok(body?.startsWith('body=**Held for review.** The refresh was not merged, because:\n\n' +
    '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing\n\n'), `the held body does not start with the reasons: ${body}`);
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the held body does not carry both digests');
});

test('a held refresh turns off auto-merge that is on again after the push', () => {
  const run = runPropose({ open: '7 false\n', reread: OPEN }, HELD_ENV);
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'disable']);
});

test('a held refresh without auto-merge on turns it neither off nor on', () => {
  const updated = runPropose({ open: '7 false\n' }, HELD_ENV);
  assert.equal(updated.status, 0, updated.log);
  assert.deepEqual(actions(updated.calls), ['lookup', 'push', 'update', 'reread']);
  const created = runPropose({}, HELD_ENV);
  assert.equal(created.status, 0, created.log);
  assert.deepEqual(actions(created.calls), ['lookup', 'push', 'create']);
  const body = flagValues(ghCalls(created.calls).find((args) => args.includes('--method'))!, '-f').find((field) => field.startsWith('body='));
  assert.ok(body?.startsWith('body=**Held for review.**'), 'the new held pull request does not say it is held');
  const replaced = runPropose({ open: '7 false\n', reread: poll('closed', true, false, OTHER_SHA) }, HELD_ENV);
  assert.equal(replaced.status, 0, replaced.log);
  assert.deepEqual(actions(replaced.calls), ['lookup', 'push', 'update', 'reread', 'create']);
});

test('a held refresh pushes nothing when auto-merge cannot be turned off', () => {
  const run = runPropose({ open: '7 true\n', disable: 1 }, HELD_ENV);
  assert.notEqual(run.status, 0, `the step passed when --disable-auto failed\n${run.log}`);
  assert.deepEqual(actions(run.calls), ['lookup', 'disable']);
  assert.deepEqual(run.calls.filter((call) => call.command === 'git'), [], 'git ran after --disable-auto failed');
});

test('the pr job goes no further when the lookup or the read after the push answers with another shape', () => {
  for (const open of ['7\n', 'x true\n', '7 yes\n', '7 true extra\n']) {
    const run = runPropose({ open });
    assert.notEqual(run.status, 0, `the step passed when the lookup printed ${JSON.stringify(open)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup'], `the step went on after the lookup printed ${JSON.stringify(open)}`);
  }
  for (const reread of ['', 'open false\n', `merged true false ${HEAD_SHA}\n`, `open yes false ${HEAD_SHA}\n`]) {
    const run = runPropose({ open: '7 false\n', reread });
    assert.notEqual(run.status, 0, `the step passed when the read after the push printed ${JSON.stringify(reread)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread'], `the step went on after the read printed ${JSON.stringify(reread)}`);
  }
});

test('the pr job pushes nothing when git does not name the commit it made', () => {
  for (const head of ['', HEAD_SHA.slice(1), HEAD_SHA.toUpperCase(), `${HEAD_SHA}\n${OTHER_SHA}`]) {
    const run = runPropose({ head });
    assert.notEqual(run.status, 0, `the step passed when git rev-parse HEAD printed ${JSON.stringify(head)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup'], `the step pushed when git rev-parse HEAD printed ${JSON.stringify(head)}`);
  }
});

test('the pr job pushes and opens nothing when a value it was given is not valid', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['the committed digest is empty', { COMMITTED: '' }],
    ['the rebuilt digest is not hex', { REBUILT: `${DIGEST_B.slice(1)}g` }],
    ['the version is empty', { VERSION: '' }],
    ['the version is not x.y.z', { VERSION: '3.0.1; echo' }],
    ['hold is empty', { HOLD: '' }],
    ['hold is neither true nor false', { HOLD: 'yes' }],
    ['a held refresh has no reasons', { HOLD: 'true', REASONS: '' }],
    ['the poll interval is not a whole number', { POLL_SECONDS: 'x' }],
    ['the deadline is negative', { MERGE_DEADLINE_SECONDS: '-1' }],
    ['the retry pause is not a whole number', { RETRY_SECONDS: '1.5' }],
  ];
  for (const [what, override] of cases) {
    const run = runPropose({}, { ...PROPOSE_ENV, ...override });
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the step ran ${run.calls.map((call) => call.command).join(', ')} when ${what}`);
  }
});

/** The title the alert job looks for and opens its issue with. */
const ALERT_TITLE = 'The drift job needs a look';

const ALERT_ENV = {
  GH_TOKEN: 'stand-in-token-value',
  BUILD_RESULT: 'success',
  PR_RESULT: 'success',
  HOLD: 'true',
  REASONS,
  GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-data',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '4242',
};

const BOT = { login: 'github-actions[bot]' };
const ALERT_ISSUE = { number: 30, title: ALERT_TITLE, user: BOT };
/** Issues the alert job must pass over: the title by another author, a pull request, another title. */
const NOT_ALERT_ISSUES = [
  { number: 31, title: ALERT_TITLE, user: { login: 'drptbl' } },
  { number: 32, title: ALERT_TITLE, user: BOT, pull_request: { url: 'https://api.github.com/repos/tibia-sh/tibiawiki-data/pulls/32' } },
  { number: 33, title: `${ALERT_TITLE} again`, user: BOT },
];

/** A stand-in gh that lists `issues` as one page, answers a write with a URL, and exits `listExit` for the list. */
const fakeAlertGh = (issues: unknown[], listExit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.includes('--method')) process.stdout.write('https://github.com/tibia-sh/tibiawiki-data/issues/40\\n');\n` +
  `else { process.stdout.write(${JSON.stringify(`${JSON.stringify([issues])}\n`)}); process.exitCode = ${listExit}; }\n`;

const runAlert = (issues: unknown[], env: Record<string, string> = ALERT_ENV, listExit = 0) =>
  runStep(stepScript(workflow(), 'alert'), { commands: { gh: fakeAlertGh(issues, listExit) }, env });

test('the alert comments on the open alert issue with the run and the reasons it held', () => {
  const run = runAlert([...NOT_ALERT_ISSUES, ALERT_ISSUE]);
  assert.equal(run.status, 0, run.log);
  const gh = ghCalls(run.calls);
  const [list, ...writes] = gh;
  assert.ok(list!.some((arg) => arg === 'repos/tibia-sh/tibiawiki-data/issues?state=open&per_page=100'), `unexpected list call: ${list!.join(' ')}`);
  assert.ok(list!.includes('--paginate') && list!.includes('--slurp'), 'the list does not read every page');
  assert.equal(writes.length, 1, 'expected exactly one write');
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['POST']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues/30/comments'), `the comment is not on issue 30: ${writes[0]!.join(' ')}`);
  assert.deepEqual(flagValues(writes[0]!, '-f'), [
    'body=Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe refresh was held for review:\n\n' +
      '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing',
  ]);
});

test('the alert opens the issue, assigned to the maintainer, when none of the open ones is its own', () => {
  for (const issues of [[], NOT_ALERT_ISSUES]) {
    const run = runAlert(issues);
    assert.equal(run.status, 0, run.log);
    const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
    assert.equal(writes.length, 1, 'expected exactly one write');
    assert.deepEqual(flagValues(writes[0]!, '--method'), ['POST']);
    assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues'), `the issue is not opened: ${writes[0]!.join(' ')}`);
    const fields = flagValues(writes[0]!, '-f');
    assert.ok(fields.includes(`title=${ALERT_TITLE}`), `unexpected title in ${fields.join(' | ')}`);
    assert.ok(fields.includes('assignees[]=drptbl'), 'the issue is not assigned to drptbl');
    const body = fields.find((field) => field.startsWith('body='));
    assert.ok(body?.endsWith('Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe refresh was held for review:\n\n' +
      '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing'), `the issue body does not end with the alert: ${body}`);
    assert.ok((body?.length ?? 0) > 'body=Run: '.length + 200, 'the issue body does not say what the issue is for');
  }
});

test('the alert names each job that did not succeed, and its result', () => {
  const cases: Array<[Record<string, string>, string[]]> = [
    [{ BUILD_RESULT: 'failure', PR_RESULT: 'skipped' }, ['build', 'failure']],
    [{ BUILD_RESULT: 'cancelled', PR_RESULT: 'skipped' }, ['build', 'cancelled']],
    [{ PR_RESULT: 'failure' }, ['pr', 'failure']],
    [{ PR_RESULT: 'cancelled' }, ['pr', 'cancelled']],
  ];
  for (const [env, [job, result]] of cases) {
    const run = runAlert([ALERT_ISSUE], { ...ALERT_ENV, HOLD: 'false', REASONS: '', ...env });
    assert.equal(run.status, 0, run.log);
    const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
    assert.deepEqual(flagValues(writes[0]!, '-f'),
      [`body=Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe ${job} job did not succeed. Its result is ${result}.`]);
  }
  // A pr job skipped because nothing changed, or because the build failed, is not named.
  const held = runAlert([ALERT_ISSUE], { ...ALERT_ENV, PR_RESULT: 'skipped' });
  assert.equal(held.status, 0, held.log);
  assert.doesNotMatch(flagValues(ghCalls(held.calls).find((args) => args.includes('--method'))!, '-f')[0]!, /pr job/);
});

test('the alert opens nothing when it cannot list the open issues', () => {
  // Opening one then would put a second alert issue beside the first.
  const run = runAlert([ALERT_ISSUE], ALERT_ENV, 1);
  assert.notEqual(run.status, 0, `the step passed when the list failed\n${run.log}`);
  assert.equal(ghCalls(run.calls).filter((args) => args.includes('--method')).length, 0, 'the step wrote after the list failed');
});
