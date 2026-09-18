/**
 * The oldest-consumer gate for a data release: the oldest and the newest published servers
 * that depend on this package's major, each installed together with the packed candidate,
 * page every item. A server that is both is swept once.
 *
 *   pnpm oldest-consumer
 *
 * A server depends on ^N, so a user of any ^N server gets every new N.x of this package with
 * their next install. `pnpm test` checks the index against the devDependency server only, and
 * the server's every-item sweep runs in the server repository, against the data version that
 * repository locks. Nothing runs there when this package publishes. This gate checks what
 * those users run: published server packages, installed by npm beside the tarball this
 * checkout packs. The oldest ^N server has the oldest serving code that still gets a new N.x.
 * The newest is the one a fresh install gets, and newer serving code can refuse an index the
 * oldest serves, through a stricter output schema or a new required column.
 *
 * Why each choice:
 *
 *   - The consumers come from the registry's abbreviated document, which carries every
 *     version's dependencies. A response other than 200, a timeout or a document of another
 *     shape fails the gate, and none of them ever reads as a missing consumer. Both are chosen
 *     before either is installed.
 *   - Each tarball is packed into an empty directory of its own and taken from there, because
 *     `npm pack --json` prints a list in npm 11 and an object keyed by package name in npm 12.
 *   - Each consumer is packed from the registry and installed from its tarball, in a directory
 *     of its own, beside the one candidate tarball. It is first-party, so the cooldown does not
 *     apply to it, and a server published within the cooldown could not resolve under --before
 *     at all.
 *   - Everything else the install resolves waits out the cooldown pnpm-workspace.yaml sets for
 *     npm packages, through --before. No install script runs.
 *   - After the install, the consumer has to resolve the index to the candidate at the root of
 *     node_modules. Had npm nested another copy under the server, that copy is what the server
 *     would load. The check resolves the ./index.db export, because the exports map has no
 *     ./package.json.
 *   - Every child runs without the lowercase npm_* keys and without NODE_OPTIONS, for the
 *     reasons in the header of scripts/smoke.mjs. A package manager running this script
 *     exports its own config that way. Under `npm run`, npm 12.0.2 then refuses the install
 *     with EALLOWSCRIPTS, measured, and under pnpm those keys would reach the install and the
 *     server unasked.
 *   - The server runs from the installed tarball on process.execPath, with TIBIAWIKI_MCP_DB set
 *     to the installed candidate's DB_PATH, so no other index on the machine can answer.
 *   - Every step is bounded. npm pack gets 120 s and npm install 300 s, both killed with
 *     SIGKILL. The registry gets 30 s. The sweep gets 600 s, and inside it the connect and each
 *     call get 60 s. The candidate is packed once, and each of two consumers is packed, installed
 *     and swept, so the bounds add up to 2190 s. The gate jobs in ci.yml and release.yml leave
 *     room for that.
 *   - The sweep stops the server when it ends, pass or fail, and ends only once the server's
 *     process has closed, which it does after the server exits, so nothing the server writes
 *     reaches the log after the PASS or FAIL line. The MCP client ends the server's stdin, and a
 *     server still running 2 s later gets SIGTERM, then SIGKILL 2 s after that. A stop takes a
 *     little over 4 s at most, out of the room those jobs leave. A server that never started
 *     leaves nothing to wait for.
 *   - A failure names the consumer it happened in, when it happened in one. PASS names the
 *     consumers whose sweep completed, never the list chosen for it.
 *   - The scratch directory is removed when the run ends, pass or fail, and only after every
 *     server the run started has exited, so none of them is still loading from it. A signal
 *     that kills this process leaves it in the temp directory, which a CI runner discards.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = '@tibia.sh/tibiawiki-mcp';
const DATA = '@tibia.sh/tibiawiki-data';

/** One page of the sweep, as the gate records it. An error page carries no results. */
type Page = { isError: boolean; titles: string[]; totalMatches: number; indexGeneratedAt: string };

/** The part of a registry document that choosing a consumer reads. */
type Packument = { versions: Record<string, { dependencies?: Record<string, string> }> };

