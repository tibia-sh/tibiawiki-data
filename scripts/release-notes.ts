/**
 * The notes for a GitHub release of this package, generated from the index itself.
 *
 *   node scripts/release-notes.ts <version> <index.db> [<previous-version> <previous-index.db>]
 *   git tag --list 'v*' | node scripts/release-notes.ts --previous-tag <version>
 *
 * The release workflow runs both modes in the job that holds write access to the repository.
 * That job installs nothing, so this file imports node builtins only and runs under plain
 * `node` on a bare checkout. It never sees the token either, which is why the tag mode reads
 * tag names from stdin rather than calling `git` or the API itself.
 *
 * What the notes say, and why:
 *
 *   - The first sentence is the provenance the index carries: when tibiawiki-sql took the
 *     snapshot, and which tibiawiki-sql took it. A release of this package is a release of
 *     that snapshot, so it comes first.
 *   - The second paragraph is the install line and the npm page, because a reader who
 *     landed on the release page wants the package, not the tag.
 *   - The table is what changed. The eight tables a reader looks for are always listed, in
 *     the order below, so the same rows sit in the same places on every release page. After
 *     them come the other tables whose count moved, which is where a generator change or a
 *     new wiki section shows up. A table that exists on one side only counts as 0 on the
 *     other, so its whole count reads as the change.
 *   - Two releases can carry the same index, when the release changed the package and not
 *     the data. The generate_time says so, and then the notes say so in a sentence instead
 *     of printing a table of zeros.
 *   - Counts are formatted with the en-US locale, named explicitly rather than taken from
 *     the runner's, so the separator is a comma wherever the workflow runs.
 *
 * Only readSnapshot and the command touch the outside. previousTag and renderNotes are pure,
 * and test/release-notes.test.ts pins their output character for character.
 *
 * The version parsing below is the same shape as in scripts/oldest-consumer.ts rather than an
 * import from it, because that file imports the MCP client and this one may import builtins
 * only.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PACKAGE = '@tibia.sh/tibiawiki-data';
const WIKI = 'https://tibia.fandom.com';

/** The tables every release page lists, in this order, whether or not their count moved. */
const FIXED_TABLES: readonly string[] = ['item', 'creature', 'npc', 'book', 'house', 'achievement', 'quest', 'spell'];

/** A number in a version: 0, or digits without a leading zero. */
const NUMBER = '(0|[1-9]\\d*)';

type Version = readonly [number, number, number];

/** x.y.z as three numbers, or undefined for anything else, a prerelease included. */
function parseVersion(version: string): Version | undefined {
  const match = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`).exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

const compareVersions = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The release before `version`: the highest tag of the exact form vX.Y.Z whose version is
 * below it, compared number by number, so v3.0.10 comes above v3.0.9. Tags of any other
 * shape are not this package's releases and are ignored. Nothing below the version gives
 * undefined, which is a first release rather than a failure.
 */
export function previousTag(tags: string[], version: string): string | undefined {
  const current = parseVersion(version);
  if (!current) throw new Error(`${version} is not an x.y.z version.`);
  let highest: { tag: string; version: Version } | undefined;
  for (const tag of tags) {
    const parsed = tag.startsWith('v') ? parseVersion(tag.slice(1)) : undefined;
    if (!parsed || compareVersions(parsed, current) >= 0) continue;
    if (!highest || compareVersions(parsed, highest.version) > 0) highest = { tag, version: parsed };
  }
  return highest?.tag;
}

/** An index as the notes read it: its provenance, and the row count of each of its tables. */
export type Snapshot = { generateTime: string; generator: string; rows: Record<string, number> };

/**
 * Reads the index at `dbPath`, opened read-only. An index without a generate_time or without
 * the generator version has no provenance to report, so it throws rather than print a gap.
 * Only sqlite_master entries of type 'table' are counted, because the index also holds over a
 * hundred entries that are its indexes, and the sqlite_ names are SQLite's own bookkeeping.
 * Each name is interpolated into the count only after sqlite_master gave it, quoted as an
 * identifier.
 */
export function readSnapshot(dbPath: string): Snapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const info = (key: string): string => {
      const value = db.prepare('select value from database_info where key = ?').get(key)?.['value'];
      if (typeof value !== 'string' || value === '') throw new Error(`${dbPath} has no ${key}.`);
      return value;
    };
    const generateTime = info('generate_time');
    const generator = info('version');
    const names = db.prepare("select name from sqlite_master where type = 'table'").all()
      .map((row) => row['name'])
      .filter((name): name is string => typeof name === 'string' && !name.startsWith('sqlite_'))
      .sort();
    const rows: Record<string, number> = {};
    for (const name of names) {
      const counted = db.prepare(`select count(*) as count from "${name.replaceAll('"', '""')}"`).get()?.['count'];
      if (typeof counted !== 'number') throw new Error(`${dbPath} gave no row count for ${name}.`);
      rows[name] = counted;
    }
    return { generateTime, generator, rows };
  } finally {
    db.close();
  }
}

