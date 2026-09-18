import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { previousTag, readSnapshot, renderNotes, type Snapshot } from '../scripts/release-notes.ts';

/**
 * The release notes are the release page, so their markdown is pinned here character for
 * character, against the example in the design. The pure parts are checked on snapshot
 * literals, and the parts that read a file on small indexes built in a temp directory.
 * The command is run as the workflow runs it, in both of its modes, including against
 * this repository's own index.db.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'release-notes.ts');

const STAMP = '2026-09-21T06:20:11.123456+00:00';

/** A snapshot with the given row counts, taken at `STAMP` unless another time is given. */
const snapshot = (rows: Record<string, number>, generateTime = STAMP): Snapshot =>
  ({ generateTime, generator: '9.0.0', rows });

/** The eight fixed tables, in the order the notes list them, at one row each. */
const FIXED = { item: 1, creature: 1, npc: 1, book: 1, house: 1, achievement: 1, quest: 1, spell: 1 };

/**
 * Builds an index at `path`: a database_info holding `info`, a table per entry of `rows`
 * filled to that many rows, and an index on each name in `indexes`.
 */
function makeIndex(path: string, { info, rows, indexes = [] }: {
  info: Record<string, string>;
  rows: Record<string, number>;
  indexes?: string[];
}): void {
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const db = new DatabaseSync(path);
  try {
    db.exec('create table database_info (key text primary key, value text)');
    for (const [key, value] of Object.entries(info)) {
      db.prepare('insert into database_info (key, value) values (?, ?)').run(key, value);
    }
    for (const [name, count] of Object.entries(rows)) {
      db.exec(`create table ${quoted(name)} (id integer primary key)`);
      if (count > 0) {
        db.exec(`with recursive c(x) as (select 1 union all select x + 1 from c where x < ${count}) ` +
          `insert into ${quoted(name)} (id) select x from c`);
      }
    }
    for (const name of indexes) db.exec(`create index ${quoted(`${name}_id`)} on ${quoted(name)} (id)`);
  } finally {
    db.close();
  }
}

/** Runs the command the way the workflow runs it, with `input` on stdin. */
const run = (args: string[], input = ''): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, input, encoding: 'utf8' });

/** The generate_time and generator of this repository's own index, read the way the notes do. */
function shippedIndex(): { generateTime: string; generator: string } {
  const db = new DatabaseSync(join(ROOT, 'index.db'), { readOnly: true });
  try {
    const value = (key: string): string =>
      String(db.prepare('select value from database_info where key = ?').get(key)?.['value']);
    return { generateTime: value('generate_time'), generator: value('version') };
  } finally {
    db.close();
  }
}

/** The design's example, character for character. The notes for a release start with it. */
const EXAMPLE = `A snapshot of [TibiaWiki](https://tibia.fandom.com) taken at \`${STAMP}\` by tibiawiki-sql \`9.0.0\`.

Install it with \`npm install @tibia.sh/tibiawiki-data@3.0.4\`. It is on npm as [\`@tibia.sh/tibiawiki-data@3.0.4\`](https://www.npmjs.com/package/@tibia.sh/tibiawiki-data/v/3.0.4).

| Table | Rows | Change since \`3.0.3\` |
|---|---|---|
| \`item\` | 9,812 | +12 |
| \`creature\` | 2,193 | 0 |
| \`npc\` | 1,244 | -1 |
`;

