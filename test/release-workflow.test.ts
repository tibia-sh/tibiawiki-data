import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The release workflow cannot run inside the suite, and a mistake in it surfaces only when
 * a merge publishes, or fails to: a version npm never lets be reused, or a release that
 * quietly never happens. Most properties pinned here are checkable from the files alone.
 * The existence check's decision is not, so its script runs here against a fake npm.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = `${root}.github/workflows`;

/** Every workflow in the repository, by file name. */
const workflowFiles = (): string[] => readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string): string => readFileSync(`${WORKFLOWS}/${name}`, 'utf8');
const workflow = (): string => read('release.yml');

/**
 * A workflow without comments or blank lines. The prose in a comment names the very
 * things these tests look for, such as id-token: write, so a presence check against the
 * raw text would pass with the setting itself deleted. A YAML comment starts at a `#`
 * preceded by whitespace, and none of these workflows' values contain one.
 */
const code = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '')
    .join('\n');

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, a key at the block's
 * shallowest indentation, or '' when there is none. A deeper key of the same name, such as
 * a job's own `permissions:`, does not count.
 */
const under = (yaml: string, key: string): string => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  if (indents.length === 0) return '';
  const depth = Math.min(...indents);
  return new RegExp(`^ {${depth}}${key}:\\n((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml)?.[1] ?? '';
};

/** The keys at a block's shallowest indentation, in order. */
const keys = (yaml: string): string[] => {
  const lines = yaml.split('\n').filter((line) => line.trim() !== '');
  const depth = Math.min(...lines.map((line) => line.search(/\S/)));
  return lines.filter((line) => line.search(/\S/) === depth).map((line) => line.trim().replace(/:.*$/, ''));
};

const releaseJob = (): string => under(under(code(workflow()), 'jobs'), 'release');

/** The release job's steps, one string per list item. */
const releaseSteps = (): string[] => {
  const steps = under(releaseJob(), 'steps');
  const marker = /^ *- /.exec(steps)?.[0];
  return marker ? steps.split(new RegExp(`^(?=${marker})`, 'm')) : [];
};

/** A step's `if:`, whether it is the first key on the `- ` line or a later one. */
const stepIf = (step: string): string | undefined => /^ *(?:- +)?if: *(.*)$/m.exec(step)?.[1];

const stepName = (step: string): string =>
  /^ *(?:- +)?(?:name|id|uses|run): *(.*)$/m.exec(step)?.[1] ?? step.trim();

/** The step that asks the registry whether this version exists. Every publishing step waits on it. */
const CHECK_ID = 'registry';

/** The condition every step after that check carries. */
const PUBLISH_GATE = `\${{ steps.${CHECK_ID}.outputs.publish == 'true' }}`;

/** The index of the existence check among the release job's steps. */
const checkIndex = (steps: string[]): number => {
  const matches = steps.flatMap((step, index) => (new RegExp(`^ *(?:- +)?id: *${CHECK_ID}$`, 'm').test(step) ? [index] : []));
  assert.equal(matches.length, 1, `expected exactly one step with id: ${CHECK_ID}`);
  return matches[0]!;
};

/**
 * The existence check's `run: |` script as the runner receives it: its lines from the raw
 * workflow, comments included, with the block's indentation removed.
 */
const checkScript = (): string => {
  const lines = workflow().split('\n');
  const idLine = lines.findIndex((line) => new RegExp(`^ *(?:- +)?id: *${CHECK_ID}(?: +#.*)?$`).test(line));
  assert.notEqual(idLine, -1, `no step has id: ${CHECK_ID}`);
  let start = idLine;
  while (start > 0 && !/^ *- /.test(lines[start]!)) start--;
  const item = lines[start]!.indexOf('-');
  const step = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= item) break;
    step.push(line);
  }
  const run = step.findIndex((line) => /^ *(?:- +)?run: *\|$/.test(line));
  assert.notEqual(run, -1, 'the existence check is not a run: | block');
  const key = step[run]!.indexOf('run:');
  const body: string[] = [];
  for (const line of step.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= key) break;
    body.push(line);
  }
  const depth = Math.min(...body.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return `${body.map((line) => line.slice(depth)).join('\n')}\n`;
};

/**
 * Runs the existence check the way a runner does, `bash -e` with GITHUB_OUTPUT set, in a
 * checkout whose package.json has `version`. The npm it finds first on PATH prints
 * `npmStdout` and exits `npmExit`, and records how it was called.
 */
