import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConsumers, evaluateSweep, readRegistry, satisfiesCaret, selectConsumers, selectNewestConsumer, selectOldestConsumer,
  sweep,
} from '../scripts/oldest-consumer.ts';

/**
 * scripts/oldest-consumer.ts installs from the registry and serves every item through
 * published servers, so the suite cannot run it. These pin its decisions instead: which
 * published servers are the oldest and the newest consumer of a candidate, which of them the
 * gate lists to sweep, that it checks each listed server in turn and reports only the ones it
 * checked, and whether a sweep through a server was complete and clean. They also pin what the
 * gate says about a registry answer other than 200, and that a sweep ends only once its server
 * has exited, or at once when no server started, through a stand-in server.
 * `pnpm oldest-consumer` runs the whole gate.
 */

const DATA = '@tibia.sh/tibiawiki-data';

/** The server versions on npm as of 2026-09-14, with the dependencies the abbreviated document lists. */
const PUBLISHED = {
  versions: {
    '0.1.0': { dependencies: { zod: '4.5.4', '@modelcontextprotocol/server': '2.0.0' } },
    '0.2.0': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
    '0.3.0': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
    '0.3.1': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
    '0.4.0': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
  },
};

/** A registry document whose versions each depend on this package at the given range. */
const dependingOn = (ranges: Record<string, string>) => ({
  versions: Object.fromEntries(Object.entries(ranges).map(([version, range]) => [version, { dependencies: { [DATA]: range } }])),
});

test('the oldest consumer is 0.2.0, not a 0.3.x that depends on the same range', () => {
  assert.equal(selectOldestConsumer(PUBLISHED, '3.0.2'), '0.2.0');
});

test('a server version without the dependency is skipped', () => {
  // 0.0.9 has no dependencies at all, and 0.1.0 has some, but not this package.
  const document = { versions: { '0.0.9': {}, ...PUBLISHED.versions } };
  assert.equal(selectOldestConsumer(document, '3.0.2'), '0.2.0');
});

test('a range the candidate does not satisfy is skipped, such as ^3.1.0 for 3.0.2', () => {
  assert.equal(satisfiesCaret('^3.1.0', '3.0.2'), false);
  assert.equal(selectOldestConsumer(dependingOn({ '0.2.0': '^3.1.0', '0.3.0': '^3' }), '3.0.2'), '0.3.0');
  // ^M.m.p means >=M.m.p <(M+1).0.0, and ^M means >=M.0.0 <(M+1).0.0.
  const cases: Array<[string, string, boolean]> = [
    ['^3.1.0', '3.1.0', true],
    ['^3.1.0', '3.10.0', true],
    ['^3.1.0', '4.0.0', false],
    ['^3', '3.0.0', true],
    ['^3', '2.9.9', false],
    ['^3', '4.0.0', false],
  ];
  for (const [range, version, satisfied] of cases) {
    assert.equal(satisfiesCaret(range, version), satisfied, `${version} against ${range}`);
  }
});

test('a range other than ^M or ^M.m.p with M at least 1 throws, naming the range', () => {
  for (const range of ['>=3', '3.x', '~3.0.0', '^0']) {
    const names = (error: unknown) => error instanceof Error && error.message.includes(range);
    assert.throws(() => satisfiesCaret(range, '3.0.2'), names, `satisfiesCaret read ${range}`);
    assert.throws(() => selectOldestConsumer(dependingOn({ '0.2.0': range }), '3.0.2'), names, `selectOldestConsumer read ${range}`);
  }
  // Nor is a candidate that is not x.y.z compared, even against a document that never asks.
  assert.throws(() => satisfiesCaret('^3', '3.0.2-rc.1'), /^Error: 3\.0\.2-rc\.1 is not an x\.y\.z version\.$/);
  assert.throws(() => selectOldestConsumer({ versions: { '0.1.0': {} } }, '3.0'), /^Error: The candidate version 3\.0 is not x\.y\.z\.$/);
});