test('the design example is the start of the notes read from two indexes, inside the full eight-row table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-release-notes-'));
  try {
    const info = { timestamp: '1790000411.123456', generate_time: STAMP, version: '9.0.0' };
    const previousPath = join(dir, 'previous.db');
    const currentPath = join(dir, 'index.db');
    makeIndex(previousPath, {
      info: { ...info, generate_time: '2026-09-14T12:56:04.784727+00:00' },
      rows: { item: 9800, creature: 2193, npc: 1245, book: 5, house: 4, achievement: 3, quest: 2, spell: 1 },
    });
    makeIndex(currentPath, {
      info,
      rows: { item: 9812, creature: 2193, npc: 1244, book: 5, house: 4, achievement: 3, quest: 2, spell: 1 },
    });

    const notes = renderNotes('3.0.4', readSnapshot(currentPath), {
      version: '3.0.3',
      snapshot: readSnapshot(previousPath),
    });
    assert.equal(
      notes,
      `${EXAMPLE}| \`book\` | 5 | 0 |\n| \`house\` | 4 | 0 |\n| \`achievement\` | 3 | 0 |\n` +
        '| `quest` | 2 | 0 |\n| `spell` | 1 | 0 |\n',
    );
    // The notes end in one newline, so `gh release create` gets no blank line before its own.
    assert.ok(notes.endsWith('|\n') && !notes.endsWith('\n\n'), 'the notes do not end in exactly one newline');

    // The four-argument mode is how the workflow asks for these notes, previous index and all.
    const command = run(['3.0.4', currentPath, '3.0.3', previousPath]);
    assert.equal(command.status, 0, `the command failed on two indexes\n${command.stderr}`);
    assert.equal(command.stdout, notes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the eight fixed tables come first, in their order, then the other changed tables by name', () => {
  // charm and world changed, mount did not, and database_info is the same on both sides.
  const current = snapshot({ ...FIXED, charm: 3, mount: 4, world: 5, database_info: 3 });
  const previous = snapshot({ ...FIXED, charm: 2, mount: 4, world: 9, database_info: 3 }, '2026-09-14T12:56:04.784727+00:00');
  const notes = renderNotes('3.0.4', current, { version: '3.0.3', snapshot: previous });
  const names = [...notes.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
  assert.deepEqual(names, ['item', 'creature', 'npc', 'book', 'house', 'achievement', 'quest', 'spell', 'charm', 'world']);
});

test('a table on one side only counts as 0 on the other, and a fixed table missing from both is still listed', () => {
  const current = snapshot({ item: 3, outfit: 2 });
  const previous = snapshot({ item: 3, map: 4 }, '2026-09-14T12:56:04.784727+00:00');
  const notes = renderNotes('3.0.4', current, { version: '3.0.3', snapshot: previous });
  const table = notes.slice(notes.indexOf('| Table |'));
  assert.equal(table, `| Table | Rows | Change since \`3.0.3\` |
|---|---|---|
| \`item\` | 3 | 0 |
| \`creature\` | 0 | 0 |
| \`npc\` | 0 | 0 |
| \`book\` | 0 | 0 |
| \`house\` | 0 | 0 |
| \`achievement\` | 0 | 0 |
| \`quest\` | 0 | 0 |
| \`spell\` | 0 | 0 |
| \`map\` | 0 | -4 |
| \`outfit\` | 2 | +2 |
`);
});

test('rows and changes use the en-US thousands separator, and a change is +N, -N or 0', () => {
  const current = snapshot({ ...FIXED, item: 1_234_567, creature: 2193, npc: 1000 });
  const previous = snapshot({ ...FIXED, item: 1_233_367, creature: 2193, npc: 3400 }, '2026-09-14T12:56:04.784727+00:00');
  const notes = renderNotes('3.0.4', current, { version: '3.0.3', snapshot: previous });
  assert.match(notes, /^\| `item` \| 1,234,567 \| \+1,200 \|$/m);
  assert.match(notes, /^\| `creature` \| 2,193 \| 0 \|$/m);
  assert.match(notes, /^\| `npc` \| 1,000 \| -2,400 \|$/m);
});

test('a previous release with the same generate_time gives the same-snapshot sentence and no table', () => {
  const current = snapshot({ ...FIXED, item: 9812 });
  const notes = renderNotes('3.0.4', current, { version: '3.0.3', snapshot: snapshot({ ...FIXED, item: 9812 }) });
  assert.equal(notes, `A snapshot of [TibiaWiki](https://tibia.fandom.com) taken at \`${STAMP}\` by tibiawiki-sql \`9.0.0\`. It is the same snapshot as in \`3.0.3\`.

Install it with \`npm install @tibia.sh/tibiawiki-data@3.0.4\`. It is on npm as [\`@tibia.sh/tibiawiki-data@3.0.4\`](https://www.npmjs.com/package/@tibia.sh/tibiawiki-data/v/3.0.4).
`);
});

test('with no previous release the table has two columns and the eight fixed tables', () => {
  const notes = renderNotes('3.0.0', snapshot({ ...FIXED, item: 9812, npc: 1244, charm: 7 }));
  assert.equal(notes, `A snapshot of [TibiaWiki](https://tibia.fandom.com) taken at \`${STAMP}\` by tibiawiki-sql \`9.0.0\`.

Install it with \`npm install @tibia.sh/tibiawiki-data@3.0.0\`. It is on npm as [\`@tibia.sh/tibiawiki-data@3.0.0\`](https://www.npmjs.com/package/@tibia.sh/tibiawiki-data/v/3.0.0).

| Table | Rows |
|---|---|
| \`item\` | 9,812 |
| \`creature\` | 1 |
| \`npc\` | 1,244 |
| \`book\` | 1 |
| \`house\` | 1 |
| \`achievement\` | 1 |
| \`quest\` | 1 |
| \`spell\` | 1 |
`);
});

test('tags are compared as numbers, so v3.0.10 is the tag below 3.0.11 and v3.0.9 is not', () => {
  // Neither the listed order nor a string sort puts v3.0.10 last.
  assert.equal(previousTag(['v3.0.9', 'v3.0.10', 'v3.0.2'], '3.0.11'), 'v3.0.10');
});

test('a lower major is the previous tag when nothing in the version major is below', () => {
  assert.equal(previousTag(['v2.9.9', 'v3.0.0'], '4.0.0'), 'v3.0.0');
  assert.equal(previousTag(['v2.5.1', 'v3.0.0', 'v3.1.0'], '3.0.0'), 'v2.5.1');
});

test('a tag that is not exactly vX.Y.Z is ignored', () => {
  const tags = ['v3.0.4-rc.1', '3.0.2', 'v3.0.04', 'vlatest', 'v3.0', 'v3.0.0.1', 'v3.0.1', ''];
  assert.equal(previousTag(tags, '3.0.5'), 'v3.0.1');
});

test('no tag below the version gives nothing, and the version tag itself is not below it', () => {
  assert.equal(previousTag(['v3.0.4', 'v3.1.0'], '3.0.4'), undefined);
  assert.equal(previousTag([], '3.0.4'), undefined);
});

test('a version that is not X.Y.Z throws rather than compare, quoting what it was given', () => {
  // Quoted, so an empty version or one that is all spaces still reads as a value in the message.
  for (const version of ['3.0', 'v3.0.0', '3.0.0-rc.1', '3.0.01', '', ' ']) {
    assert.throws(() => previousTag(['v3.0.1'], version),
      { message: `${JSON.stringify(version)} is not an x.y.z version.` }, `previousTag read ${JSON.stringify(version)}`);
  }
});

test('an index without generate_time or without the generator version throws, naming the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-release-notes-'));
  try {
    const noTime = join(dir, 'no-time.db');
    const noGenerator = join(dir, 'no-generator.db');
    makeIndex(noTime, { info: { version: '9.0.0' }, rows: { item: 1 } });
    makeIndex(noGenerator, { info: { generate_time: STAMP }, rows: { item: 1 } });
    assert.throws(() => readSnapshot(noTime), (error: unknown) =>
      error instanceof Error && error.message.includes('generate_time') && error.message.includes(noTime));
    assert.throws(() => readSnapshot(noGenerator), (error: unknown) =>
      error instanceof Error && error.message.includes('version') && error.message.includes(noGenerator));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot counts the tables only, not the indexes or sqlite_ tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-release-notes-'));
  try {
    const path = join(dir, 'index.db');
    makeIndex(path, { info: { generate_time: STAMP, version: '9.0.0' }, rows: { item: 3, creature: 0 }, indexes: ['item'] });
    // An AUTOINCREMENT column makes SQLite keep its own sqlite_sequence table, which is not the index's.
    const db = new DatabaseSync(path);
    try {
      db.exec('create table counted (id integer primary key autoincrement)');
      db.exec("insert into counted (id) values (1)");
    } finally {
      db.close();
    }
    const read = readSnapshot(path);
    assert.equal(read.generateTime, STAMP);
    assert.equal(read.generator, '9.0.0');
    // Spread, because the counts come back on an object with no prototype.
    assert.deepEqual({ ...read.rows }, { counted: 1, creature: 0, database_info: 2, item: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a table named constructor or __proto__ is counted and compared like any other', () => {
  // On a plain object the count of `constructor` would come back as a function and the count of
  // `__proto__` would never be stored at all, so both tables would report a nonsense change.
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-release-notes-'));
  try {
    const previousPath = join(dir, 'previous.db');
    const currentPath = join(dir, 'index.db');
    makeIndex(previousPath, { info: { generate_time: '2026-09-14T12:56:04.784727+00:00', version: '9.0.0' }, rows: { item: 1 } });
    // A computed key, because `__proto__:` in an object literal sets the prototype instead.
    makeIndex(currentPath, { info: { generate_time: STAMP, version: '9.0.0' }, rows: { item: 1, constructor: 2, ['__proto__']: 5 } });

    const current = readSnapshot(currentPath);
    assert.equal(current.rows['constructor'], 2);
    assert.equal(current.rows['__proto__'], 5);
    const notes = renderNotes('3.0.4', current, { version: '3.0.3', snapshot: readSnapshot(previousPath) });
    assert.match(notes, /^\| `__proto__` \| 5 \| \+5 \|$/m);
    assert.match(notes, /^\| `constructor` \| 2 \| \+2 \|$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a table whose name is a SQL keyword or holds a double quote is counted under that name', () => {
  // The name reaches `select count(*)` as an interpolated identifier, so it is quoted there.
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-release-notes-'));
  try {
    const path = join(dir, 'index.db');
    makeIndex(path, { info: { generate_time: STAMP, version: '9.0.0' }, rows: { order: 3, 'we"ird': 2, 'from': 0 } });
    const { rows } = readSnapshot(path);
    assert.equal(rows['order'], 3);
    assert.equal(rows['we"ird'], 2);
    assert.equal(rows['from'], 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an argument shape the command does not read prints a usage naming both modes and exits 2', () => {
  const shapes = [[], ['3.0.4'], ['3.0.4', 'index.db', '3.0.3'], ['3.0.4', 'index.db', '3.0.3', 'previous.db', 'extra'],
    ['--previous-tag'], ['--previous-tag', '3.0.4', 'index.db'],
    // A version that is not x.y.z is a usage error too, checked before any file is opened, so a
    // flag or a tag name in the version's place never reads as the name of a release.
    ['--help', 'index.db'], ['3.0', 'index.db'], ['v3.0.4', 'index.db'],
    ['3.0.4', 'index.db', 'v3.0.3', 'previous.db'], ['3.0.4', 'index.db', '3.0.3-rc.1', 'previous.db']];
  for (const args of shapes) {
    const result = run(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} did not exit 2\n${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', `${JSON.stringify(args)} printed notes anyway`);
    assert.match(result.stderr, /--previous-tag <version>/, `the usage for ${JSON.stringify(args)} misses the tag mode`);
    assert.match(result.stderr, /<version> <index\.db>/, `the usage for ${JSON.stringify(args)} misses the notes mode`);
  }
});

test('--previous-tag reads the tags from stdin and prints the previous tag, or nothing, exit 0', () => {
  const tags = 'v3.0.1\nv3.0.2\nv3.0.10\nv3.1.0\n';
  const found = run(['--previous-tag', '3.0.11'], tags);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, 'v3.0.10\n');
  const none = run(['--previous-tag', '3.0.0'], tags);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
  const empty = run(['--previous-tag', '3.0.11'], '');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
});

test('the command prints the notes for the shipped index, carrying its real generate_time', () => {
  const result = run(['3.0.3', 'index.db']);
  assert.equal(result.status, 0, `the command failed on the shipped index\n${result.stderr}`);
  const { generateTime, generator } = shippedIndex();
  assert.ok(
    result.stdout.startsWith(
      `A snapshot of [TibiaWiki](https://tibia.fandom.com) taken at \`${generateTime}\` by tibiawiki-sql \`${generator}\`.\n`),
    `the notes do not open on the shipped index snapshot sentence\n${result.stdout.slice(0, 400)}`,
  );
  assert.match(result.stdout, /^\| `item` \| [\d,]+ \|$/m);
});
