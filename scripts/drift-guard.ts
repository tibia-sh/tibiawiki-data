/**
 * Whether a refreshed index can merge by itself, from the row counts of the committed index and
 * the rebuilt one.
 *
 *   node scripts/drift-guard.ts <committed.db> <rebuilt.db>
 *
 * The drift workflow's build job runs this and reads each line it prints as a reason to hold the
 * refresh for a person. No output means go. The build, `pnpm test` and `oldest-consumer` already
 * catch a broken index. They do not catch a bad week on the wiki: mass deletion, vandalism, or a
 * parser change that silently drops pages. Those show up as rows that are gone, so a refresh holds
 * when:
 *
 *   - one of the main tables lost more than 1% of its committed rows. Deletions of real pages are
 *     rare, so 1% is far above a normal week. A main table with no committed rows has no share to
 *     lose, so it never holds on this.
 *   - a table of the committed index is missing from the rebuilt one.
 *   - a table that had rows in the committed index has none.
 *
 * Growth never holds, and a table that is only in the rebuilt index is growth. A table gets one
 * reason at most, the first of missing, empty and the loss that applies, so a main table that
 * empties reads as empty rather than also as 100% lost.
 *
 * The main tables and their order are the release notes' fixed tables, imported from
 * scripts/release-notes.ts along with readSnapshot, so both scripts read the index the same way.
 * Like that file, this one imports node builtins and the repository's own scripts only, and runs
 * under plain `node`. Counts use the en-US thousands separator, as the release notes do.
 *
 * holdReasons is pure, and test/drift-guard.test.ts pins its reasons word for word.
 */
import { FIXED_TABLES, readSnapshot } from './release-notes.ts';

const count = (rows: number): string => rows.toLocaleString('en-US');

/**
 * The reasons to hold the refresh, main tables first in their fixed order, then the other tables
 * by name. An empty array means go. Only tables of the committed index are looked at, through
 * their own keys, so a table named constructor is a count like any other.
 */
export function holdReasons(committed: Record<string, number>, rebuilt: Record<string, number>): string[] {
  const names = Object.keys(committed);
  const ordered = [
    ...FIXED_TABLES.filter((name) => Object.hasOwn(committed, name)),
    ...names.filter((name) => !FIXED_TABLES.includes(name)).sort(),
  ];
  const reasons: string[] = [];
  for (const name of ordered) {
    const before = committed[name]!;
    if (!Object.hasOwn(rebuilt, name)) {
      reasons.push(`table ${name} is missing`);
      continue;
    }
    const after = rebuilt[name]!;
    const lost = before - after;
    if (before > 0 && after === 0) {
      reasons.push(`table ${name} is empty, it had ${count(before)} rows`);
    } else if (FIXED_TABLES.includes(name) && lost * 100 > before) {
      // In whole numbers, so exactly 1% is never read as a hair over it.
      reasons.push(`${name} lost ${count(lost)} of ${count(before)} rows (${((lost / before) * 100).toFixed(1)}%)`);
    }
  }
  return reasons;
}

const USAGE = 'Usage: node scripts/drift-guard.ts <committed.db> <rebuilt.db>\n';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.exitCode = 2;
    process.stderr.write(USAGE);
  } else {
    try {
      const reasons = holdReasons(readSnapshot(args[0]!).rows, readSnapshot(args[1]!).rows);
      for (const reason of reasons) process.stdout.write(`${reason}\n`);
    } catch (error) {
      // The reason is a sentence the job log shows, rather than a stack trace over a missing file.
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
