/**
 * The suite's minimum test count, applied as a node:test reporter.
 *
 * `node --test` exits 0 when a test file declares no tests, and when a
 * --test-name-pattern filters every test away, including one inherited through
 * NODE_OPTIONS. Either way the index is never queried and the run still reads as a pass,
 * on the gate that runs before an irreversible publish. `pnpm test` runs this reporter
 * beside spec, and it fails any run in which fewer than MIN_TESTS tests passed.
 *
 * The count comes from each file's own summary. The run's closing summary would miss
 * exactly the case this exists for: it counts a file that ran no tests as one passing
 * test named after the file, so emptying a file that held one test would leave the
 * total unchanged. A file that declares no tests sends no summary of its own. Skipped
 * and todo tests are not passes, so they do not count either.
 */
import type { TestEvent } from 'node:test/reporters';

/**
 * How many tests `pnpm test` runs. Adding a test needs no change here. Removing or
 * skipping one does: lower this in the same commit, so the removal is a decision a
 * reviewer sees rather than something that happened quietly.
 */
export const MIN_TESTS = 103;

export default async function* minTests(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let passed = 0;
  for await (const event of source) {
    if (event.type === 'test:summary' && event.data.file !== undefined) {
      passed += event.data.counts.passed;
    }
  }
  if (passed < MIN_TESTS) {
    process.exitCode = 1;
    yield `\n${passed} tests passed, but this suite has at least ${MIN_TESTS}. node --test still ` +
      'exits 0 when a file declares no tests, when a test is skipped, and when a ' +
      '--test-name-pattern filters tests away, one inherited through NODE_OPTIONS included. ' +
      'If tests were removed on purpose, lower MIN_TESTS in test/min-tests.ts.\n';
  }
}