type Version = readonly [number, number, number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number in a version or a range: 0, or digits without a leading zero. */
const NUMBER = '(0|[1-9]\\d*)';

/** x.y.z as three numbers, or undefined for anything else, a prerelease included. */
function parseVersion(version: string): Version | undefined {
  const match = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`).exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

const compareVersions = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether `version` satisfies `range`, for the range shapes a server writes for this package:
 * ^M and ^M.m.p, each meaning >=M.m.p <(M+1).0.0. Any other shape throws rather than guess, and
 * so does a major of 0, where a caret means something narrower.
 */
export function satisfiesCaret(range: string, version: string): boolean {
  const match = new RegExp(`^\\^${NUMBER}(?:\\.${NUMBER}\\.${NUMBER})?$`).exec(range);
  if (!match || match[1] === '0') {
    throw new Error(`The range ${range} is not one the gate reads. It reads ^M and ^M.m.p, with M at least 1.`);
  }
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`${version} is not an x.y.z version.`);
  const floor: Version = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  return parsed[0] === floor[0] && compareVersions(parsed, floor) >= 0;
}

/**
 * The stable server versions that depend on this package, oldest first, with their ranges.
 * Versions compare as numbers, so 0.10.0 is newer than 0.9.0. Versions without that dependency,
 * and prereleases, are skipped. A document of another shape throws, and never reads as no
 * consumer.
 */
function dependents(packument: Packument, candidate: string): Array<{ name: string; version: Version; range: string }> {
  if (!parseVersion(candidate)) throw new Error(`The candidate version ${candidate} is not x.y.z.`);
  // Read as unknown: the document comes from the network, whatever the parameter's type says.
  const document: unknown = packument;
  const versions = isRecord(document) ? document['versions'] : undefined;
  if (!isRecord(versions) || Object.keys(versions).length === 0) {
    throw new Error(`The registry document lists no versions of ${SERVER}.`);
  }
  const found: Array<{ name: string; version: Version; range: string }> = [];
  for (const [name, manifest] of Object.entries(versions)) {
    const malformed = () => new Error(`The registry document's entry for ${SERVER}@${name} is not a package version.`);
    if (!isRecord(manifest)) throw malformed();
    const dependencies = manifest['dependencies'];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) throw malformed();
    const range = dependencies[DATA];
    if (range === undefined) continue;
    if (typeof range !== 'string') throw malformed();
    const version = parseVersion(name);
    if (version) found.push({ name, version, range });
  }
  return found.sort((a, b) => compareVersions(a.version, b.version));
}

/** Why no server is a consumer of `candidate`. */
const noConsumer = (candidate: string): Error =>
  new Error(
    `No published ${SERVER} depends on a range that ${DATA}@${candidate} satisfies. A new data major has ` +
      'no consumer yet, so it is published by hand under the schema-bump procedure, "Bumping the schema ' +
      'version" in docs/RELEASING.md.',
  );

/**
 * The oldest stable server version whose range for this package the candidate satisfies. It
 * reads the ranges from the oldest version up, and a range the gate cannot read throws when it
 * comes before the answer.
 */
export function selectOldestConsumer(packument: Packument, candidate: string): string {
  const oldest = dependents(packument, candidate).find(({ range }) => satisfiesCaret(range, candidate));
  if (oldest) return oldest.name;
  throw noConsumer(candidate);
}

/**
 * The newest stable server version whose range for this package the candidate satisfies. It
 * reads the ranges from the newest version down, and a range the gate cannot read throws when
 * it comes before the answer.
 */
export function selectNewestConsumer(packument: Packument, candidate: string): string {
  const newest = dependents(packument, candidate).findLast(({ range }) => satisfiesCaret(range, candidate));
  if (newest) return newest.name;
  throw noConsumer(candidate);
}

/** A server the gate sweeps, and the end of the candidate's consumers it was chosen from. */
type Consumer = { version: string; end: 'oldest' | 'newest' | 'oldest and newest' };

/**
 * The servers the gate sweeps for a candidate, in the order it sweeps them: the oldest
 * consumer, then the newest. When one version is both, it is swept once.
 */
export function selectConsumers(packument: Packument, candidate: string): Consumer[] {
  const oldest = selectOldestConsumer(packument, candidate);
  const newest = selectNewestConsumer(packument, candidate);
  if (newest === oldest) return [{ version: oldest, end: 'oldest and newest' }];
  return [{ version: oldest, end: 'oldest' }, { version: newest, end: 'newest' }];
}

/**
 * Runs `check` on each consumer in turn, in the order given, and returns the consumers whose
 * check completed, which are the ones the gate reports as swept. A check that throws ends the
 * loop there, with an error that names the consumer.
 */
export async function checkConsumers(
  consumers: readonly Consumer[],
  check: (consumer: Consumer) => Promise<void>,
): Promise<Consumer[]> {
  const checked: Consumer[] = [];
  for (const consumer of consumers) {
    try {
      await check(consumer);
    } catch (error) {
      throw new Error(`The ${consumer.end} consumer, ${SERVER}@${consumer.version}, failed.`, { cause: error });
    }
    checked.push(consumer);
  }
  return checked;
}

