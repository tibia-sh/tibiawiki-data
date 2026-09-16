import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { code, keys, read, runScripts, runStep, scalar, stepBody, stepIf, stepIndex, stepInputs, stepName, steps, stepScript, under, workflowFiles } from './workflow.ts';
import type { Call } from './workflow.ts';

/**
 * The release workflow cannot run inside the suite, and a mistake in it surfaces only when
 * a merge publishes, or fails to: a version npm never lets be reused, or a release that
 * quietly never happens. Most properties pinned here are checkable from the files alone.
 * The existence check's decision, what the publish step hands on and the hosting dispatch
 * are not, so their scripts run here against stand-in commands.
 */

const workflow = (): string => read('release.yml');

const releaseJob = (): string => under(under(code(workflow()), 'jobs'), 'release');

/** The job that pages every item through the oldest and the newest published servers before anything is published. */
const gateJob = (): string => under(under(code(workflow()), 'jobs'), 'oldest-consumer');

/** The release job's steps, one string per list item. */
const releaseSteps = (): string[] => steps(releaseJob());

/** The step that asks the registry whether this version exists. Every publishing step waits on it. */
const CHECK_ID = 'registry';

/** The condition every step after that check carries. */
const PUBLISH_GATE = `\${{ steps.${CHECK_ID}.outputs.publish == 'true' }}`;

/** The step that runs npm publish, and hands the hosting job what it published. */
const PUBLISH_ID = 'publish';

/** The job that tells the hosting repository about the release, once npm accepted the publish. */
const hostingJob = (): string => under(under(code(workflow()), 'jobs'), 'hosting');

/** The hosting job's one step, which sends the dispatch. docs/RELEASING.md names it. */
const DISPATCH_ID = 'dispatch';

const dispatchStep = (): string => {
  const list = steps(hostingJob());
  return list[stepIndex(list, DISPATCH_ID)]!;
};

const isPnpmSetup = (step: string): boolean => /^ *(?:- +)?uses: *pnpm\/setup@/m.test(step);

/**
 * Whether a step installs from the lockfile: a script running `pnpm install --frozen-lockfile`,
 * or pnpm/setup with install and require-lockfile, which runs that command itself.
 */
const installsFromLockfile = (step: string): boolean =>
  /\bpnpm install --frozen-lockfile\b/.test(step) ||
  (isPnpmSetup(step) && scalar(stepInputs(step), 'install') === 'true' && scalar(stepInputs(step), 'require-lockfile') === 'true');

/**
 * Every pnpm/setup step in every workflow, with the file and the job it runs in. A pnpm/setup step
 * these readers cannot find, such as one written as a flow mapping, fails the calling test.
 */
const pnpmSetupSteps = (): Array<{ file: string; job: string; step: string }> => {
  const found = workflowFiles().flatMap((file) => {
    const jobs = under(code(read(file)), 'jobs');
    return keys(jobs).flatMap((job) => steps(under(jobs, job)).filter(isPnpmSetup).map((step) => ({ file, job, step })));
  });
  const written = workflowFiles().reduce((count, file) => count + code(read(file)).split('pnpm/setup@').length - 1, 0);
  assert.equal(found.length, written, 'a pnpm/setup step is written in a form this test cannot read, such as a flow mapping');
  return found;
};

/**
 * Runs the existence check the way a runner does, in a checkout whose package.json has
 * `version`. The npm it finds first on PATH prints `npmStdout`, writes `npmStderr` to stderr
 * and exits `npmExit`.
 */
function runCheck({ version, npmStdout, npmStderr = '', npmExit }: {
  version: string;
  npmStdout: string;
  npmStderr?: string;
  npmExit: number;
}) {
  return runStep(stepScript(workflow(), CHECK_ID), {
    files: { 'package.json': JSON.stringify({ name: '@tibia.sh/tibiawiki-data', version }) },
    commands: {
      npm: `process.stdout.write(${JSON.stringify(npmStdout)});\n` +
        `process.stderr.write(${JSON.stringify(npmStderr)});\n` +
        `process.exitCode = ${npmExit};\n`,
    },
  });
}

test('the workflow file has the exact name the npm trusted publisher is registered with', () => {
  // npm matches the file name exactly and does not validate it when saved, so a rename
  // breaks publishing with no warning. readdir rather than an existence check, because a
  // case-insensitive disk would also find Release.yml.
  assert.ok(workflowFiles().includes('release.yml'), '.github/workflows/release.yml is missing');
});

test('only a push to main runs the release workflow', () => {
  // Any other trigger, a pull request or a manual dispatch from a branch, would publish a
  // version from a commit that never merged, under provenance naming that commit.
  const on = under(code(workflow()), 'on');
  assert.deepEqual(keys(on), ['push'], 'the release workflow has a trigger other than push');
  const push = under(on, 'push');
  assert.deepEqual(keys(push), ['branches'], 'the push trigger filters on more than its branch');
  assert.match(push, /^ *branches: *\[ *main *\]$/m, 'the push trigger is not limited to main');
});

