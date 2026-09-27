/**
 * The tables and columns a rebuilt index added or removed, compared with the committed index.
 *
 *   node scripts/schema-diff.ts <committed.db> <rebuilt.db>
 *
 * prints `{"added":[...],"removed":[...]}` on one line. An entry is a table, when the whole table
 * is new or gone, or `table.column`, for a column of a table both indexes have. Each list is
 * sorted.
 *
 * The drift workflow's build job reads it twice. A refresh that added anything ships as a minor,
 * since only a server that reads the new table or column can use it, and otherwise as a patch.
 * And scripts/drift-guard.ts holds a refresh that removed anything for a person, since a published
 * `^N` server can require what is gone. Growth never holds.
 *
 * Every table counts but SQLite's own sqlite_ tables, as scripts/release-notes.ts reads them, and
 * every column pragma table_xinfo lists, hidden and generated ones included. Like that file, this
 * one imports node builtins only and runs under plain `node`. The command exits 1, printing
 * nothing on stdout, when it cannot read an index.
 */
import { DatabaseSync } from 'node:sqlite';

/** Every table of the index at `db`, by name, to its column names in their order. */
export function schemaOf(db: string): Map<string, string[]> {
  const index = new DatabaseSync(db, { readOnly: true });
  try {
    const names = index.prepare("select name from sqlite_master where type = 'table' order by name").all()
      .map((row) => row['name'])
      .filter((name): name is string => typeof name === 'string' && !name.startsWith('sqlite_'));
    const columns = index.prepare('select name from pragma_table_xinfo(?) order by cid');
    return new Map(names.map((name) => [name, columns.all(name).map((row) => String(row['name']))]));
  } finally {
    index.close();
  }
}

/** The tables and columns only `rebuilt` has, and those only `committed` has, each sorted. */
export function compareSchemas(committed: Map<string, string[]>, rebuilt: Map<string, string[]>): { added: string[]; removed: string[] } {
  const only = (from: Map<string, string[]>, other: Map<string, string[]>): string[] =>
    [...from].flatMap(([table, columns]) => {
      const kept = other.get(table);
      if (kept === undefined) return [table];
      return columns.filter((column) => !kept.includes(column)).map((column) => `${table}.${column}`);
    }).sort();
  return { added: only(rebuilt, committed), removed: only(committed, rebuilt) };
}

const USAGE = 'Usage: node scripts/schema-diff.ts <committed.db> <rebuilt.db>\n';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.exitCode = 2;
    process.stderr.write(USAGE);
  } else {
    try {
      process.stdout.write(`${JSON.stringify(compareSchemas(schemaOf(args[0]!), schemaOf(args[1]!)))}\n`);
    } catch (error) {
      // The reason is a sentence the job log shows, rather than a stack trace over a missing file.
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
