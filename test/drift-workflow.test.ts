import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { code, keys, read, runScripts, runStep, stepIf, stepIndex, stepName, steps, stepScript, under } from './workflow.ts';

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

/** A scalar key's value at a block's shallowest indentation. */
const scalar = (block: string, key: string): string | undefined => {
  const depth = Math.min(...block.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return new RegExp(`^ {${depth}}${key}: *(.*)$`, 'm').exec(block)?.[1];
};

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

test('the workflow runs on a weekly schedule and by hand, and on nothing else', () => {
  assert.deepEqual(keys(under(code(workflow()), 'on')), ['schedule', 'workflow_dispatch'],
    'the drift workflow has a trigger other than its schedule and workflow_dispatch');
  const crons = [...workflow().matchAll(/^ *- *cron: *'([^']*)'(.*)$/gm)];
  assert.equal(crons.length, 1, 'expected exactly one cron schedule');
  const expression = crons[0]![1]!;
  const rest = crons[0]![2]!;
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...extra] = expression.trim().split(/\s+/);
  assert.equal(extra.length, 0, `${expression} is not a five-field cron`);
  assert.ok(/^\d+$/.test(minute ?? '') && Number(minute) <= 59, `${expression} does not run at one fixed minute`);
  assert.ok(/^\d+$/.test(hour ?? '') && Number(hour) <= 23, `${expression} does not run at one fixed hour`);
  assert.equal(dayOfMonth, '*', `${expression} is not weekly`);
  assert.equal(month, '*', `${expression} is not weekly`);
  assert.match(dayOfWeek ?? '', /^[0-6]$/, `${expression} does not run on exactly one day of the week`);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(dayOfWeek)]!;
  assert.match(rest, new RegExp(`#.*\\b${day}`), `the schedule runs on ${day}, and its comment does not say so`);
});

test('no job in the drift workflow can mint an OIDC token', () => {
  // This workflow never publishes. Without id-token, a mistake in it cannot either.
  assert.doesNotMatch(workflow(), /id-token/);
});

test('the drift workflow never publishes, merges or turns on auto-merge', () => {
  // The pull request is the only gate before a publish, so nothing here may get past it.
  const body = code(workflow());
  for (const [what, pattern] of [
    ['npm publish', /\bnpm +publish\b/],
    ['gh pr merge', /\bgh +pr +merge\b/],
    ['--auto', /--auto\b/],
    ['the REST merge endpoint', /\/merge\b/],
    ['GraphQL auto-merge', /enablePullRequestAutoMerge/],
  ] as const) {
    assert.doesNotMatch(body, pattern, `the drift workflow runs ${what}`);
  }
});

test('the workflow grants nothing by default, and the build job can only read', () => {
  // The build job runs the generator over content anyone can edit.
  assert.match(code(workflow()), /^permissions: *\{\}$/m, 'the workflow-level permissions grant something');
  assert.deepEqual(grants(under(buildJob(), 'permissions')), ['contents: read'],
    'the build job does not hold exactly contents: read');
});

test('the pr job holds exactly contents: write and pull-requests: write', () => {
  assert.deepEqual(grants(under(prJob(), 'permissions')), ['contents: write', 'pull-requests: write']);
});