test('the release job runs only after the oldest-consumer gate passes', () => {
  // Without needs, the release job starts beside the gate and can publish before the gate fails.
  // A condition on the release job, such as always(), runs it even when the gate failed.
  assert.ok(keys(under(code(workflow()), 'jobs')).includes('oldest-consumer'), 'release.yml has no oldest-consumer job');
  assert.equal(scalar(releaseJob(), 'needs'), 'oldest-consumer', 'the release job does not need the oldest-consumer job');
  assert.equal(scalar(releaseJob(), 'if'), undefined, 'the release job has a condition, which can run it after the gate failed');
});

test('the oldest-consumer job holds exactly contents: read, and no id-token', () => {
  // It runs a published server over the index, and publishes nothing.
  const permissions = under(gateJob(), 'permissions');
  assert.deepEqual(keys(permissions), ['contents'], 'the oldest-consumer job does not hold exactly one permission, contents');
  assert.equal(scalar(permissions, 'contents'), 'read', 'the oldest-consumer job holds more than contents: read');
  assert.doesNotMatch(gateJob(), /\bid-token\b/, 'the oldest-consumer job can mint an OIDC token');
});

test('the oldest-consumer job runs pnpm oldest-consumer unconditionally, bounded at 45 minutes', () => {
  // A condition or continue-on-error on the job or on one of its steps can hide a failed or
  // skipped sweep. The script's own bounds add up to 2190 s with two consumers, and the rest of
  // the 45 minutes is checkout and setup.
  assert.ok(steps(gateJob()).some((step) => /^ *(?:- +)?run: *pnpm oldest-consumer$/m.test(step)),
    'the oldest-consumer job never runs pnpm oldest-consumer');
  assert.doesNotMatch(gateJob(), /^ *(?:- +)?(?:if|continue-on-error):/m,
    'the oldest-consumer job or one of its steps has a condition or continue-on-error');
  assert.equal(scalar(gateJob(), 'timeout-minutes'), '45', 'the oldest-consumer job is not bounded at 45 minutes');
});

test('the release job can mint the OIDC token npm publish authenticates with', () => {
  // The job's permissions replace the workflow's. Without id-token: write, npm publish fails ENEEDAUTH.
  assert.match(under(releaseJob(), 'permissions'), /^ *id-token: *write$/m, 'the release job has no id-token: write');
});

test('no npm token appears in any workflow', () => {
  // A token here silently undoes the move to trusted publishing. _authToken is the npmrc key
  // token auth is written to, whatever the variable carrying it is called.
  for (const name of workflowFiles()) {
    assert.doesNotMatch(read(name), /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/i, `${name} carries an npm token`);
  }
});

test('provenance is left to trusted publishing', () => {
  // Trusted publishing generates the provenance attestation by itself. The flag is redundant
  // at best, and the variable set to false turns the attestation off.
  for (const name of workflowFiles()) {
    assert.doesNotMatch(read(name), /--provenance|NPM_CONFIG_PROVENANCE/i, `${name} sets provenance by hand`);
  }
});

test('every action in every workflow is pinned to a full commit SHA', () => {
  for (const name of workflowFiles()) {
    const yaml = code(read(name));
    // A step written as a flow mapping, `- { uses: ... }`, counts as much as a block one.
    const refs = [...yaml.matchAll(/(?:^|[{,]) *(?:- +)?uses: *([^\s,}]+)/gm)].map((match) => match[1]!);
    assert.equal(refs.length, yaml.split(/\buses:/).length - 1, `${name} has a uses: this test cannot read`);
    for (const ref of refs) {
      assert.match(ref, /@[0-9a-f]{40}$/, `${name}: ${ref} is not pinned to a full commit SHA`);
    }
  }
  assert.ok(code(workflow()).includes('uses:'), 'release.yml uses no actions, so this check proves nothing for it');
});