/**
 * Why a sweep failed, or undefined for a complete and clean one. `item.title` is UNIQUE in the
 * index, so every item comes back exactly once, under the index's own generate_time, when the
 * server serves them all. An error page's reason comes first, because its empty fields would
 * trip every other check.
 */
export function evaluateSweep(pages: Page[], expected: { itemCount: number; generateTime: string }): string | undefined {
  const failed = pages.findIndex((page) => page.isError);
  if (failed !== -1) return `page ${failed + 1} is an error, so the server could not serve it`;
  const stale = pages.findIndex((page) => page.indexGeneratedAt !== expected.generateTime);
  if (stale !== -1) {
    return `page ${stale + 1} came from an index generated at ${pages[stale]!.indexGeneratedAt}, ` +
      `not the candidate's ${expected.generateTime}`;
  }
  const miscounted = pages.findIndex((page) => page.totalMatches !== expected.itemCount);
  if (miscounted !== -1) {
    return `page ${miscounted + 1} reports ${pages[miscounted]!.totalMatches} matching items, ` +
      `but the index holds ${expected.itemCount}`;
  }
  const seenOn = new Map<string, number>();
  for (const [index, page] of pages.entries()) {
    for (const title of page.titles) {
      const earlier = seenOn.get(title);
      if (earlier !== undefined) return `${JSON.stringify(title)} came back on page ${earlier + 1} and again on page ${index + 1}`;
      seenOn.set(title, index);
    }
  }
  if (seenOn.size !== expected.itemCount) {
    return `the sweep returned ${seenOn.size} distinct items, but the index holds ${expected.itemCount}`;
  }
  if (seenOn.size === 0) return 'the sweep returned no items, so it checked nothing';
  return undefined;
}

const PACK_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const REGISTRY_TIMEOUT_MS = 30_000;
/** For the connect and for each call, inside the sweep's own bound. */
const CALL_TIMEOUT_MS = 60_000;
const SWEEP_TIMEOUT_MS = 600_000;

