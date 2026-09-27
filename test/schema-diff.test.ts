import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { compareSchemas, schemaOf } from '../scripts/schema-diff.ts';

/**
 * The schema difference decides the version level of a refresh and whether it holds, so it is pinned here:
 * compareSchemas on literal schemas, schemaOf and the command on small indexes built in a temp directory.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'schema-diff.ts');

const run = (args: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

const schema = (tables: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(tables));

const COMMITTED = schema({
  creature: ['article_id', 'title', 'hitpoints'],
  npc: ['article_id', 'title'],
  npc_location: ['npc_id', 'location'],
});

/** Builds an index at `path` from `sql`, run as one script. */
function makeIndex(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Runs `body` with a temp directory that is removed afterwards. */
function inTemp(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-schema-diff-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an added column is added as table.column', () => {
  const rebuilt = schema({ ...Object.fromEntries(COMMITTED), creature: ['article_id', 'title', 'hitpoints', 'race_id'] });
  assert.deepEqual(compareSchemas(COMMITTED, rebuilt), { added: ['creature.race_id'], removed: [] });
});

test('a dropped table is removed as the table alone, not its columns', () => {
  const { npc_location: _dropped, ...rest } = Object.fromEntries(COMMITTED);
  assert.deepEqual(compareSchemas(COMMITTED, schema(rest)), { added: [], removed: ['npc_location'] });
});

test('equal schemas give both lists empty, whatever the order of tables and columns', () => {
  assert.deepEqual(compareSchemas(COMMITTED, COMMITTED), { added: [], removed: [] });
  const reordered = schema({ npc_location: ['location', 'npc_id'], npc: ['title', 'article_id'], creature: ['hitpoints', 'title', 'article_id'] });
  assert.deepEqual(compareSchemas(COMMITTED, reordered), { added: [], removed: [] });
});

test('each list is sorted, tables and columns together', () => {
  const rebuilt = schema({
    creature: ['article_id', 'title', 'race_id', 'bestiary_class'],
    npc: ['article_id'],
    achievement: ['article_id'],
    npc_location: ['npc_id', 'location'],
  });
  assert.deepEqual(compareSchemas(COMMITTED, rebuilt), {
    added: ['achievement', 'creature.bestiary_class', 'creature.race_id'],
    removed: ['creature.hitpoints', 'npc.title'],
  });
});

test('schemaOf reads every table and its columns, hidden and generated ones included, and no sqlite_ table', () => {
  inTemp((dir) => {
    const path = join(dir, 'index.db');
    makeIndex(path, [
      'create table creature (id integer primary key autoincrement, name text, lower_name text generated always as (lower(name)) virtual)',
      "insert into creature (name) values ('Dragon')",
      'create table "odd ""name""" (x)',
    ].join(';\n'));
    const read = schemaOf(path);
    assert.deepEqual([...read.keys()].sort(), ['creature', 'odd "name"'], 'schemaOf read other tables, or missed one');
    assert.deepEqual(read.get('creature'), ['id', 'name', 'lower_name']);
    assert.deepEqual(read.get('odd "name"'), ['x']);
  });
});

test('the command prints the difference as JSON, and exits 0', () => {
  inTemp((dir) => {
    const committed = join(dir, 'committed.db');
    const rebuilt = join(dir, 'rebuilt.db');
    makeIndex(committed, 'create table creature (id, name); create table npc_location (npc_id)');
    makeIndex(rebuilt, 'create table creature (id, name, race_id)');
    const result = run([committed, rebuilt]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"added":["creature.race_id"],"removed":["npc_location"]}\n');
    assert.equal(result.stderr, '');
  });
});

test('a file the command cannot read exits 1 with the reason on stderr, and prints nothing', () => {
  inTemp((dir) => {
    const good = join(dir, 'good.db');
    const garbage = join(dir, 'garbage.db');
    makeIndex(good, 'create table creature (id)');
    writeFileSync(garbage, 'not a database, but long enough that sqlite reads a header from it\n'.repeat(10));
    for (const args of [[join(dir, 'absent.db'), good], [good, join(dir, 'absent.db')], [good, garbage]]) {
      const result = run(args);
      assert.equal(result.status, 1, `${JSON.stringify(args)} did not exit 1\n${result.stderr}`);
      assert.equal(result.stdout, '', `${JSON.stringify(args)} printed a difference anyway`);
      assert.notEqual(result.stderr, '');
    }
  });
});

test('a wrong argument count prints the usage and exits 2', () => {
  for (const args of [[], ['committed.db'], ['committed.db', 'index.db', 'extra.db']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} did not exit 2\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node scripts\/schema-diff\.ts <committed\.db> <rebuilt\.db>/);
  }
});
