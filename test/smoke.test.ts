import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/smoke.mjs installs from the registry, so the suite cannot run it as it stands.
 * These run a copy of it offline: beside this repository's package.json, with a
 * stand-in check where test/data.test.ts would be, and a fake npm first on PATH. Each
 * test pins one thing the smoke's header promises. The first of them broke silently
 * once already, when an inherited NODE_OPTIONS ran no tests and the smoke printed PASS.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** What the smoke is asked to install. The fake npm never fetches it. */
const TARGET = '@tibia.sh/tibiawiki-data@3.0.0';

/** How long a stubborn fake child hangs. A run that takes this long was never bounded. */
const HANG_MS = 10_000;

/** Ample for every healthy run here. It only ends a smoke that has hung. */
const HARNESS_TIMEOUT_MS = 20_000;

/**
 * Stands in for npm. It records its pid and its environment's keys, never their values,
 * then acts out FAKE_NPM: `ok` succeeds, `fail` refuses the install, `sleep` hangs, and
 * `stubborn` hangs and ignores SIGTERM.
 */
const FAKE_NPM = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
if (process.env.FAKE_NPM === 'stubborn') process.on('SIGTERM', () => {});
appendFileSync(process.env.SMOKE_TEST_LOG,
  JSON.stringify({ role: 'npm', pid: process.pid, env: Object.keys(process.env) }) + '\\n');
if (process.env.FAKE_NPM === 'fail') {
  process.stderr.write('fake npm refused the install\\n');
  process.exitCode = 1;
} else if (process.env.FAKE_NPM !== 'ok') {
  setTimeout(() => {}, ${HANG_MS});
}
`;

/** Stands in for test/data.test.ts. It records the same way, and FAKE_CHECK=stubborn hangs it. */
const STAND_IN_CHECK = `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';