test('a candidate no published server accepts throws, sending a new data major to the schema-bump procedure', () => {
  assert.throws(() => selectOldestConsumer(PUBLISHED, '4.0.0'), (error: unknown) =>
    error instanceof Error &&
    /a new data major has no consumer yet/i.test(error.message) &&
    /published by hand under the schema-bump procedure/.test(error.message));
});

test('the no-consumer error names a section that docs/RELEASING.md has', () => {
  let message = '';
  try {
    selectOldestConsumer(PUBLISHED, '4.0.0');
  } catch (error) {
    message = (error as Error).message;
  }
  const section = /"([^"]+)" in docs\/RELEASING\.md/.exec(message)?.[1];
  assert.ok(section, `the error names no section of docs/RELEASING.md: ${message}`);
  const lines = readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8').split('\n');
  assert.ok(lines.includes(`## ${section}`), `docs/RELEASING.md has no section "${section}"`);
});

test('server versions are compared as numbers, so 0.9.0 is older than 0.10.0', () => {
  // Listed newest first, and in an order a string sort would also get wrong.
  assert.equal(selectOldestConsumer(dependingOn({ '0.10.0': '^3', '0.9.0': '^3', '1.0.0': '^3' }), '3.0.2'), '0.9.0');
});

test('a prerelease server version is skipped', () => {
  assert.equal(selectOldestConsumer(dependingOn({ '0.2.0-rc.1': '^3', '0.1.5-beta.0': '^3', '0.2.0': '^3' }), '3.0.2'), '0.2.0');
});

test('a registry document of another shape throws, and never reads as no consumer', () => {
  const documents: Array<[string, unknown]> = [
    ['null', null],
    ['a document without versions', {}],
    ['a list for versions', { versions: [] }],
    ['no versions at all', { versions: {} }],
    ['a version that is not an object', { versions: { '0.2.0': '^3' } }],
    ['dependencies that are a list', { versions: { '0.2.0': { dependencies: [DATA] } } }],
    ['a range that is not a string', { versions: { '0.2.0': { dependencies: { [DATA]: 3 } } } }],
  ];
  for (const [what, document] of documents) {
    assert.throws(() => selectOldestConsumer(document as typeof PUBLISHED, '3.0.2'), (error: unknown) =>
      error instanceof Error && !/no consumer/i.test(error.message), `${what} did not throw, or threw as no consumer`);
    assert.throws(() => selectNewestConsumer(document as typeof PUBLISHED, '3.0.2'), (error: unknown) =>
      error instanceof Error && !/no consumer/i.test(error.message), `${what} did not throw from the newest end, or threw as no consumer`);
  }
});

test('the newest consumer is 0.4.0, not an older server that depends on the same range', () => {
  assert.equal(selectNewestConsumer(PUBLISHED, '3.0.2'), '0.4.0');
});

test('a newest server version without the dependency is skipped', () => {
  // 0.5.0 has no dependencies at all, and 0.6.0 has some, but not this package.
  const document = { versions: { ...PUBLISHED.versions, '0.5.0': {}, '0.6.0': { dependencies: { zod: '4.5.4' } } } };
  assert.equal(selectNewestConsumer(document, '3.0.2'), '0.4.0');
});

test('a newest server whose range the candidate does not satisfy is skipped', () => {
  // A server can ask for a later minor, and a server after a schema bump depends on the next major.
  assert.equal(selectNewestConsumer(dependingOn({ '0.3.0': '^3', '0.4.0': '^3', '0.5.0': '^3.1.0', '1.0.0': '^4' }), '3.0.2'), '0.4.0');
});

test('server versions are compared as numbers from the newest end too, so 0.10.0 is newer than 0.9.0', () => {
  // Neither the listed order nor a string sort puts 0.10.0 last.
  assert.equal(selectNewestConsumer(dependingOn({ '0.9.0': '^3', '0.10.0': '^3', '0.2.0': '^3' }), '3.0.2'), '0.10.0');
});