test('every pnpm/setup step in every workflow runs a frozen install, and takes the pnpm version and Node from elsewhere', () => {
  // With install and require-lockfile, the action runs `pnpm install --frozen-lockfile` itself and
  // saves its lockfile-verification record right after it. With `install: false` the record is
  // saved only at the end of the job, after the generator and the tests. A version input would be
  // a second source for the pnpm version beside packageManager. A runtime input would put a second
  // Node on PATH, ahead of the one setup-node installs.
  const setups = pnpmSetupSteps();
  assert.ok(setups.length > 0, 'no workflow sets up pnpm with pnpm/setup, so this check proves nothing');
  for (const { file, job, step } of setups) {
    const inputs = stepInputs(step);
    const where = `pnpm/setup in the ${job} job of ${file}`;
    assert.equal(scalar(inputs, 'install'), 'true', `${where} does not set install: true`);
    assert.equal(scalar(inputs, 'require-lockfile'), 'true', `${where} does not set require-lockfile: true`);
    assert.equal(scalar(inputs, 'version'), undefined, `${where} sets a pnpm version beside packageManager`);
    assert.equal(scalar(inputs, 'runtime'), undefined, `${where} installs a runtime`);
  }
  // Without a runtime input, pnpm/setup installs every runtime package.json declares in
  // devEngines.runtime, so a runtime declared there lands on PATH ahead of setup-node's Node too.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devEngines?: { runtime?: unknown };
  };
  assert.equal(manifest.devEngines?.runtime, undefined,
    'package.json declares devEngines.runtime, which pnpm/setup installs ahead of setup-node');
});

test('only the ci.yml test and oldest-consumer jobs cache the pnpm store', () => {
  // pnpm/setup saves the store at the end of the job, after everything the job ran, and restores it
  // in every job that asks. The ci.yml jobs can only read the repository and publish nothing. In
  // release.yml a restored store would be input no one reviewed: its gate decides whether the release
  // job publishes, and the release job holds id-token: write. The drift build job would save one
  // after the generator ran.
  const cached = pnpmSetupSteps().flatMap(({ file, job, step }) => {
    const cache = scalar(stepInputs(step), 'cache');
    return cache === undefined ? [] : [`${file} ${job} cache: ${cache}`];
  });
  assert.deepEqual(cached, ['ci.yml test cache: true', 'ci.yml oldest-consumer cache: true'],
    'pnpm/setup caches the store somewhere other than the ci.yml test and oldest-consumer jobs');
});

test('no run script in any workflow interpolates an expression', () => {
  // GitHub pastes an expression's value into the script before the shell parses it, so a
  // value carrying quotes or $(...) runs as code. Values reach a script through env: instead.
  assert.ok(runScripts(workflow()).length > 0, 'release.yml has no run: scripts, so this check proves nothing');
  for (const name of workflowFiles()) {
    for (const script of runScripts(read(name))) {
      const line = script.split('\n').find((text) => text.includes('${{'));
      assert.equal(line, undefined, `a run: script in ${name} interpolates an expression: ${line?.trim()}`);
    }
  }
});

test('the npm that publishes is installed at an exact version, no older than 11.5.1', () => {
  // The job holds id-token: write, so a floating install is the one unpinned thing in it, and
  // trusted publishing needs npm 11.5.1 or later. Each global install is checked, not just the
  // first, because the last one wins.
  const specs = [...code(workflow()).matchAll(/\bnpm +(?:install|i|add)\b([^\n;&|]*)/g)]
    .map((match) => match[1]!.trim().split(/ +/))
    .filter((args) => args.includes('-g') || args.includes('--global'))
    .flatMap((args) => args.filter((arg) => /^npm(@|$)/.test(arg)));
  assert.ok(specs.length > 0, 'no step installs the npm that trusted publishing needs');
  for (const spec of specs) {
    const version = /^npm@(\d+)\.(\d+)\.(\d+)$/.exec(spec);
    assert.ok(version, `${spec} is not an exact version`);
    const [major, minor, patch] = version.slice(1).map(Number) as [number, number, number];
    assert.ok(
      major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))),
      `${spec} is older than 11.5.1, the first npm that publishes with trusted publishing`,
    );
  }
});

test('the release job publishes the committed index and never regenerates it', () => {
  // The artefact published must be the index.db reviewed in the pull request. Regenerating
  // belongs to the drift job, and a crawl here would publish bytes no one has seen.
  assert.doesNotMatch(code(workflow()), /\bbuild-index\b|scripts\/build\.ts|\buvx?\b|tibiawikisql/);
});

test('the release job checks the registry for this exact version, never latest', () => {
  // A comparison with latest fails both ways: a revert leaves version below latest, so every
  // later push would try to republish an existing version, and npm publish moves latest itself.
  // The check reads the whole version list because npm 12.0.2's `npm view name@version`
  // exits 1 for a missing version and for an unreadable registry alike, measured.
  const steps = releaseSteps();
  assert.match(steps[stepIndex(steps, CHECK_ID)]!, /\bnpm view "\$name" versions --json\b/,
    'the existence check does not read the version list from the registry');
  assert.doesNotMatch(steps.join('\n'), /\blatest\b|dist-tags/, 'a release step compares against latest');
});