function runCheck({ version, npmStdout, npmExit }: { version: string; npmStdout: string; npmExit: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-check-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'npm'),
      `#!${process.execPath}\n` +
        "require('node:fs').appendFileSync(process.env.CHECK_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
        'process.stdout.write(process.env.CHECK_NPM_STDOUT);\n' +
        'process.exitCode = Number(process.env.CHECK_NPM_EXIT);\n',
    );
    chmodSync(join(dir, 'bin', 'npm'), 0o755);
    mkdirSync(join(dir, 'checkout'));
    writeFileSync(join(dir, 'checkout', 'package.json'), JSON.stringify({ name: '@tibia.sh/tibiawiki-data', version }));
    writeFileSync(join(dir, 'check.sh'), checkScript());
    const output = join(dir, 'github-output');
    const log = join(dir, 'npm-calls.jsonl');
    writeFileSync(output, '');
    writeFileSync(log, '');
    const run = spawnSync('bash', ['-e', join(dir, 'check.sh')], {
      cwd: join(dir, 'checkout'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
        GITHUB_OUTPUT: output,
        CHECK_NPM_STDOUT: npmStdout,
        CHECK_NPM_EXIT: String(npmExit),
        CHECK_NPM_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[]);
    return { status: run.status, output: readFileSync(output, 'utf8'), calls, log: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every `run:` script in the raw workflow text, block scalars included. Comments stay in,
 * because GitHub substitutes `${{ }}` inside a block scalar's comment lines too.
 */
const runScripts = (yaml: string): string[] => {
  const lines = yaml.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^( *(?:- +)?)run:(.*)$/.exec(line);
    if (!match) return [];
    const script = [match[2]!];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= match[1]!.length) break;
      script.push(next);
    }
    return [script.join('\n')];
  });
};

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
  assert.match(steps[checkIndex(steps)]!, /\bnpm view "\$name" versions --json\b/,
    'the existence check does not read the version list from the registry');
  assert.doesNotMatch(steps.join('\n'), /\blatest\b|dist-tags/, 'a release step compares against latest');
});

test('the existence check asks to publish a version only when npm does not list it', () => {
  const list = '[\n  "3.0.0"\n]\n';
  const present = runCheck({ version: '3.0.0', npmStdout: list, npmExit: 0 });
  assert.equal(present.status, 0, `the check failed for a version npm has\n${present.log}`);
  assert.equal(present.output, '', 'the check asked to publish a version npm already has');
  assert.deepEqual(present.calls, [['view', '@tibia.sh/tibiawiki-data', 'versions', '--json']],
    'the check did not read the version list of the package named in package.json');

  const absent = runCheck({ version: '3.0.1', npmStdout: list, npmExit: 0 });
  assert.equal(absent.status, 0, `the check failed for a version npm lacks\n${absent.log}`);
  assert.equal(absent.output, 'publish=true\n', 'the check did not ask to publish a version npm lacks');
});

test('the existence check fails, and asks for nothing, when npm gives no version list', () => {
  // A registry that cannot be read must end the run red, never read as a missing version.
  // The runner's default bash -e is what stops the script, so no step may swap the shell.
  assert.doesNotMatch(code(workflow()), /^ *shell:/m, 'a shell override can drop the -e the check relies on');
  const replies: Array<[string, string, number]> = [
    ['npm cannot read the registry', '', 1],
    ['npm prints nothing, as it does for a registry answering {}', '', 0],
    ['npm prints an empty list', '[]\n', 0],
    ['npm prints something other than a list', '"3.0.0"\n', 0],
    ['npm prints what is not JSON', 'npm error\n', 0],
  ];
  for (const [reply, npmStdout, npmExit] of replies) {
    const run = runCheck({ version: '3.0.1', npmStdout, npmExit });
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
  // step is what would publish. Nothing that installs, tests or publishes may run first.
  const steps = releaseSteps();
  const check = checkIndex(steps);
  const after = steps.slice(check + 1);
  for (const step of after) {
    assert.equal(stepIf(step), PUBLISH_GATE, `${stepName(step)} is not gated on the existence check`);
  }
  for (const step of steps.slice(0, check)) {
    assert.doesNotMatch(step, /\bnpm publish\b|\bpnpm (?:install|i|test)\b/, `${stepName(step)} runs before the existence check`);
  }
  const publish = after.findIndex((step) => /\bnpm publish\b/.test(step));
  const suite = after.findIndex((step) => /\bpnpm test\b/.test(step));
  assert.notEqual(publish, -1, 'no gated step runs npm publish');
  assert.notEqual(suite, -1, 'no gated step runs pnpm test, the major-version guard');
  assert.ok(suite < publish, 'pnpm test runs after npm publish');
  assert.ok(after.some((step) => /\bpnpm install --frozen-lockfile\b/.test(step)), 'no gated step installs from the lockfile');
});

test('setup-node restores no dependency cache into the job that publishes', () => {
  // A restored cache is input no one reviewed, in a job holding id-token: write. The pinned
  // setup-node restores one by itself whenever package.json names a packageManager, so the
  // input has to switch it off by name.
  const setups = releaseSteps().filter((step) => /^ *(?:- +)?uses: *actions\/setup-node@/m.test(step));
  assert.ok(setups.length > 0, 'the release job never sets up node');
  for (const step of setups) {
    assert.match(step, /^ *package-manager-cache: *false$/m, 'setup-node caches the package manager store');
    assert.doesNotMatch(step, /^ *cache:/m, 'setup-node restores a dependency cache');
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
