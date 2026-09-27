/**
 * Which server the drift job builds the index with.
 *
 *   node scripts/server-pin.ts <current> <latest> [<requested>]
 *
 * prints `<action> <target>` on one line: keep, move or refuse, and the server version the run
 * builds with. The drift workflow's build job runs it with the version package.json pins, the
 * version npm lists as latest, and the version a server-release dispatch asks for, when it came
 * from one. Its pr job runs it again, with the pin of main as both current and latest and the
 * server the build job handed on as requested, to check that server is not below the pin.
 *
 * A requested version wins, since tibiawiki-mcp's release workflow sends it once npm accepted
 * that publish, and npm can still list an older latest for a moment. It never moves the pin
 * down: a requested version below the pin, such as one from a dispatch that arrived late, is
 * refused, and the run builds with the pin as it is. Without one, the pin moves to latest when
 * latest is above it, so a scheduled run picks up a release whose dispatch was lost.
 *
 * Every version is x.y.z, checked whole, and compared number by number. decidePin throws on
 * anything else, and the command then exits 1 and prints nothing.
 */

export type PinAction = 'keep' | 'move' | 'refuse';

const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

/** The three numbers of an x.y.z version, as bigints so no length of digits loses precision. */
function parse(version: string): [bigint, bigint, bigint] {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`${JSON.stringify(version)} is not an x.y.z version.`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

/** Negative when a is below b, 0 when they are equal, positive when a is above b. */
function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) {
    if (x[index]! !== y[index]!) return x[index]! < y[index]! ? -1 : 1;
  }
  return 0;
}

/**
 * What the drift run does with the pin at `current`: move it to a `requested` version above it,
 * refuse a `requested` version below it, or, without a request, move it to a `latest` above it.
 * Anything else keeps it. `target` is the server the run builds with.
 */
export function decidePin(current: string, requested: string | null, latest: string): { target: string; action: PinAction } {
  // Every version is checked, the ones this decision does not read included.
  compare(current, latest);
  if (requested !== null) {
    const order = compare(requested, current);
    if (order < 0) return { target: current, action: 'refuse' };
    return order > 0 ? { target: requested, action: 'move' } : { target: current, action: 'keep' };
  }
  return compare(latest, current) > 0 ? { target: latest, action: 'move' } : { target: current, action: 'keep' };
}

const USAGE = 'Usage: node scripts/server-pin.ts <current> <latest> [<requested>]\n';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 3) {
    process.exitCode = 2;
    process.stderr.write(USAGE);
  } else {
    try {
      const { target, action } = decidePin(args[0]!, args[2] ?? null, args[1]!);
      process.stdout.write(`${action} ${target}\n`);
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