test('the existence check asks to publish a version only when npm does not list it', () => {
  const list = '[\n  "3.0.0"\n]\n';
  const present = runCheck({ version: '3.0.0', npmStdout: list, npmExit: 0 });
  assert.equal(present.status, 0, `the check failed for a version npm has\n${present.log}`);
  assert.equal(present.output, '', 'the check asked to publish a version npm already has');
  assert.deepEqual(present.calls, [{ command: 'npm', args: ['view', '@tibia.sh/tibiawiki-data', 'versions', '--json'] }],
    'the check did not read the version list of the package named in package.json');

  const absent = runCheck({ version: '3.0.1', npmStdout: list, npmExit: 0 });
  assert.equal(absent.status, 0, `the check failed for a version npm lacks\n${absent.log}`);
  assert.equal(absent.output, 'publish=true\n', 'the check did not ask to publish a version npm lacks');
});

test('the existence check fails, and asks for nothing, when npm gives no version list', () => {
  // A registry that cannot be read must end the run red, never read as a missing version.
  // The runner's default bash -e is what stops the script, so no step may swap the shell.
  assert.doesNotMatch(code(workflow()), /^ *shell:/m, 'a shell override can drop the -e the check relies on');
  const version = '3.0.1';
  // For a package the registry does not have, npm 12.0.2 exits 1 and reports E404 and Not Found
  // on stderr and again as JSON on stdout, measured. This package is on npm already, so that
  // answer never means a first release to publish.
  const notFound = 'Not Found - GET https://registry.npmjs.org/@tibia.sh%2ftibiawiki-data - Not found';
  const replies: Array<[string, string, number, string?]> = [
    ['npm cannot read the registry', '', 1],
    ['npm answers E404', `${JSON.stringify({ error: { code: 'E404', summary: notFound } }, null, 2)}\n`, 1,
      `npm error code E404\nnpm error 404 ${notFound}\n`],
    ['npm prints nothing, as it does for a registry answering {}', '', 0],
    // Unlike nothing, {} parses, so the check itself has to reject it.
    ['npm prints {}', '{}\n', 0],
    ['npm prints an empty list', '[]\n', 0],
    ['npm prints something other than a list', '"3.0.0"\n', 0],
    // Unlike the string above, this one holds the version, so includes finds it there.
    ['npm prints the version itself, not a list holding it', `"${version}"\n`, 0],
    ['npm prints what is not JSON', 'npm error\n', 0],
  ];
  for (const [reply, npmStdout, npmExit, npmStderr] of replies) {
    const run = runCheck({ version, npmStdout, npmStderr, npmExit });
    assert.notEqual(run.status, 0, `the check passed when ${reply}\n${run.log}`);
    assert.equal(run.output, '', `the check asked to publish when ${reply}`);
  }
});

test('the release job checks out the commit that triggered the run', () => {
  // npm provenance names GITHUB_SHA, the commit that triggered the run. Without a ref,
  // checkout takes that same commit. Any ref could check out another commit, which would
  // then publish under an attestation naming the wrong one.
  const checkouts = releaseSteps().filter((step) => /^ *(?:- +)?uses: *actions\/checkout@/m.test(step));
  assert.ok(checkouts.length > 0, 'the release job never checks out the code it publishes');
  assert.equal(checkouts.length, releaseJob().split('actions/checkout@').length - 1,
    'a checkout step is written in a form this test cannot read, such as a flow mapping');
  for (const step of checkouts) {
    assert.doesNotMatch(step, /^ *ref:/m, 'the release job checks out a ref instead of the triggering commit');
  }
});

test('every step after the existence check is gated on it, and nothing before it installs, tests or publishes', () => {
  // A merge that leaves version alone must publish nothing and stay green, and every later
  // step is what would publish. Nothing that installs, tests or publishes may run first, and
  // pnpm/setup installs.
  const steps = releaseSteps();
  const check = stepIndex(steps, CHECK_ID);
  const after = steps.slice(check + 1);
  for (const step of after) {
    assert.equal(stepIf(step), PUBLISH_GATE, `${stepName(step)} is not gated on the existence check`);
  }
  for (const step of steps.slice(0, check)) {
    assert.doesNotMatch(step, /\bnpm publish\b|\bpnpm (?:install|i|test)\b|uses: *pnpm\/setup@/,
      `${stepName(step)} runs before the existence check`);
  }
  const publish = after.findIndex((step) => /\bnpm publish\b/.test(step));
  const suite = after.findIndex((step) => /\bpnpm test\b/.test(step));
  assert.notEqual(publish, -1, 'no gated step runs npm publish');
  assert.notEqual(suite, -1, 'no gated step runs pnpm test, the major-version guard');
  assert.ok(suite < publish, 'pnpm test runs after npm publish');
  assert.ok(after.some(installsFromLockfile), 'no gated step installs from the lockfile');
});

/**
 * Runs the publish step the way a runner does, in a checkout holding `files`, with an npm that
 * exits `npmExit`. The version it hands on is read with the real node.
 */
