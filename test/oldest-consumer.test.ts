import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSweep, satisfiesCaret, selectOldestConsumer } from '../scripts/oldest-consumer.ts';

/**
 * scripts/oldest-consumer.ts installs from the registry and serves every item through a
 * published server, so the suite cannot run it. These pin its decisions instead: which
 * published server is the oldest consumer of a candidate, and whether the sweep through that
 * server was complete and clean. `pnpm oldest-consumer` runs the whole gate.
 */

const DATA = '@tibia.sh/tibiawiki-data';

/** The server versions on npm as of 2026-09-13, with the dependencies the abbreviated document lists. */
const PUBLISHED = {
  versions: {
    '0.1.0': { dependencies: { zod: '4.5.4', '@modelcontextprotocol/server': '2.0.0' } },
    '0.2.0': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
    '0.3.0': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
    '0.3.1': { dependencies: { zod: '4.5.4', [DATA]: '^3', '@modelcontextprotocol/server': '2.0.0' } },
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
