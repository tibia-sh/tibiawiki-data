/**
 * Rebuilds this package's index.db with the published server's own `build-index`.
 *
 *   pnpm build-index
 *
 * The server decides whether a build is good enough. Its build-index gates coverage,
 * parse failures, image resolution and spell shapes, validates the new index, and only
 * then renames it over the target, so a build that fails a gate leaves index.db as it
 * was. None of those thresholds is repeated here. They are defined and tested in the
 * server, and a copy would be a second source of truth that drifts from it.
 *
 * What this script adds is the one thing the server cannot know: which file is this
 * package's index. It passes DB_PATH, the path the package itself exports, so the build
 * writes exactly the file that ships. It runs the devDependency's binary, the version
 * the lockfile pins, rather than a floating `npx`. It also gives the generator's PyPI
 * dependencies a cooldown, PYPI_COOLDOWN below.
 *
 * DB_PATH is imported by the package's own name, which resolves to the built dist/, so
 * `pnpm build-index` builds first.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';

/** The server CLI from the devDependency. The server has `bin` only, no library entry. */
const SERVER_BIN = fileURLToPath(new URL('../node_modules/.bin/tibiawiki-mcp', import.meta.url));

/**
 * uvx resolves the generator's unpinned PyPI dependencies afresh on every build, so a
 * release waits out the same 7 days pnpm-workspace.yaml gives npm packages. It reaches uv
 * as UV_EXCLUDE_NEWER, and a UV_EXCLUDE_NEWER already in the environment wins.
 */
const PYPI_COOLDOWN = '7 days';

// The environment passes through and wins over the cooldown default: build-index shells
// out to `uvx`, which needs PATH, its cache under HOME, and any proxy settings to reach
// TibiaWiki.
const result = spawnSync(SERVER_BIN, ['build-index'], {
  stdio: 'inherit',
  env: { UV_EXCLUDE_NEWER: PYPI_COOLDOWN, ...process.env, TIBIAWIKI_MCP_DB: DB_PATH },
});

if (result.error) {
  // The binary itself could not start, so the devDependency is missing. A missing
  // `uvx` does not land here: build-index runs and reports that itself.
  process.stderr.write(
    `Could not run ${SERVER_BIN}: ${result.error.message}\n` +
      'Install the devDependencies with `pnpm install --frozen-lockfile`.\n',
  );
  process.exitCode = 1;
} else if (result.status !== 0) {
  // build-index has already printed its reason. This line only makes the exit loud.
  const how = result.signal === null ? `exit ${result.status}` : `signal ${result.signal}`;
  process.stderr.write(`build-index failed (${how}).\n`);
  process.exitCode = result.status ?? 1;
}