test('the pr job waits for the build job, and runs only on main when the digests differ', () => {
  assert.equal(scalar(prJob(), 'needs'), 'build', 'the pr job does not need the build job');
  assert.equal(scalar(prJob(), 'if'), "${{ github.ref == 'refs/heads/main' && needs.build.outputs.changed == 'true' }}",
    'the pr job is not gated on main and on a changed digest');
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

test('neither job restores or saves a cache', () => {
  // A cache the build job saved would carry whatever the generator run left into later
  // runs, and into ci.yml. Both setup actions cache by themselves unless told not to.
  const all = [...steps(buildJob()), ...steps(prJob())];
  assert.doesNotMatch(all.join('\n'), /uses: *actions\/cache/, 'a step uses actions/cache');
  const nodes = all.filter((step) => /uses: *actions\/setup-node@/.test(step));
  assert.equal(nodes.length, 2, 'expected one setup-node in each job');
  for (const step of nodes) {
    assert.match(step, /^ *package-manager-cache: *false$/m, 'setup-node caches the package manager store');
    assert.doesNotMatch(step, /^ *cache:/m, 'setup-node restores a dependency cache');
  }
  const uvs = all.filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.match(uvs[0]!, /^ *enable-cache: *false$/m, 'setup-uv caches');
});

test('the build job installs an exact uv version', () => {
  // setup-uv checks a download only against the checksums it ships, which stop at the uv
  // versions out when that setup-uv was released. It skips the check for any later uv, and
  // `latest` or a range can resolve to one.
  const uvs = steps(buildJob()).filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.match(uvs[0]!, /^ *version: *'?\d+\.\d+\.\d+'?$/m, 'setup-uv does not install an exact uv version');
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

test('the pr job runs no pnpm script', () => {
  // R33: the job that can push runs only git, gh and node one-liners.
  assert.doesNotMatch(prJob(), /\bpnpm\b|\bnpx\b|\bnpm +(?:run|run-script|test|start|exec|install|i|ci)\b/);
});

test('every output and step value the jobs pass along is one that is written', () => {
  // A misspelt reference evaluates to an empty string, not an error. An empty `changed`
  // would skip the pr job forever, and look like a wiki that never moves.
  const outputs = under(buildJob(), 'outputs');
  const declared = new Map([...outputs.matchAll(/^ *([\w-]+): *\$\{\{ *steps\.([\w-]+)\.outputs\.([\w-]+) *\}\}$/gm)]
    .map((match) => [match[1]!, { step: match[2]!, name: match[3]! }]));
  assert.deepEqual([...declared.keys()].sort(), ['changed', 'committed', 'rebuilt', 'sha256']);
  const writes = (id: string) => new Set([...stepScript(workflow(), id).matchAll(/^ *echo "([\w-]+)=/gm)].map((match) => match[1]!));
  for (const [output, { step, name }] of declared) {
    assert.equal(name, output, `the build output ${output} reads ${name}`);
    assert.ok(writes(step).has(name), `the build output ${output} reads ${step}.${name}, which that step never writes`);
  }
  for (const [job, block] of [['build', buildJob()], ['pr', prJob()]] as const) {
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

/** A stand-in gh: the open pull request lookup prints `open`, and every write prints a URL. */
const fakeGh = (open: string): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.includes('--method')) process.stdout.write('https://github.com/tibia-sh/tibiawiki-data/pull/12\\n');\n` +
  `else process.stdout.write(${JSON.stringify(open)});\n`;

const PROPOSE_ENV = {
  GH_TOKEN: 'stand-in-token-value',
  VERSION: '3.0.1',
  COMMITTED: DIGEST_A,
  REBUILT: DIGEST_B,
  GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-data',
  GITHUB_REPOSITORY_OWNER: 'tibia-sh',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '4242',
};

/** The value after `flag` in `args`, for each time `flag` appears. */
const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));

test('the pr job force-pushes drift/index and opens a pull request carrying both digests', () => {
  const run = runStep(stepScript(workflow(), 'propose'), { commands: { git: '', gh: fakeGh('') }, env: PROPOSE_ENV });
  assert.equal(run.status, 0, run.log);

  const git = run.calls.filter((call) => call.command === 'git').map((call) => call.args);
  const push = git.filter((args) => args.includes('push'));
  assert.equal(push.length, 1, 'expected exactly one git push');
  assert.deepEqual(push[0]!.slice(push[0]!.indexOf('push')), ['push', '--force', 'origin', 'HEAD:refs/heads/drift/index']);
  assert.ok(git.some((args) => args[0] === 'commit'), 'nothing was committed');
  const add = git.find((args) => args[0] === 'add');
  assert.deepEqual(add?.slice(1).sort(), ['index.db', 'package.json'], 'the commit does not take exactly index.db and package.json');

  const gh = run.calls.filter((call) => call.command === 'gh').map((call) => call.args);
  const writes = gh.filter((args) => args.includes('--method'));
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

  for (const call of run.calls) {
    assert.ok(!call.args.join(' ').includes(PROPOSE_ENV.GH_TOKEN), `the token appears on the command line of ${call.command}`);
    assert.ok(!call.args.some((arg) => /\bmerge\b/.test(arg)), `${call.command} was asked to merge: ${call.args.join(' ')}`);
  }
});

test('the pr job updates the open drift pull request instead of opening another', () => {
  const run = runStep(stepScript(workflow(), 'propose'), { commands: { git: '', gh: fakeGh('7\n') }, env: PROPOSE_ENV });
  assert.equal(run.status, 0, run.log);
  const gh = run.calls.filter((call) => call.command === 'gh').map((call) => call.args);
  const lookup = gh.filter((args) => !args.includes('--method'));
  assert.equal(lookup.length, 1, 'expected one lookup of the open pull request');
  assert.ok(lookup[0]!.some((arg) => arg.includes('head=tibia-sh:drift/index') && arg.includes('state=open')),
    `the lookup does not ask for an open pull request from drift/index: ${lookup[0]!.join(' ')}`);
  const writes = gh.filter((args) => args.includes('--method'));
  assert.equal(writes.length, 1, 'expected exactly one pull request write');
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['PATCH']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/pulls/7'), `pull request 7 is not the one updated: ${writes[0]!.join(' ')}`);
  const fields = flagValues(writes[0]!, '-f');
  assert.ok(fields.includes('title=chore: release a refreshed index as 3.0.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the updated body does not carry both digests');
});

test('the pr job pushes and opens nothing when a digest or the version is not valid', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['the committed digest is empty', { COMMITTED: '' }],
    ['the rebuilt digest is not hex', { REBUILT: `${DIGEST_B.slice(1)}g` }],
    ['the version is empty', { VERSION: '' }],
    ['the version is not x.y.z', { VERSION: '3.0.1; echo' }],
  ];
  for (const [what, override] of cases) {
    const run = runStep(stepScript(workflow(), 'propose'), { commands: { git: '', gh: fakeGh('') }, env: { ...PROPOSE_ENV, ...override } });
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the step ran ${run.calls.map((call) => call.command).join(', ')} when ${what}`);
  }
});