const runPublish = ({ version = '3.0.4', npmExit = 0, files = { 'package.json': JSON.stringify({ name: '@tibia.sh/tibiawiki-data', version }) } }: {
  version?: string;
  npmExit?: number;
  files?: Record<string, string>;
} = {}) => runStep(stepScript(workflow(), PUBLISH_ID), { files, commands: { npm: `process.exitCode = ${npmExit};\n` } });

test('the release job hands on released=true and the version only once npm accepted the publish', () => {
  // A job output is a string, so an expression that evaluates to false arrives as 'false', which
  // a bare if: treats as true. The publish step writes released=true after npm publish, and the
  // default bash -e stops the script at a failed publish, so the output is 'true' or empty. The
  // version is the one package.json names, read before the publish, so a version the step cannot
  // read publishes nothing. The script runs against a stand-in npm, because an edit such as
  // `|| true` would let the writes follow a failed publish.
  const outputs = under(releaseJob(), 'outputs');
  assert.deepEqual(keys(outputs), ['released', 'version'], 'the release job does not hand on exactly released and version');
  assert.equal(scalar(outputs, 'released'), `\${{ steps.${PUBLISH_ID}.outputs.released }}`, 'released does not read the publish step');
  assert.equal(scalar(outputs, 'version'), `\${{ steps.${PUBLISH_ID}.outputs.version }}`, 'version does not read the publish step');
  const steps = releaseSteps();
  const publishing = steps.filter((step) => /\bnpm publish\b/.test(step));
  assert.equal(publishing.length, 1, 'expected exactly one step that runs npm publish');
  assert.equal(stepIndex(steps, PUBLISH_ID), steps.indexOf(publishing[0]!), `the step that runs npm publish is not the one with id: ${PUBLISH_ID}`);
  assert.equal(stepIf(publishing[0]!), PUBLISH_GATE, 'the publish step is not gated on the existence check');

  for (const version of ['3.0.4', '10.20.300']) {
    const published = runPublish({ version });
    assert.equal(published.status, 0, `the step failed although npm publish succeeded\n${published.log}`);
    assert.deepEqual(published.calls, [{ command: 'npm', args: ['publish'] }], 'the step ran something besides npm publish');
    assert.equal(published.output, `released=true\nversion=${version}\n`, 'the step did not hand on released=true and the version package.json names');
  }

  const refused = runPublish({ npmExit: 1 });
  assert.notEqual(refused.status, 0, `the step passed although npm publish failed\n${refused.log}`);
  assert.equal(refused.output, '', 'the step handed something on although npm publish failed');

  const unreadable = runPublish({ files: {} });
  assert.notEqual(unreadable.status, 0, `the step passed without a package.json\n${unreadable.log}`);
  assert.deepEqual(unreadable.calls, [], 'the step published a version it could not read');
  assert.equal(unreadable.output, '', 'the step handed something on without a package.json');
});

test('setup-node restores no dependency cache into the job that publishes, or into its gate', () => {
  // A restored cache is input no one reviewed, in a job holding id-token: write, or in the gate
  // that decides whether that job publishes. The pinned setup-node restores one by itself whenever
  // package.json names a packageManager, so the input has to switch it off by name. The one cache
  // each job keeps is pnpm/setup's lockfile-verification record, which holds no package. The action
  // saves it right after its frozen install, and its post step tries again at the end of the job
  // only when that save does not go through.
  for (const [job, jobSteps] of [['release', releaseSteps()], ['oldest-consumer', steps(gateJob())]] as const) {
    const setups = jobSteps.filter((step) => /^ *(?:- +)?uses: *actions\/setup-node@/m.test(step));
    assert.ok(setups.length > 0, `the ${job} job never sets up node`);
    for (const step of setups) {
      const inputs = stepInputs(step);
      assert.equal(scalar(inputs, 'package-manager-cache'), 'false', `setup-node in the ${job} job caches the package manager store`);
      assert.equal(scalar(inputs, 'cache'), undefined, `setup-node in the ${job} job restores a dependency cache`);
    }
  }
});

test('release runs take turns, and none is cancelled or dropped', () => {
  // Two runs in parallel would both find a new version missing and race to publish it. The
  // default queue keeps one waiting run and cancels it when another arrives, which would
  // move the publish of a version off the merge that bumped it.
  const concurrency = under(code(workflow()), 'concurrency');
  assert.match(concurrency, /^ *group: *\S/m, 'the workflow has no concurrency group');
  assert.match(concurrency, /^ *cancel-in-progress: *false$/m, 'cancel-in-progress is not false');
  assert.match(concurrency, /^ *queue: *max$/m, 'queue is not max, so a waiting run can be replaced');
});

/** The condition the hosting job runs on. `released` is 'true' or empty. */
const HOSTING_GATE = "${{ needs.release.outputs.released == 'true' }}";