test('a prerelease server version is skipped at the newest end too', () => {
  assert.equal(selectNewestConsumer(dependingOn({ '0.2.0': '^3', '0.4.0': '^3', '0.5.0-rc.1': '^3', '0.4.1-beta.0': '^3' }), '3.0.2'), '0.4.0');
});

test('a range the gate cannot read throws when the newest end meets it before the answer', () => {
  for (const range of ['>=3', '3.x', '~3.0.0', '^0']) {
    const document = dependingOn({ '0.2.0': '^3', '0.4.0': range });
    assert.throws(() => selectNewestConsumer(document, '3.0.2'), (error: unknown) => error instanceof Error && error.message.includes(range),
      `selectNewestConsumer read ${range}`);
    // Each end reads only the ranges it meets before its answer, and the oldest end stops at 0.2.0.
    assert.equal(selectOldestConsumer(document, '3.0.2'), '0.2.0', `selectOldestConsumer read ${range} past its answer`);
  }
  assert.throws(() => selectNewestConsumer({ versions: { '0.1.0': {} } }, '3.0'), /^Error: The candidate version 3\.0 is not x\.y\.z\.$/);
});

test('a candidate no published server accepts throws the same schema-bump error from the newest end', () => {
  /** What `select` throws for a 4.0.0 candidate, or undefined when it throws nothing. */
  const thrown = (select: typeof selectOldestConsumer): string | undefined => {
    try {
      select(PUBLISHED, '4.0.0');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };
  assert.match(thrown(selectNewestConsumer) ?? '', /published by hand under the schema-bump procedure/);
  assert.equal(thrown(selectNewestConsumer), thrown(selectOldestConsumer));
});

test('the sweep list holds the oldest consumer, then the newest', () => {
  assert.deepEqual(selectConsumers(PUBLISHED, '3.0.2'), [{ version: '0.2.0', end: 'oldest' }, { version: '0.4.0', end: 'newest' }]);
});

test('a server that is both the oldest and the newest consumer is on the sweep list once', () => {
  // The servers before and after it depend on other majors.
  const document = dependingOn({ '0.1.0': '^2', '0.2.0': '^3', '0.3.0': '^4' });
  assert.equal(selectOldestConsumer(document, '3.0.2'), '0.2.0');
  assert.equal(selectNewestConsumer(document, '3.0.2'), '0.2.0');
  assert.deepEqual(selectConsumers(document, '3.0.2'), [{ version: '0.2.0', end: 'oldest and newest' }]);
});

/** A stand-in for the install and sweep of one consumer: it records each consumer, and fails for `failOn`. */
function recordingCheck(failOn?: string) {
  const checked: Array<{ version: string; end: string }> = [];
  const check = async (consumer: { version: string; end: string }): Promise<void> => {
    checked.push(consumer);
    if (consumer.version === failOn) throw new Error(`the check of ${consumer.version} failed`);
  };
  return { checked, check };
}

test('the gate checks every listed consumer once, in order, and reports exactly the ones it checked', async () => {
  for (const listed of [selectConsumers(PUBLISHED, '3.0.2'), selectConsumers(dependingOn({ '0.2.0': '^3' }), '3.0.2')]) {
    const { checked, check } = recordingCheck();
    const reported = await checkConsumers(listed, check);
    // The report comes first, so a report that names a consumer the loop skipped fails on what it names.
    assert.deepEqual(reported, checked, 'the gate reports consumers other than the ones it checked');
    assert.deepEqual(checked, listed, 'the gate did not check every listed consumer, once and in order');
  }
});

test('a failed check stops the gate at that consumer, with an error that names it', async () => {
  const listed = selectConsumers(PUBLISHED, '3.0.2');
  const cases = [
    ['0.2.0', ['0.2.0'], 'The oldest consumer, @tibia.sh/tibiawiki-mcp@0.2.0, failed.'],
    ['0.4.0', ['0.2.0', '0.4.0'], 'The newest consumer, @tibia.sh/tibiawiki-mcp@0.4.0, failed.'],
  ] as const;
  for (const [failOn, ran, message] of cases) {
    const { checked, check } = recordingCheck(failOn);
    const error: unknown = await checkConsumers(listed, check).then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof Error, `a failed check of ${failOn} did not end the gate with an error`);
    assert.equal(error.message, message, `the error for a failed check of ${failOn} does not name that consumer`);
    // describe() prints the cause under FAIL, and the runbook looks that message up.
    assert.ok(error.cause instanceof Error && error.cause.message === `the check of ${failOn} failed`,
      `the error for a failed check of ${failOn} does not carry the check's own error as its cause`);
    assert.deepEqual(checked.map(({ version }) => version), ran, `the gate went on checking after ${failOn} failed`);
  }
});