const TOOL = 'tibia_find_items';
const PAGE_SIZE = 100;
const REGISTRY_URL = `https://registry.npmjs.org/${SERVER.replace('/', '%2f')}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const log = (line: string): void => void process.stdout.write(`${line}\n`);

/** An error's message, with its cause and any stderr it carries that the message leaves out. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  if (error.cause !== undefined) parts.push(`caused by: ${describe(error.cause)}`);
  const { stderr } = error as Error & { stderr?: unknown };
  if (typeof stderr === 'string' && stderr.trim() !== '' && !error.message.includes(stderr.trim())) parts.push(stderr.trim());
  return parts.join('\n');
}

const readVersion = (dir: string): string => {
  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const version = isRecord(manifest) ? manifest['version'] : undefined;
  if (typeof version !== 'string') throw new Error(`${join(dir, 'package.json')} has no version.`);
  return version;
};

/** The cooldown pnpm-workspace.yaml sets for npm packages, so the install waits out the same one. */
function cooldownMs(): number {
  const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const minutes = Number(/^minimumReleaseAge: *(\d+)$/m.exec(workspace)?.[1]);
  if (!(minutes > 0)) throw new Error('pnpm-workspace.yaml sets no minimumReleaseAge, which the install takes its cooldown from.');
  return minutes * 60_000;
}

/** Runs npm pack into `destination`, a new directory, and returns the one tarball it wrote there. */
function pack(spec: string[], cwd: string, destination: string, env: NodeJS.ProcessEnv): string {
  mkdirSync(destination);
  const command = ['npm', 'pack', ...spec].join(' ');
  execFileSync('npm', ['pack', ...spec, '--pack-destination', destination], {
    cwd, env, encoding: 'utf8', timeout: PACK_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const written = readdirSync(destination);
  if (written.length !== 1 || !written[0]!.endsWith('.tgz')) {
    throw new Error(`${command} left ${written.join(', ') || 'nothing'} in ${destination}, not one tarball.`);
  }
  return join(destination, written[0]!);
}

export async function readRegistry(): Promise<unknown> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    // An answer over HTTP/2 has no status text.
    if (response.status !== 200) throw new Error(`The registry answered ${response.status} ${response.statusText}`.trimEnd() + '.');
    return await response.json();
  } catch (error) {
    throw new Error(`Could not read ${REGISTRY_URL}.`, { cause: error });
  }
}

/** The generate_time and item count of the index at `path`, opened read-only. */
function readIndex(path: string): { itemCount: number; generateTime: string } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const generateTime = db.prepare("select value from database_info where key = 'generate_time'").get()?.['value'];
    const itemCount = db.prepare('select count(*) as count from item').get()?.['count'];
    if (typeof generateTime !== 'string' || generateTime === '') throw new Error(`${path} has no generate_time.`);
    if (typeof itemCount !== 'number') throw new Error(`${path} gave no item count.`);
    return { itemCount, generateTime };
  } finally {
    db.close();
  }
}

/** A tool result's text, which carries the reason on an error page. */
const resultText = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .flatMap((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []))
    .join('\n');

/** One page's structured content, as the gate records it, with the cursor to the next page. */
function readPage(content: unknown, number: number): { page: Page; nextCursor: string | undefined } {
  const unreadable = () =>
    new Error(`Page ${number} of ${TOOL} is not in the shape the gate reads: ${String(JSON.stringify(content)).slice(0, 500)}`);
  if (!isRecord(content)) throw unreadable();
  const { results, totalMatches, indexGeneratedAt, nextCursor } = content;
  if (!Array.isArray(results) || typeof totalMatches !== 'number' || typeof indexGeneratedAt !== 'string') throw unreadable();
  if (nextCursor !== undefined && typeof nextCursor !== 'string') throw unreadable();
  const titles = results.map((result: unknown) => {
    if (!isRecord(result) || typeof result['title'] !== 'string') throw unreadable();
    return result['title'];
  });
  return { page: { isError: false, titles, totalMatches, indexGeneratedAt }, nextCursor };
}

/** Pages every item through the server at `entry`, serving the index at `dbPath`. */
export async function sweep(entry: string, dbPath: string, env: Record<string, string>): Promise<Page[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env: { ...env, TIBIAWIKI_MCP_DB: dbPath },
  });
  // Set before the connect, which wraps it rather than replacing it. The transport calls it when
  // the server's process closes, and a process closes only after it has exited.
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  const client = new Client({ name: 'tibiawiki-data-oldest-consumer', version: '1.0.0' });
  const budget = AbortSignal.timeout(SWEEP_TIMEOUT_MS);
  const options = { timeout: CALL_TIMEOUT_MS, signal: budget };
  const pages: Page[] = [];
  let server: number | null = null;
  try {
    const connected = client.connect(transport, options);
    // The connect starts the server before its first wait, and a server that failed to start has
    // no pid. Read later, a failed connect has already cleared it.
    server = transport.pid;
    await connected;
    let cursor: string | undefined;
    do {
      const result = await client.callTool(
        { name: TOOL, arguments: { limit: PAGE_SIZE, include_inactive: true, ...(cursor === undefined ? {} : { cursor }) } },
        options,
      );
      if (result.isError === true) {
        pages.push({ isError: true, titles: [], totalMatches: 0, indexGeneratedAt: '' });
        log(`page ${pages.length}: ${TOOL} answered with an error: ${resultText(result.content)}`);
        break;
      }
      const { page, nextCursor } = readPage(result.structuredContent, pages.length + 1);
      pages.push(page);
      cursor = nextCursor;
    } while (cursor !== undefined);
    return pages;
  } catch (error) {
    if (budget.aborted) throw new Error(`The sweep did not finish within ${SWEEP_TIMEOUT_MS / 1000} s, after ${pages.length} pages.`, { cause: error });
    throw error;
  } finally {
    // Ends the server's stdin, then sends SIGTERM and SIGKILL to a server still running, but does
    // not wait for the exit that SIGKILL brings. When the client has started that close itself,
    // as a failed connect does, this call returns at once. So the sweep waits for the process to
    // close, unless no server ever started.
    await client.close();
    if (server !== null) await closed;
  }
}

/** The dist.integrity the registry document gives for `consumer`. */
function integrityOf(document: unknown, consumer: string): string {
  const versions = isRecord(document) ? document['versions'] : undefined;
  const manifest = isRecord(versions) ? versions[consumer] : undefined;
  const dist = isRecord(manifest) ? manifest['dist'] : undefined;
  const integrity = isRecord(dist) ? dist['integrity'] : undefined;
  if (typeof integrity !== 'string') throw new Error(`The registry document gives no dist.integrity for ${SERVER}@${consumer}.`);
  return integrity;
}

/** Runs the gate in `scratch` and returns what passed. Any failure throws. */
async function gate(scratch: string, startedAt: number): Promise<string> {
  // A consumer's shell carries none of this repository's package-manager config, and nothing
  // may inject node flags into the server. NPM_CONFIG_* are the operator's own, and stay.
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || key.startsWith('npm_') || key === 'NODE_OPTIONS' ? [] : [[key, value] as const]),
  );

  const candidate = readVersion(ROOT);
  const candidateTarball = pack([], ROOT, join(scratch, 'candidate'), env);
  log(`candidate: ${DATA}@${candidate}`);

  const document = await readRegistry();
  const consumers = selectConsumers(document as Packument, candidate);
  for (const { version, end } of consumers) {
    const which = end === 'oldest and newest'
      ? `both the oldest and the newest published server whose range ${candidate} satisfies, so it is swept once`
      : `the ${end} published server whose range ${candidate} satisfies`;
    log(`${end} consumer: ${SERVER}@${version}, ${which}`);
    log(`${end} consumer integrity: ${integrityOf(document, version)}`);
  }

  const before = new Date(startedAt - cooldownMs()).toISOString();
  const swept = await checkConsumers(consumers, async ({ version, end }) => {
    log(`\nsweeping the ${end} consumer, ${SERVER}@${version}`);
    await checkConsumer({ consumer: version, dir: join(scratch, version), candidate, candidateTarball, before, env });
  });
  return `${swept.map(({ version }) => `${SERVER}@${version}`).join(' and ')} served every item of ${DATA}@${candidate}`;
}

/**
 * Installs `consumer` from the registry together with the candidate tarball, in `dir`, a new
 * directory, checks what npm installed, and pages every item through it. Any failure throws.
 */
async function checkConsumer({ consumer, dir, candidate, candidateTarball, before, env }: {
  consumer: string;
  dir: string;
  candidate: string;
  candidateTarball: string;
  before: string;
  env: Record<string, string>;
}): Promise<void> {
  mkdirSync(dir);
  const consumerTarball = pack([`${SERVER}@${consumer}`], dir, join(dir, 'consumer'), env);

  const install = join(dir, 'install');
  mkdirSync(install);
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'oldest-consumer-gate', private: true }));
  log(`installing both tarballs with npm, the rest resolved --before=${before}`);
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`, consumerTarball, candidateTarball], {
    cwd: install, env, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const consumerDir = join(install, 'node_modules', SERVER);
  const candidateDir = join(install, 'node_modules', DATA);
  const installedConsumer = readVersion(consumerDir);
  if (installedConsumer !== consumer) throw new Error(`npm installed ${SERVER}@${installedConsumer}, not ${consumer}.`);
  const consumerIndex = createRequire(join(consumerDir, 'package.json')).resolve(`${DATA}/index.db`);
  if (consumerIndex !== join(candidateDir, 'index.db')) {
    throw new Error(`${SERVER}@${consumer} resolves ${DATA}/index.db to ${consumerIndex}, not to the candidate in ${candidateDir}.`);
  }
  const installedCandidate = readVersion(candidateDir);
  if (installedCandidate !== candidate) throw new Error(`${candidateDir} holds ${DATA}@${installedCandidate}, not the candidate ${candidate}.`);

  const candidateModule: unknown = await import(pathToFileURL(createRequire(join(install, 'package.json')).resolve(DATA)).href);
  const dbPath = isRecord(candidateModule) ? candidateModule['DB_PATH'] : undefined;
  if (dbPath !== consumerIndex) throw new Error(`The installed candidate's DB_PATH is ${String(dbPath)}, not the index the consumer resolves, ${consumerIndex}.`);
  const expected = readIndex(dbPath);
  log(`index: generate_time ${expected.generateTime}, items ${expected.itemCount}`);

  const pages = await sweep(join(consumerDir, 'dist', 'index.js'), dbPath, env);
  const items = pages.reduce((sum, page) => sum + page.titles.length, 0);
  log(`swept: pages ${pages.length}, items ${items}`);
  const reason = evaluateSweep(pages, expected);
  if (reason !== undefined) throw new Error(reason);
}

if (import.meta.main) {
  const startedAt = Date.now();
  const seconds = (): string => ((Date.now() - startedAt) / 1000).toFixed(1);
  // Real path, so every path the checks compare is one createRequire would return.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tibiawiki-data-oldest-consumer-')));
  try {
    const passed = await gate(scratch, startedAt);
    log(`\nPASS  ${passed}, in ${seconds()} s`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`\nFAIL  after ${seconds()} s\n${describe(error)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