test('the hosting dispatch is a job of its own, run once npm accepted the publish', () => {
  // The token is a secret of the release-trigger environment. A job gets an environment's secrets
  // only by naming it, and naming one in the release job would put an environment claim in its
  // OIDC token, which npm's trusted publisher rejects. The job runs only once the release job
  // published, so a push that publishes nothing skips it. It runs no action and checks nothing
  // out beside the token. Its one step runs under the default bash -e, as the checks below run
  // its script: the existence check's test keeps every shell override out of the file, and the
  // script never turns -e off.
  const hosting = hostingJob();
  assert.notEqual(hosting, '', 'the workflow has no hosting job');
  assert.equal(scalar(hosting, 'needs'), 'release', 'the hosting job does not need the release job');
  assert.equal(scalar(hosting, 'if'), HOSTING_GATE, 'the hosting job does not run on released alone');
  assert.equal(scalar(hosting, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(hosting, 'timeout-minutes'), '8', 'the hosting job is not bounded at 8 minutes');
  assert.equal(scalar(hosting, 'environment'), 'release-trigger', 'the hosting job does not run in the release-trigger environment');
  const permissions = under(hosting, 'permissions');
  assert.deepEqual(keys(permissions), ['contents'], 'the hosting job does not hold exactly one permission, contents');
  assert.equal(scalar(permissions, 'contents'), 'read', 'the hosting job holds more than contents: read');
  assert.deepEqual(keys(under(hosting, 'env')), ['VERSION'], 'the hosting job sets something besides VERSION');
  assert.equal(scalar(under(hosting, 'env'), 'VERSION'), '${{ needs.release.outputs.version }}', 'VERSION is not the version the release job published');
  assert.doesNotMatch(hosting, /^ *(?:- +)?uses:/m, 'the hosting job runs an action');
  assert.equal(scalar(releaseJob(), 'environment'), undefined, 'the release job names an environment');
  assert.equal(steps(hosting).length, 1, 'expected exactly one hosting job step');
  const step = dispatchStep();
  assert.equal(scalar(stepBody(step), 'name'), 'Tell mcp.tibia.sh about the release', 'the dispatch step is not named as docs/RELEASING.md names it');
  assert.equal(stepIf(step), undefined, `${stepName(step)} sets if`);
  // The step's env holds the token alone, so nothing there can override the job's VERSION, which
  // the checks below stand in for. continue-on-error would turn a failed dispatch green, and a
  // step bound shorter than the job's would cut the attempts short.
  assert.deepEqual(keys(under(stepBody(step), 'env')), ['GH_TOKEN'], `${stepName(step)} sets something besides GH_TOKEN in its env`);
  assert.doesNotMatch(hosting, /^ *(?:- +)?continue-on-error:/m, 'the hosting job or its step has continue-on-error');
  assert.equal(scalar(stepBody(step), 'timeout-minutes'), undefined, `${stepName(step)} has a bound of its own`);
  assert.doesNotMatch(stepScript(workflow(), DISPATCH_ID), /\bset +\+[a-z]*e|\bset +\+o +errexit\b/, `${stepName(step)} turns off -e`);
});

test('the hosting token is the one secret any workflow references, and it reaches the dispatch step through its env', () => {
  // Written into a run script, a secret would be pasted into the shell as code. In a step's env
  // it is a variable only the processes of that step see, and gh reads GH_TOKEN by itself, so the
  // script never names the token. No other workflow reads a secret: the release job publishes
  // through OIDC, and the drift job writes with github.token.
  const references = workflowFiles().flatMap((file) =>
    code(read(file)).split('\n').filter((line) => /\bsecrets\b/.test(line)).map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(references, ['release.yml: GH_TOKEN: ${{ secrets.HOSTING_DISPATCH_TOKEN }}']);
  assert.equal(scalar(under(stepBody(dispatchStep()), 'env'), 'GH_TOKEN'), '${{ secrets.HOSTING_DISPATCH_TOKEN }}',
    'the token does not reach the dispatch step through its env as GH_TOKEN');
  assert.doesNotMatch(stepScript(workflow(), DISPATCH_ID), /GH_TOKEN|HOSTING_DISPATCH_TOKEN/, 'the dispatch script names its token');
});

/** The token the dispatch runs with in these checks. The stand-in gh reads no token. */
const HOSTING_TOKEN = 'stand-in-hosting-token';

/** What the stand-in gh answers a dispatch with: its exit code, and the error it prints when that is not 0. */
type GhReply = { code: number; text: string };

/** A dispatch GitHub accepted: gh exits 0 and prints nothing for the 204. */
const DISPATCHED: GhReply = { code: 0, text: '' };

/** gh's errors, as it prints them: a request that never connected, and HTTP errors with their status. */
const HOSTING_UNREACHABLE: GhReply = {
  code: 1,
  text: 'Post "https://api.github.com/repos/tibia-sh/mcp.tibia.sh/dispatches": dial tcp 140.82.121.6:443: i/o timeout',
};
const GITHUB_FAILED: GhReply = { code: 1, text: 'gh: Server Error (HTTP 502)' };
const TOKEN_REJECTED: GhReply = { code: 1, text: 'gh: Bad credentials (HTTP 401)' };

/** A request that hung: timeout stopped it and exits 124, and nothing was printed. */
const TIMED_OUT: GhReply = { code: 124, text: '' };

/**
 * A stand-in gh. It reads all of its stdin, the body gh would send, and keeps it in RUNNER_TEMP as
 * dispatch-N.json for call N. It answers call N with `replies[N - 1]`, printing the error on stderr
 * as gh does, and fails a call with no reply, so a fourth attempt cannot pass on a guess.
 */
const fakeGh = (replies: GhReply[]): string => String.raw`
const fs = require('node:fs');
const temp = process.env.RUNNER_TEMP;
const call = fs.readdirSync(temp).filter((name) => /^dispatch-\d+\.json$/.test(name)).length + 1;
fs.writeFileSync(temp + '/dispatch-' + call + '.json', fs.readFileSync(0, 'utf8'));
const reply = ${JSON.stringify(replies)}[call - 1];
if (reply === undefined) {
  process.stderr.write('fake gh: no reply for call ' + call + '\n');
  process.exitCode = 2;
  return;
}
if (reply.code !== 0) process.stderr.write(reply.text + '\n');
process.exitCode = reply.code;
`;

/**
 * A stand-in for GNU timeout. It takes only `--kill-after=10 120` and a command, which it runs on
 * its own stdin and whose status it exits with. Anything else exits 125, timeout's own failure, so
 * a changed bound cannot pass on a guess. It stops nothing, because no stand-in hangs.
 */
const FAKE_TIMEOUT = String.raw`
const args = process.argv.slice(2);
if (args.length < 3 || args[0] !== '--kill-after=10' || args[1] !== '120') {
  process.stderr.write('fake timeout: unsupported arguments: ' + args.join(' ') + '\n');
  process.exitCode = 125;
  return;
}
const run = require('node:child_process').spawnSync(args[2], args.slice(3), { stdio: 'inherit' });
if (run.error) {
  process.stderr.write('fake timeout: ' + run.error.message + '\n');
  process.exitCode = 127;
  return;
}
process.exitCode = run.status ?? 1;
`;

/** The body the dispatch sends for `version`, as bump.yml in the hosting repository reads it. */
const dispatchBody = (version: string): unknown => ({
  event_type: 'first-party-release',
  client_payload: { package: '@tibia.sh/tibiawiki-data', version },
});

/** `body` as GitHub would read it: one JSON document, or the test fails. */
const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return assert.fail(`a body is not one JSON document: ${body}`);
  }
};