const STAMP = '2026-09-13T07:02:58.860376+00:00';
const EXPECTED = { itemCount: 3, generateTime: STAMP };
type Page = Parameters<typeof evaluateSweep>[0][number];
const page = (titles: string[], fields: Partial<Page> = {}): Page =>
  ({ isError: false, titles, totalMatches: 3, indexGeneratedAt: STAMP, ...fields });
/** How the gate records a page the server answered with isError. */
const ERROR_PAGE: Page = { isError: true, titles: [], totalMatches: 0, indexGeneratedAt: '' };

test('a complete and clean sweep passes', () => {
  assert.equal(evaluateSweep([page(['Axe', 'Bow']), page(['Club'])], EXPECTED), undefined);
});

test('an error page fails the sweep, and its reason comes before every other check', () => {
  // The error page's empty stamp, count and titles would each fail a later check too.
  assert.equal(evaluateSweep([page(['Axe', 'Bow']), ERROR_PAGE], EXPECTED), 'page 2 is an error, so the server could not serve it');
});

test('a page from an index with another generate_time fails the sweep', () => {
  const other = '2026-09-12T19:53:53.020856+00:00';
  assert.equal(evaluateSweep([page(['Axe', 'Bow']), page(['Club'], { indexGeneratedAt: other })], EXPECTED),
    `page 2 came from an index generated at ${other}, not the candidate's ${STAMP}`);
});

test('a totalMatches other than the index item count fails the sweep', () => {
  assert.equal(evaluateSweep([page(['Axe', 'Bow']), page(['Club'], { totalMatches: 4 })], EXPECTED),
    'page 2 reports 4 matching items, but the index holds 3');
});

test('a title on two pages fails the sweep, though the count of distinct titles is right', () => {
  assert.equal(evaluateSweep([page(['Axe', 'Bow']), page(['Bow', 'Club'])], EXPECTED), '"Bow" came back on page 1 and again on page 2');
});

test('a title missing from every page fails the sweep, though totalMatches is right', () => {
  assert.equal(evaluateSweep([page(['Axe']), page(['Club'])], EXPECTED), 'the sweep returned 2 distinct items, but the index holds 3');
});

test('a sweep of an index without items fails', () => {
  // Every other check passes on an empty index, and then the gate would have checked nothing.
  assert.equal(evaluateSweep([page([], { totalMatches: 0 })], { itemCount: 0, generateTime: STAMP }),
    'the sweep returned no items, so it checked nothing');
});

