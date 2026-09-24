import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { holdReasons } from '../scripts/drift-guard.ts';

/**
 * The guard decides whether a refresh merges by itself, so its reasons are pinned here word for
 * word. holdReasons is checked on row count literals, and the command the way the drift workflow
 * runs it, on two small indexes built in a temp directory.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'drift-guard.ts');

/** The eight main tables at the counts the committed index had in the example. */
const MAIN = { item: 9800, creature: 2193, npc: 1245, book: 1500, house: 1000, achievement: 600, quest: 400, spell: 300 };

/**
 * Builds an index at `path` with the database_info rows readSnapshot requires and a table per
 * entry of `rows`, filled to that many rows. The release notes test has a builder like it, which
 * this file cannot import without running that file's tests too.
 */
function makeIndex(path: string, rows: Record<string, number>): void {
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const db = new DatabaseSync(path);
  try {
    db.exec('create table database_info (key text primary key, value text)');
    db.exec("insert into database_info (key, value) values ('generate_time', '2026-09-21T06:20:11.123456+00:00'), ('version', '9.0.0')");
    for (const [name, count] of Object.entries(rows)) {
      db.exec(`create table ${quoted(name)} (id integer primary key)`);
      if (count > 0) {
        db.exec(`with recursive c(x) as (select 1 union all select x + 1 from c where x < ${count}) ` +
          `insert into ${quoted(name)} (id) select x from c`);
      }
    }
  } finally {
    db.close();
  }
}

/** Runs the command the way the drift workflow runs it. */
const run = (args: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('the same counts hold nothing', () => {
  assert.deepEqual(holdReasons({ ...MAIN, creature_drop: 19_496 }, { ...MAIN, creature_drop: 19_496 }), []);
});

test('growth holds nothing, in a main table, a secondary table or a new one', () => {
  assert.deepEqual(holdReasons({ ...MAIN, creature_drop: 5 }, { ...MAIN, item: 12_000, creature_drop: 9, npc_job: 3 }), []);
});

test('a main table that lost exactly 1% holds nothing', () => {
  assert.deepEqual(holdReasons({ ...MAIN, item: 10_000 }, { ...MAIN, item: 9900 }), []);
});

test('a main table that lost just over 1% holds, naming the loss, the count and the percentage', () => {
  assert.deepEqual(holdReasons(MAIN, { ...MAIN, item: 9650 }), ['item lost 150 of 9,800 rows (1.5%)']);
  // 99 of 9,800 is 1.01%, over the line, and still reads with its one decimal.
  assert.deepEqual(holdReasons(MAIN, { ...MAIN, item: 9701 }), ['item lost 99 of 9,800 rows (1.0%)']);
});

test('a committed table missing from the rebuilt index holds', () => {
  assert.deepEqual(holdReasons({ ...MAIN, npc_job: 12 }, MAIN), ['table npc_job is missing']);
});

test('a secondary table that empties holds, and one that shrinks does not', () => {
  assert.deepEqual(holdReasons({ ...MAIN, creature_drop: 19_496 }, { ...MAIN, creature_drop: 0 }),
    ['table creature_drop is empty, it had 19,496 rows']);
  assert.deepEqual(holdReasons({ ...MAIN, creature_drop: 19_496 }, { ...MAIN, creature_drop: 1 }), []);
});

test('reasons come main tables first in their fixed order, then the other tables by name', () => {
  // creature comes before achievement in the fixed order and after it by name.
  const committed = { ...MAIN, npc_job: 3, creature_drop: 19_496 };
  const rebuilt = { ...MAIN, achievement: 500, creature: 2000, creature_drop: 0 };
  assert.deepEqual(holdReasons(committed, rebuilt), [
    'creature lost 193 of 2,193 rows (8.8%)',
    'achievement lost 100 of 600 rows (16.7%)',
    'table creature_drop is empty, it had 19,496 rows',
    'table npc_job is missing',
  ]);
});

test('a main table with 0 committed rows never holds on the percentage, but holds when it goes missing', () => {
  assert.deepEqual(holdReasons({ ...MAIN, spell: 0 }, { ...MAIN, spell: 0 }), []);
  const { spell: _spell, ...withoutSpell } = MAIN;
  assert.deepEqual(holdReasons({ ...MAIN, spell: 0 }, withoutSpell), ['table spell is missing']);
});

test('a main table that empties gets the empty reason only', () => {
  assert.deepEqual(holdReasons(MAIN, { ...MAIN, npc: 0 }), ['table npc is empty, it had 1,245 rows']);
});

test('the command prints each reason on its own line, or nothing, and exits 0 either way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-drift-guard-'));
  try {
    const committed = join(dir, 'committed.db');
    const held = join(dir, 'held.db');
    const grown = join(dir, 'grown.db');
    makeIndex(committed, { item: 200, creature: 50, npc_job: 3 });
    makeIndex(held, { item: 190, creature: 50 });
    makeIndex(grown, { item: 201, creature: 50, npc_job: 3 });

    const hold = run([committed, held]);
    assert.equal(hold.status, 0, hold.stderr);
    assert.equal(hold.stdout, 'item lost 10 of 200 rows (5.0%)\ntable npc_job is missing\n');
    assert.equal(hold.stderr, '');

    const go = run([committed, grown]);
    assert.equal(go.status, 0, go.stderr);
    assert.equal(go.stdout, '');
    assert.equal(go.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the command cannot read exits 1 with the reason on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-drift-guard-'));
  try {
    const committed = join(dir, 'committed.db');
    makeIndex(committed, { item: 200 });
    for (const args of [[join(dir, 'absent.db'), committed], [committed, join(dir, 'absent.db')]]) {
      const result = run(args);
      assert.equal(result.status, 1, `${JSON.stringify(args)} did not exit 1\n${result.stderr}`);
      assert.equal(result.stdout, '', `${JSON.stringify(args)} printed a reason anyway`);
      assert.notEqual(result.stderr, '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong argument count prints the usage and exits 2', () => {
  for (const args of [[], ['committed.db'], ['committed.db', 'index.db', 'extra.db']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} did not exit 2\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node scripts\/drift-guard\.ts <committed\.db> <rebuilt\.db>/);
  }
});
