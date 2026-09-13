import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_TESTS } from './min-tests.ts';

/**
 * test/min-tests.ts decides how a whole run ends, so it is checked the only way that
 * shows: a child `node --test` with the reporter, over fixture files written for it.
 */

const REPORTER = fileURLToPath(new URL('./min-tests.ts', import.meta.url));

/**
 * Runs the reporter over two fixtures: one file with `count` passing tests, and one
 * emptied file that keeps its import and declares no tests. `nodeOptions` replaces
 * NODE_OPTIONS in the child, and no value removes it.
 */
function runWithFloor(count: number, nodeOptions?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-min-tests-'));
  try {
    writeFileSync(
      join(dir, 'tests.test.ts'),
      `import { test } from 'node:test';\nfor (let i = 0; i < ${count}; i++) test('test ' + i, () => {});\n`,
    );
    writeFileSync(join(dir, 'emptied.test.ts'), `import { test } from 'node:test';\nvoid test;\n`);
    // Node marks every test-file process with NODE_TEST_CONTEXT. Inherited, it makes the
    // child report up to this runner instead of ending with its own exit code.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['NODE_TEST_CONTEXT'];
    delete env['NODE_OPTIONS'];
    if (nodeOptions !== undefined) env['NODE_OPTIONS'] = nodeOptions;
    return spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${REPORTER}`, 'tests.test.ts', 'emptied.test.ts'],
      { cwd: dir, env, encoding: 'utf8' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a run in which MIN_TESTS tests pass ends green, even beside an emptied file', () => {
  const run = runWithFloor(MIN_TESTS);
  assert.equal(run.status, 0, `the floor failed a run that met it\n${run.stdout}${run.stderr}`);
});

test('an emptied test file fails the run, although node --test counts it as a pass', () => {
  // node --test reports the emptied file as one passing test named after it, so without
  // the floor this run would exit 0 and still claim MIN_TESTS passes.
  const run = runWithFloor(MIN_TESTS - 1);
  assert.equal(run.status, 1, `a run one test short of the floor did not fail\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /MIN_TESTS/, 'the failure does not say which floor it tripped');
});

test('a --test-name-pattern in NODE_OPTIONS that filters every test away fails the run', () => {
  const run = runWithFloor(MIN_TESTS, '--test-name-pattern=nomatch');
  assert.equal(run.status, 1, `a run that filtered every test away did not fail\n${run.stdout}${run.stderr}`);
});

test('pnpm test runs the suite through the floor', () => {
  // The reporter proves nothing unless the test script passes it to node --test.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = manifest.scripts['test'] ?? '';
  assert.match(script, /\bnode --test\b[^&|;]* --test-reporter=\.\/test\/min-tests\.ts\b[^&|;]* test\/\*\.test\.ts\b/);
});