/**
 * Runs the dispatch step for `version` with stand-ins for gh, sleep and timeout, and jq for real.
 * gh answers its calls with `replies` in order, sleep returns at once. The step holds the token in
 * its env, so any command that prints it, such as an environment dump or a trace, fails every run.
 */
function runDispatch(version: string, replies: GhReply[]) {
  const run = runStep(stepScript(workflow(), DISPATCH_ID), {
    commands: { gh: fakeGh(replies), sleep: '', timeout: FAKE_TIMEOUT },
    env: { VERSION: version, GH_TOKEN: HOSTING_TOKEN },
  });
  assert.ok(!run.log.includes(HOSTING_TOKEN), 'the dispatch step printed the token');
  for (const call of run.calls) {
    assert.ok(!call.args.join(' ').includes(HOSTING_TOKEN), `the token appears on the command line of ${call.command}`);
  }
  return {
    ...run,
    errors: run.log.split('\n').filter((line) => line.startsWith('::error::')),
    /** What each gh call read on stdin, in the order of the calls. */
    bodies: Object.entries(run.runnerTemp)
      .filter(([name]) => /^dispatch-\d+\.json$/.test(name))
      .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
      .map(([, body]) => json(body)),
  };
}

const DISPATCH_ARGS = ['api', 'repos/tibia-sh/mcp.tibia.sh/dispatches', '--input', '-'];

/** The calls one attempt records: gh under timeout's bound, then gh itself. */
const ATTEMPT: Call[] = [
  { command: 'timeout', args: ['--kill-after=10', '120', 'gh', ...DISPATCH_ARGS] },
  { command: 'gh', args: DISPATCH_ARGS },
];

/** The pause between two attempts. */
const PAUSE: Call = { command: 'sleep', args: ['30'] };

/** The line the step prints once a dispatch of `version` got through, in attempt `attempt`. */
const told = (version: string, attempt: number): string =>
  `Told tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-data ${version} in attempt ${attempt}.`;

