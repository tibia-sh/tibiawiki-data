import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { indexDigest } from '../scripts/index-digest.ts';

/**
 * The drift job refreshes the package whenever this digest moves, so what moves it is pinned
 * here on scratch copies of the committed index.db, which is never written to. No digest is
 * pinned as a literal: the drift job runs this suite on every rebuilt index, and a rebuild that
 * changed is the reason the job exists.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'index-digest.ts');
const INDEX = join(ROOT, 'index.db');

const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-digest-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

let copies = 0;

/** A fresh copy of index.db in the temp directory, with `sql` run on it when given. */
function scratch(sql?: string): string {
  const path = join(dir, `copy-${++copies}.db`);
  copyFileSync(INDEX, path);
  if (sql !== undefined) {
    const db = new DatabaseSync(path);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }
  return path;
}

/** Runs one query on the index at `path`, read-only. */
function query(path: string, sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** The index's tables, sqlite_ ones left out, in name order. */
const tables = (path: string): string[] =>
  query(path, "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name")
    .map((row) => String(row['name']));

/**
 * index.db written again into a new file with the given text encoding, table by table from its
 * own create statements, each table's rows read back as BigInt integers and inserted in the
 * order given. ATTACH cannot do it: SQLite refuses to attach a database with another encoding.
 */
function rewrite(encoding: 'UTF-8' | 'UTF-16le', order: 'same' | 'reversed'): string {
  const path = join(dir, `copy-${++copies}.db`);
  const source = new DatabaseSync(INDEX, { readOnly: true });
  const target = new DatabaseSync(path);
  try {
    target.exec(`pragma encoding = '${encoding}'`);
    target.exec('begin');
    const creates = source.prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\'").all();
    for (const { name, sql } of creates) {
      target.exec(String(sql));
      const columns = source.prepare(`pragma table_xinfo(${quoted(String(name))})`).all()
        .filter((column) => column['hidden'] === 0)
        .map((column) => quoted(String(column['name'])));
      const read = source.prepare(`select ${columns.join(', ')} from ${quoted(String(name))}`);
      read.setReadBigInts(true);
      const rows = read.all().map((row) => Object.values(row));
      if (order === 'reversed') rows.reverse();
      const insert = target.prepare(`insert into ${quoted(String(name))} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`);
      for (const row of rows) insert.run(...(row as Array<null | number | bigint | string | Uint8Array>));
    }
    target.exec('commit');
  } finally {
    target.close();
    source.close();
  }
  return path;
}

/** The digest of index.db as committed, taken from a copy. */
const baseline = indexDigest(scratch());

/** Runs the command the way the drift workflow does, with `args` after the script. */
const command = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('the digest is SHA-256 hex, the same on every run, and the command prints what the function returns', () => {
  const copy = scratch();
  const digest = indexDigest(copy);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(indexDigest(copy), digest, 'a second run over the same file gave another digest');
  assert.equal(digest, baseline, 'two copies of the same index gave different digests');
  const run = command(copy);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${digest}\n`);
  assert.equal(run.stderr, '');
});

test('rewriting every per-row timestamp leaves the digest unchanged', () => {
  const stamped = tables(INDEX).filter((name) =>
    query(INDEX, `pragma table_xinfo(${quoted(name)})`).some((column) => column['name'] === 'timestamp'));
  assert.ok(stamped.includes('item') && stamped.includes('creature'), `the tables with a timestamp column are ${stamped.join(', ')}`);
  const copy = scratch(stamped.map((name) => `update ${quoted(name)} set "timestamp" = 'rewritten';`).join('\n'));
  for (const name of stamped) {
    const [left] = query(copy, `select count(*) as count from ${quoted(name)} where "timestamp" is not 'rewritten'`);
    assert.equal(left?.['count'], 0, `${name} kept a timestamp the test meant to rewrite`);
  }
  assert.equal(indexDigest(copy), baseline);
});

test("changing, adding or deleting database_info's other keys leaves the digest unchanged", () => {
  const copy = scratch(`
    update database_info set value = value || ' changed' where key <> 'version';
    delete from database_info where key = 'python_version';
    insert into database_info (key, value) values ('build_host', 'a laptop');
  `);
  assert.equal(indexDigest(copy), baseline);
});

test('changing one value in any other column changes the digest', () => {
  const changes: Array<[string, string]> = [
    ['a name the tools read', "update item set name = name || ' changed' where rowid = (select min(rowid) from item)"],
    ['a text column no tool reads', "update item set flavor_text = coalesce(flavor_text, '') || ' changed' where rowid = (select min(rowid) from item)"],
    ['an integer', 'update creature set hitpoints = coalesce(hitpoints, 0) + 1 where rowid = (select min(rowid) from creature)'],
    ['a real', 'update creature_drop set chance = coalesce(chance, 0) + 0.5 where rowid = (select min(rowid) from creature_drop)'],
    ['a NULL made a value', "update npc set subarea = 'somewhere' where rowid = (select min(rowid) from npc where subarea is null)"],
    ['the generator version', "update database_info set value = '9.0.1' where key = 'version'"],
    ['the schema version', 'update mcp_schema_version set version = version + 1'],
    ['a status', "update spell set status = 'changed' where rowid = (select min(rowid) from spell)"],
  ];
  for (const [what, sql] of changes) {
    const copy = scratch();
    const db = new DatabaseSync(copy);
    try {
      const { changes: rows } = db.prepare(sql).run();
      assert.equal(rows, 1, `${what}: the update changed ${rows} rows, not one`);
    } finally {
      db.close();
    }
    assert.notEqual(indexDigest(copy), baseline, `changing ${what} left the digest unchanged`);
  }
});

test('deleting a row changes the digest', () => {
  for (const table of ['creature_drop', 'item_attribute', 'rashid_position']) {
    const copy = scratch(`delete from ${table} where rowid = (select min(rowid) from ${table})`);
    assert.notEqual(indexDigest(copy), baseline, `deleting a row of ${table} left the digest unchanged`);
  }
});

test('adding a table changes the digest, an empty one or one with timestamp its only column included', () => {
  // Every name here sorts after the index's own tables, so the extra table sits in the same place
  // in each copy and only its name, its columns and its rows tell the copies apart.
  const digests = [
    indexDigest(scratch("create table zz_extra (note text); insert into zz_extra values ('a row')")),
    indexDigest(scratch('create table zz_extra (note text)')),
    indexDigest(scratch('create table zz_extra ("timestamp" integer)')),
    indexDigest(scratch('create table zz_extra ("timestamp" integer); insert into zz_extra values (1)')),
    indexDigest(scratch('create table zz_other (note text)')),
  ];
  assert.equal(new Set([baseline, ...digests]).size, 6, 'two of the layouts gave the same digest');
});

test('renaming a table or a column changes the digest', () => {
  assert.notEqual(indexDigest(scratch('alter table npc_race rename to npc_races')), baseline, 'a renamed table left the digest unchanged');
  assert.notEqual(indexDigest(scratch('alter table item rename column flavor_text to flavor')), baseline,
    'a renamed column left the digest unchanged');
});

test('adding a column changes the digest, a generated one included', () => {
  const plain = scratch('alter table item add column extra text');
  const generated = scratch('alter table item add column extra text generated always as (name) virtual');
  const [column] = query(generated, "select hidden from pragma_table_xinfo('item') where name = 'extra'");
  assert.equal(column?.['hidden'], 2, 'the added column is not a virtual generated column');
  assert.notEqual(indexDigest(plain), baseline, 'a column of NULLs left the digest unchanged');
  assert.notEqual(indexDigest(generated), baseline, 'a generated column left the digest unchanged');
});

test('the same rows inserted in another order give the same digest', () => {
  const copy = rewrite('UTF-8', 'reversed');
  const first = (path: string) => query(path, 'select * from creature_drop order by rowid limit 1')[0];
  assert.notDeepEqual(first(copy), first(INDEX), 'the copy stores creature_drop in the same order');
  assert.equal(indexDigest(copy), baseline);
});

test('a copy written as UTF-16 gives the same digest', () => {
  const copy = rewrite('UTF-16le', 'same');
  assert.equal(query(copy, 'pragma encoding')[0]?.['encoding'], 'UTF-16le');
  assert.equal(indexDigest(copy), baseline);
});

test('a table declaring its columns in another order changes the digest', () => {
  const copy = scratch(`
    create table reordered (content TEXT NOT NULL, creature_id INTEGER REFERENCES creature (article_id));
    insert into reordered (content, creature_id) select content, creature_id from creature_sound;
    drop table creature_sound;
    alter table reordered rename to creature_sound;
  `);
  const count = (path: string) => query(path, 'select count(*) as count from creature_sound')[0]?.['count'];
  assert.equal(count(copy), count(INDEX));
  assert.notEqual(indexDigest(copy), baseline);
});

test("NULL, '' and x'' in the same cell give three different digests", () => {
  const cell = 'where rowid = (select min(rowid) from item)';
  const digests = (['NULL', "''", "x''"] as const).map((value) => {
    const copy = scratch(`update item set flavor_text = ${value} ${cell}`);
    const [stored] = query(copy, `select typeof(flavor_text) as type, length(flavor_text) as length from item ${cell}`);
    assert.ok(stored?.['type'] === 'null' || stored?.['length'] === 0, `${value} was stored as ${JSON.stringify(stored)}`);
    return indexDigest(copy);
  });
  assert.equal(new Set(digests).size, 3);
});

test('the command refuses a wrong argument count or an index it cannot digest, with nothing on stdout', () => {
  const missing = join(dir, 'missing.db');
  const empty = join(dir, 'empty.db');
  writeFileSync(empty, '');
  const text = join(dir, 'text.db');
  writeFileSync(text, 'rebuilt index');
  const cases: Array<[string, string[], number]> = [
    ['no argument', [], 2],
    ['two arguments', [scratch(), scratch()], 2],
    ['a missing file', [missing], 1],
    ['a zero-byte file', [empty], 1],
    ['a file that is not a database', [text], 1],
    ['an index without a version row', [scratch("delete from database_info where key = 'version'")], 1],
    ['an index without database_info', [scratch('drop table database_info')], 1],
    // NOCASE would let VERSION stand in for version. The digest compares the key with BINARY.
    ['an index whose only version key is VERSION in a NOCASE column', [scratch(`
      create table info (key TEXT NOT NULL COLLATE NOCASE PRIMARY KEY, value TEXT);
      insert into info select upper(key), value from database_info;
      drop table database_info;
      alter table info rename to database_info;
    `)], 1],
  ];
  for (const [what, args, status] of cases) {
    const run = command(...args);
    assert.equal(run.status, status, `${what}: exit ${run.status}\n${run.stderr}`);
    assert.equal(run.stdout, '', `${what}: printed ${JSON.stringify(run.stdout)}`);
    assert.notEqual(run.stderr, '', `${what}: said nothing on stderr`);
  }
  assert.equal(existsSync(missing), false, 'the command created the missing file, so it did not open it read-only');
});