const count = (rows: number): string => rows.toLocaleString('en-US');

const change = (delta: number): string => (delta > 0 ? `+${count(delta)}` : delta < 0 ? `-${count(-delta)}` : '0');

/** The fixed tables, then every other table whose count moved, by name. A missing table is 0. */
function tableNames(current: Snapshot, previous: Snapshot): string[] {
  const others = new Set([...Object.keys(current.rows), ...Object.keys(previous.rows)]);
  const moved = [...others].sort()
    .filter((name) => !FIXED_TABLES.includes(name) && (current.rows[name] ?? 0) !== (previous.rows[name] ?? 0));
  return [...FIXED_TABLES, ...moved];
}

/** The markdown of a release, ending in one newline. */
export function renderNotes(version: string, current: Snapshot, previous?: { version: string; snapshot: Snapshot }): string {
  const sameSnapshot = previous !== undefined && previous.snapshot.generateTime === current.generateTime;
  const snapshot = `A snapshot of [TibiaWiki](${WIKI}) taken at \`${current.generateTime}\` by tibiawiki-sql \`${current.generator}\`.`;
  const lines = [
    sameSnapshot ? `${snapshot} It is the same snapshot as in \`${previous.version}\`.` : snapshot,
    '',
    `Install it with \`npm install ${PACKAGE}@${version}\`. It is on npm as ` +
      `[\`${PACKAGE}@${version}\`](https://www.npmjs.com/package/${PACKAGE}/v/${version}).`,
  ];
  if (previous === undefined) {
    lines.push('', '| Table | Rows |', '|---|---|');
    for (const name of FIXED_TABLES) lines.push(`| \`${name}\` | ${count(current.rows[name] ?? 0)} |`);
  } else if (!sameSnapshot) {
    lines.push('', `| Table | Rows | Change since \`${previous.version}\` |`, '|---|---|---|');
    for (const name of tableNames(current, previous.snapshot)) {
      const rows = current.rows[name] ?? 0;
      lines.push(`| \`${name}\` | ${count(rows)} | ${change(rows - (previous.snapshot.rows[name] ?? 0))} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const USAGE =
  'Usage: node scripts/release-notes.ts <version> <index.db> [<previous-version> <previous-index.db>]\n' +
  '       node scripts/release-notes.ts --previous-tag <version>, with the tag names on stdin\n';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tagMode = args[0] === '--previous-tag';
  if (tagMode ? args.length !== 2 : args.length !== 2 && args.length !== 4) {
    process.exitCode = 2;
    process.stderr.write(USAGE);
  } else {
    try {
      if (tagMode) {
        const tags = readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '');
        const tag = previousTag(tags, args[1]!);
        if (tag !== undefined) process.stdout.write(`${tag}\n`);
      } else {
        const previous = args.length === 4 ? { version: args[2]!, snapshot: readSnapshot(args[3]!) } : undefined;
        process.stdout.write(renderNotes(args[0]!, readSnapshot(args[1]!), previous));
      }
    } catch (error) {
      // The reason is a sentence the job log shows, rather than a stack trace over a missing file.
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