test('the hosting dispatch rejects a version that is not a release version, before it calls gh', () => {
  // The version decides what bump.yml pins, and the error line names what this run had instead.
  // 3-0-4 passes a regex whose dots lost their backslashes, so it stays in the list.
  for (const version of ['', 'v3.0.4', '3.0', '3.0.4-rc.1', '3.0.4; true', '3-0-4']) {
    const run = runDispatch(version, [DISPATCHED]);
    assert.equal(run.status, 1, `${JSON.stringify(version)} is accepted\n${run.log}`);
    assert.deepEqual(run.errors, [`::error::The published version must look like 1.2.3, and this run has "${version}".`]);
    assert.deepEqual(run.calls, [], `${JSON.stringify(version)} reaches gh or sleep`);
  }
});

test('the hosting dispatch tells the hosting repository about the version once when its first attempt succeeds', () => {
  // The body is the event bump.yml is triggered by, with the version npm accepted.
  for (const version of ['3.0.4', '10.20.300']) {
    const run = runDispatch(version, [DISPATCHED]);
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(run.calls, ATTEMPT, 'the dispatch is not one gh call under timeout');
    assert.deepEqual(run.bodies, [dispatchBody(version)]);
    assert.ok(run.log.split('\n').includes(told(version, 1)), `the log does not say the dispatch got through\n${run.log}`);
    assert.deepEqual(run.errors, [], `a dispatch that got through ends with an error\n${run.log}`);
  }
});

test('the hosting dispatch tries again 30 seconds after a failure, and stops at the attempt that got through', () => {
  // A dispatch that got through twice is harmless, because bump.yml finds the version pinned or
  // its pull request open, so a failed attempt is only tried again, with the same body. A hung
  // attempt, which timeout stopped, is a failed attempt like any other.
  const second = runDispatch('3.0.4', [GITHUB_FAILED, DISPATCHED]);
  assert.equal(second.status, 0, second.log);
  assert.deepEqual(second.calls, [...ATTEMPT, PAUSE, ...ATTEMPT]);
  assert.deepEqual(second.bodies, [dispatchBody('3.0.4'), dispatchBody('3.0.4')]);
  assert.ok(second.log.split('\n').includes(told('3.0.4', 2)), `the log does not say which attempt got through\n${second.log}`);
  assert.deepEqual(second.errors, [], `a dispatch that got through ends with an error\n${second.log}`);
  const third = runDispatch('3.0.4', [TIMED_OUT, HOSTING_UNREACHABLE, DISPATCHED]);
  assert.equal(third.status, 0, third.log);
  assert.deepEqual(third.calls, [...ATTEMPT, PAUSE, ...ATTEMPT, PAUSE, ...ATTEMPT]);
  assert.deepEqual(third.bodies, [dispatchBody('3.0.4'), dispatchBody('3.0.4'), dispatchBody('3.0.4')]);
  assert.ok(third.log.split('\n').includes(told('3.0.4', 3)), `the log does not say which attempt got through\n${third.log}`);
  assert.deepEqual(third.errors, [], `a dispatch that got through ends with an error\n${third.log}`);
});

test('the hosting dispatch fails after 3 attempts, 30 seconds apart, and names the runbook section with the manual command', () => {
  // The publish already happened, so the job ends red with the version and the recovery, and gh's
  // own errors say why each attempt failed.
  const failures = [HOSTING_UNREACHABLE, TOKEN_REJECTED, GITHUB_FAILED];
  const run = runDispatch('3.0.4', failures);
  assert.equal(run.status, 1, run.log);
  assert.deepEqual(run.calls, [...ATTEMPT, PAUSE, ...ATTEMPT, PAUSE, ...ATTEMPT]);
  assert.deepEqual(run.errors, [
    '::error::Could not tell tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-data 3.0.4 in 3 attempts, 30 seconds apart. Run bump.yml there by hand, as "The hosting dispatch" in docs/RELEASING.md describes.',
  ]);
  assert.doesNotMatch(run.log, /^Told /m, `the log says the dispatch got through\n${run.log}`);
  for (const { text } of failures) {
    assert.ok(run.log.includes(text), `the log does not carry gh's error: ${text}`);
  }
  const section = /"([^"]+)" in docs\/RELEASING\.md/.exec(run.errors[0]!)![1]!;
  const lines = readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8').split('\n');
  const start = lines.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `docs/RELEASING.md has no section "${section}"`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  assert.ok(
    lines.slice(start, end === -1 ? undefined : end).includes('gh workflow run bump.yml -R tibia-sh/mcp.tibia.sh --ref main -f package=@tibia.sh/tibiawiki-data -f version=X.Y.Z'),
    `"${section}" in docs/RELEASING.md does not give the manual command`,
  );
});