test('a registry answer other than 200 gives its status, and its status text only when there is one', async () => {
  // Over HTTP/2 an answer has no status text, which is how the registry's own 404 came back.
  const cases: Array<[ResponseInit, string]> = [
    [{ status: 404 }, 'The registry answered 404.'],
    [{ status: 503, statusText: 'Service Unavailable' }, 'The registry answered 503 Service Unavailable.'],
  ];
  const fetch = globalThis.fetch;
  try {
    for (const [init, message] of cases) {
      globalThis.fetch = async () => new Response(null, init);
      const error: unknown = await readRegistry().then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof Error && error.cause instanceof Error, `a ${init.status} answer did not fail the read with a cause`);
      assert.equal(error.cause.message, message);
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

/** How long the stand-in server hangs before it exits by itself. A sweep that takes half as long had no bound. */
const HANG_MS = 30_000;

/**
 * Stands in for a server whose connect fails. It closes its stderr at once, so a sweep that took
 * the end of a stderr pipe for the exit would stop waiting while the stand-in still runs. It
 * opens /dev/null in its place, because Node reopens stderr at the stdin EOF and would crash
 * without one. It answers initialize with a protocol version no client speaks, so the client
 * fails the connect and starts closing the server without waiting for it. It ignores the stdin
 * EOF and the SIGTERM that close sends, so only SIGKILL stops it before HANG_MS. It records its
 * pid in STAND_IN_PID.
 */
const STUBBORN_SERVER = `import { closeSync, openSync, writeFileSync } from 'node:fs';
closeSync(2);
openSync('/dev/null', 'w');
writeFileSync(process.env.STAND_IN_PID, String(process.pid));
process.on('SIGTERM', () => {});
let buffered = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffered += chunk;
  let end = buffered.indexOf('\\n');
  while (end !== -1) {
    const { id, method } = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    end = buffered.indexOf('\\n');
    if (method !== 'initialize') continue;
    const result = { protocolVersion: '1999-01-01', capabilities: {}, serverInfo: { name: 'stand-in', version: '0.0.0' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
  }
});
setTimeout(() => {}, ${HANG_MS});
`;

/** The pid the stand-in recorded, or undefined before it has. Never 0, which `process.kill` reads as the process group. */
const standInPid = (file: string): number | undefined => {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
};

/** Whether the process `pid` still exists. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

// The timeout outlasts HANG_MS, so a sweep that waits for the stand-in to give up by itself still
// fails on the bound below, and a sweep that never ends fails on the timeout instead of holding the
// run open.
test('a failed connect ends the sweep only once the server has exited, even one that ignores SIGTERM and closes its stderr', { timeout: HANG_MS + 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-oldest-consumer-test-'));
  const entry = join(dir, 'server.mjs');
  const pidFile = join(dir, 'pid');
  writeFileSync(entry, STUBBORN_SERVER);
  const started = Date.now();
  try {
    const error: unknown = await sweep(entry, join(dir, 'index.db'), { STAND_IN_PID: pidFile })
      .then(() => undefined, (thrown: unknown) => thrown);
    const ms = Date.now() - started;
    // Checked the moment the sweep ends, with no grace: Node reaps a child before its process closes.
    const pid = standInPid(pidFile);
    const running = pid !== undefined && isRunning(pid);
    // Rules out a stand-in that failed some other way, before the connect this test is about.
    assert.ok(error instanceof Error && error.message === "Server's protocol version is not supported: 1999-01-01",
      `the connect did not fail on the stand-in's protocol version: ${String(error)}`);
    assert.ok(pid !== undefined, 'the stand-in never recorded its pid');
    assert.equal(running, false, 'the server was still running when the sweep ended');
    assert.ok(ms < HANG_MS / 2, `the sweep ended after ${ms} ms, when the server gave up by itself, so nothing killed it`);
  } finally {
    // A sweep that ended too early leaves the stand-in running.
    const pid = standInPid(pidFile);
    if (pid !== undefined && isRunning(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server that cannot start ends the sweep at once, with no process to wait for', { timeout: 5_000 }, async () => {
  // An environment too big to hand to a new process fails the spawn with E2BIG, before any
  // process exists, so neither path below is ever read.
  const error: unknown = await sweep(join(tmpdir(), 'no-server.mjs'), join(tmpdir(), 'no-index.db'), { TOO_BIG: 'x'.repeat(4 * 1024 * 1024) })
    .then(() => undefined, (thrown: unknown) => thrown);
  assert.equal((error as NodeJS.ErrnoException | undefined)?.code, 'E2BIG', `the spawn did not fail with E2BIG: ${String(error)}`);
});