test('the stand-in check', async () => {
  if (process.env.FAKE_CHECK === 'stubborn') process.on('SIGTERM', () => {});
  appendFileSync(process.env.SMOKE_TEST_LOG,
    JSON.stringify({ role: 'check', pid: process.pid, env: Object.keys(process.env) }) + '\\n');
  if (process.env.FAKE_CHECK === 'stubborn') await new Promise((resolve) => setTimeout(resolve, ${HANG_MS}));
});
`;

type Box = { root: string; smoke: string; tmp: string; log: string; output: string; env: NodeJS.ProcessEnv };
type Entry = { role: 'npm' | 'check'; pid: number; env: string[] };

/**
 * A throwaway tree holding the smoke copy, its fakes and its TMPDIR. `timeoutMs` rewrites
 * the copy's per-step bound, and nothing else in the copy changes.
 */
function makeBox(timeoutMs?: number): Box {
  const root = mkdtempSync(join(tmpdir(), 'tibiawiki-data-smoke-test-'));
  const smoke = join(root, 'repo', 'scripts', 'smoke.mjs');
  mkdirSync(join(root, 'repo', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'repo', 'test'));
  copyFileSync(join(ROOT, 'package.json'), join(root, 'repo', 'package.json'));
  writeFileSync(join(root, 'repo', 'test', 'data.test.ts'), STAND_IN_CHECK);

  const source = readFileSync(join(ROOT, 'scripts', 'smoke.mjs'), 'utf8');
  const bound = /^const TIMEOUT_MS = [\d_]+;$/m;
  assert.match(source, bound, 'scripts/smoke.mjs no longer declares TIMEOUT_MS the way this harness rewrites it');
  writeFileSync(smoke, timeoutMs === undefined ? source : source.replace(bound, `const TIMEOUT_MS = ${timeoutMs};`));

  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'npm'), FAKE_NPM);
  chmodSync(join(root, 'bin', 'npm'), 0o755);

  // The smoke's scratch directory lands here, so an empty directory afterwards proves
  // it was removed.
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const log = join(root, 'log.jsonl');
  writeFileSync(log, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
    TMPDIR: tmp,
    SMOKE_TEST_LOG: log,
    // What a package manager running a script exports, which the smoke must strip...
    npm_config_smoke_probe: 'strip me',
    // ...the operator's own npm settings, which a stranger's install has too...
    NPM_CONFIG_SMOKE_PROBE: 'keep me',
    // ...and the flag that once filtered every test away while the smoke printed PASS.
    NODE_OPTIONS: '--test-name-pattern=nomatch',
  };
  // Node marks every test-file process with NODE_TEST_CONTEXT. Inherited, it makes the
  // smoke's own node --test report up to this runner instead of ending with its own code.
  delete env['NODE_TEST_CONTEXT'];
  return { root, smoke, tmp, log, output: join(root, 'output.txt'), env };
}

const entries = (box: Box): Entry[] =>
  readFileSync(box.log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Entry);

/**
 * Runs the smoke copy to its end. Its output goes to a file rather than a pipe, because a
 * process the smoke leaves behind would hold a pipe open and this call with it.
 */
function runSmoke(box: Box, env: NodeJS.ProcessEnv) {
  const fd = openSync(box.output, 'w');
  const started = Date.now();
  try {
    const run = spawnSync(process.execPath, [box.smoke, TARGET], {
      env: { ...box.env, ...env }, stdio: ['ignore', fd, fd], timeout: HARNESS_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    return { status: run.status, ms: Date.now() - started, output: readFileSync(box.output, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** The smoke names its scratch directory. It must have been inside TMPDIR, and be gone. */
function assertScratchRemoved(box: Box, output: string): void {
  const scratch = /^scratch: (.+)$/m.exec(output)?.[1];
  assert.ok(scratch, `the smoke never named a scratch directory\n${output}`);
  assert.ok(scratch.startsWith(join(box.tmp, 'tibiawiki-data-smoke-')), `the scratch directory was not in TMPDIR: ${scratch}`);
  assert.equal(existsSync(scratch), false, `the smoke left its scratch directory behind: ${scratch}`);
  assert.deepEqual(readdirSync(box.tmp), [], 'the smoke left files in TMPDIR');
}

test('the install and the check run without npm_* or NODE_OPTIONS, and keep NPM_CONFIG_*', () => {
  const box = makeBox();
  try {
    const run = runSmoke(box, { FAKE_NPM: 'ok' });
    assert.equal(run.status, 0, `the smoke failed\n${run.output}`);
    assert.match(run.output, /^PASS {2}/m);

    const npm = entries(box).filter((entry) => entry.role === 'npm');
    const check = entries(box).filter((entry) => entry.role === 'check');
    assert.equal(npm.length, 1, 'the fake npm did not run exactly once');
    // A NODE_OPTIONS that reached the check would have filtered the stand-in test away
    // and still exited 0, so the check's own record is what proves it ran.
    assert.equal(check.length, 1, 'the stand-in check never ran, so the smoke printed PASS for nothing');
    for (const { role, env } of [...npm, ...check]) {
      assert.deepEqual(env.filter((key) => key.startsWith('npm_')), [], `the ${role} step inherited npm_* keys`);
      assert.equal(env.includes('NODE_OPTIONS'), false, `the ${role} step inherited NODE_OPTIONS`);
      assert.equal(env.includes('NPM_CONFIG_SMOKE_PROBE'), true, `the ${role} step lost the operator's NPM_CONFIG_* keys`);
    }
    assertScratchRemoved(box, run.output);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('a failed install fails the smoke, shows npm\'s reason, and removes the scratch directory', () => {
  const box = makeBox();
  try {
    const run = runSmoke(box, { FAKE_NPM: 'fail' });
    assert.equal(run.status, 1, `a failed install did not fail the smoke\n${run.output}`);
    assert.match(run.output, /^FAIL {2}/m);
    assert.match(run.output, /fake npm refused the install/, 'the smoke did not show why npm failed');
    assertScratchRemoved(box, run.output);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('an install that ignores SIGTERM is killed at the time bound', () => {
  const box = makeBox(1_000);
  try {
    const run = runSmoke(box, { FAKE_NPM: 'stubborn' });
    assert.equal(run.status, 1, `a hung install did not fail the smoke\n${run.output}`);
    // SIGTERM alone would leave the smoke waiting until the fake npm gave up by itself.
    assert.ok(run.ms < HANG_MS / 2, `the smoke took ${run.ms} ms against a 1000 ms bound, so the install was not killed`);
    assertScratchRemoved(box, run.output);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('a check that hangs is stopped at the time bound', () => {
  // The bound is wider than the install's because the check's node --test has to start
  // first. The runner exits on SIGTERM by itself, measured on node 24.19.0, so this pins
  // the bound on this step, not the SIGKILL.
  const box = makeBox(2_000);
  try {
    const run = runSmoke(box, { FAKE_NPM: 'ok', FAKE_CHECK: 'stubborn' });
    assert.equal(run.status, 1, `a hung check did not fail the smoke\n${run.output}`);
    assert.ok(run.ms < HANG_MS / 2, `the smoke took ${run.ms} ms against a 2000 ms bound, so the check was not stopped`);
    assertScratchRemoved(box, run.output);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('every step the smoke starts is bounded and killed with SIGKILL', () => {
  // Read from the source, because running it cannot show this for the check step: its
  // node --test exits on SIGTERM by itself, so no stand-in tells SIGKILL apart there.
  // A runner that ever stops doing that would hold the check open without it.
  const source = readFileSync(join(ROOT, 'scripts', 'smoke.mjs'), 'utf8');
  const steps = source.split('execFileSync(').slice(1).map((call) => call.slice(0, call.indexOf(');')));
  assert.equal(steps.length, 2, 'the smoke no longer starts exactly its two steps, so check each new one here');
  for (const step of steps) {
    const name = step.slice(0, step.indexOf(','));
    assert.match(step, /\btimeout: TIMEOUT_MS\b/, `the ${name} step has no time bound`);
    assert.match(step, /\bkillSignal: 'SIGKILL'/, `the ${name} step is not killed with SIGKILL`);
  }
});

test('a Ctrl-C stops the smoke and still removes the scratch directory', async () => {
  const box = makeBox();
  const fd = openSync(box.output, 'w');
  // Detached, so the smoke leads its own process group, which is what a terminal's Ctrl-C
  // signals: the smoke and the step it is running, together.
  const smoke = spawn(process.execPath, [box.smoke, TARGET], {
    env: { ...box.env, FAKE_NPM: 'sleep' }, detached: true, stdio: ['ignore', fd, fd],
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    smoke.once('exit', (code, signal) => resolve([code, signal]));
  });
  try {
    const deadline = Date.now() + HARNESS_TIMEOUT_MS;
    while (!entries(box).some((entry) => entry.role === 'npm')) {
      assert.ok(Date.now() < deadline, 'the install step never started');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.kill(-smoke.pid!, 'SIGINT');
    const [code, signal] = await exited;
    const output = readFileSync(box.output, 'utf8');
    assert.equal(signal, null, `the smoke was killed by ${signal} before it could remove its scratch directory`);
    assert.equal(code, 1, `an interrupted smoke did not fail\n${output}`);
    assertScratchRemoved(box, output);
  } finally {
    if (smoke.exitCode === null && smoke.signalCode === null) process.kill(-smoke.pid!, 'SIGKILL');
    closeSync(fd);
    rmSync(box.root, { recursive: true, force: true });
  }
});
