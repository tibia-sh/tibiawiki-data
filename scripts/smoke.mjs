#!/usr/bin/env node
/**
 * Consumer smoke check for a data release: install the package the way a user would,
 * and serve its index.
 *
 *   pnpm smoke ./tibia.sh-tibiawiki-data-3.0.0.tgz   a local `npm pack` tarball, pre-publish
 *   pnpm smoke @tibia.sh/tibiawiki-data@3.0.0        the published artefact, post-publish
 *
 * Installs the package under test into a throwaway directory, together with the
 * server and the MCP client, then runs this repository's test/data.test.ts there.
 * Inside the scratch directory that file imports the INSTALLED package and spawns the
 * INSTALLED server binary, so every check lands on the artefact, not on this checkout:
 *
 *   - the installed server, with TIBIAWIKI_MCP_DB set to the installed DB_PATH,
 *     completes initialize and tools/list and answers a real query.
 *   - the answer's indexGeneratedAt equals that index's generate_time. An answer whose
 *     indexGeneratedAt differs from that generate_time fails.
 *   - SCHEMA_VERSION, the installed manifest's major and the index's
 *     mcp_schema_version row agree.
 *   - the ./index.db subpath, which the server's locator resolves, names DB_PATH.
 *
 * Why each choice:
 *
 *   - It runs the test file itself, not a copy of its checks, so `pnpm test` and this
 *     check cannot drift apart. The test file's header states what that requires of it.
 *   - The server and client versions are read from package.json's devDependencies. The
 *     artefact is checked against the same server `pnpm test` uses, and a devDependency
 *     bump moves both checks at once.
 *   - It installs @modelcontextprotocol/client explicitly: it is a devDependency of
 *     the server, so it is NOT available transitively from the installed server.
 *   - It strips the lowercase npm_* keys from the child environment. A package manager
 *     or npx running a script can export its own config that way, and npm rejects some
 *     of it outright (EALLOWSCRIPTS) while silently applying the rest to an install meant
 *     to look like a stranger's. Case is load-bearing: npm reads NPM_CONFIG_* too, and
 *     those are the operator's own registry, proxy and CA settings, which a real consumer
 *     would have. NODE_OPTIONS goes with them, because it can filter every test away
 *     silently.
 *   - Both steps time out and kill with SIGKILL, so a child that ignores SIGTERM cannot
 *     hold the check open past the bound. Only that child is killed. The test file that
 *     `node --test` runs in a process of its own survives it.
 *   - The scratch directory is removed on every exit path: pass, fail, a timeout, and a
 *     Ctrl-C. A Ctrl-C signals the whole process group, which kills the running step, so
 *     the check fails and cleans up like any other failure. A signal sent to this
 *     process alone interrupts nothing: every step blocks in execFileSync, so the
 *     handlers below never run, and the check carries on to its normal end.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per step. Generous: the install downloads the index, and a hang is what it catches. */
const TIMEOUT_MS = 300_000;

/** Installed beside the package under test, at the versions package.json pins for `pnpm test`. */
const COMPANIONS = ['@tibia.sh/tibiawiki-mcp', '@modelcontextprotocol/client'];

const CHECK = fileURLToPath(new URL('../test/data.test.ts', import.meta.url));

const spec = process.argv[2];
if (!spec) {
  process.stderr.write('usage: node scripts/smoke.mjs <tarball-path|package@version>\n');
  process.exit(2);
}
// npm runs inside the scratch directory, so a local tarball path is resolved here first.
const target = spec.endsWith('.tgz') ? resolve(spec) : spec;

/** @type {{ devDependencies?: Record<string, string> }} */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const companions = COMPANIONS.map((name) => {
  const range = manifest.devDependencies?.[name];
  if (!range) throw new Error(`package.json has no devDependency on ${name}, which the check needs`);
  return `${name}@${range}`;
});

// A consumer's shell carries none of this repository's package-manager config, and
// nothing may inject node flags into the check. Measured on node 24.19.0: an inherited
// NODE_OPTIONS=--test-name-pattern=<anything unmatched> runs none of the four tests and
// still exits 0, which would print PASS for an index that was never queried.
const CONSUMER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_') && key !== 'NODE_OPTIONS'),
);

/** npm's stderr carries why an install failed; `message` alone says just "exited 1". The
 * check's own reasons have already streamed through, so there its message is enough. */
/** @type {(error: unknown) => string} */
const detail = (error) => {
  if (!(error instanceof Error)) return String(error);
  const { stderr } = /** @type {Error & { stderr?: string | null }} */ (error);
  return stderr || error.message;
};

const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-smoke-'));
let failed = false;

const clean = () => rmSync(dir, { recursive: true, force: true });
// Without these, SIGINT or SIGTERM would end this process on the spot and leave the
// scratch install, about 20 MB, behind. With them the signal waits for the step running
// in execFileSync, so neither body ever runs. A Ctrl-C has killed that step as well, so
// it fails, and the finally block below removes the directory.
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) {
  process.on(signal, () => {
    clean();
    process.exit(code);
  });
}

try {
  process.stderr.write(`scratch: ${dir}\ninstalling ${target} with ${companions.join(', ')}\n`);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2),
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', target, ...companions], {
    cwd: dir, env: CONSUMER_ENV, encoding: 'utf8', timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  mkdirSync(join(dir, 'test'));
  copyFileSync(CHECK, join(dir, 'test', 'data.test.ts'));
  // The test reporter writes each failure's reason to stdout, so the check's output
  // streams straight through rather than being captured.
  execFileSync(process.execPath, ['--test', 'test/data.test.ts'], {
    cwd: dir, env: CONSUMER_ENV, timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.stdout.write(`\nPASS  ${target}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`\nFAIL  ${target}\n${detail(error)}\n`);
} finally {
  // Cleanup on every exit path, pass or fail.
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
