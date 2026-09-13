import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runStep } from './workflow.ts';

/**
 * scripts/build.ts starts the published server's build-index, which crawls the wiki. These
 * run a copy of it instead, beside a stand-in server that records what it was started with
 * and a stand-in for this package's own module, so nothing is built, crawled or fetched.
 */

const SOURCE = readFileSync(new URL('../scripts/build.ts', import.meta.url), 'utf8');

/** The DB_PATH the stand-in module exports. */
const STAND_IN_DB = '/stand-in/index.db';

/** Runs the copy with `env` over the test's own environment, and returns what the stand-in server got. */
function build(env: NodeJS.ProcessEnv) {
  const run = runStep('node scripts/build.ts\n', {
    files: {
      'package.json': JSON.stringify({ name: '@tibia.sh/tibiawiki-data', type: 'module', exports: { '.': './dist/index.js' } }),
      'dist/index.js': `export const DB_PATH = ${JSON.stringify(STAND_IN_DB)};\n`,
      'scripts/build.ts': SOURCE,
    },
    commands: {
      'node_modules/.bin/tibiawiki-mcp':
        "require('node:fs').writeFileSync('server-env.json', JSON.stringify({\n" +
        '  UV_EXCLUDE_NEWER: process.env.UV_EXCLUDE_NEWER ?? null,\n' +
        '  TIBIAWIKI_MCP_DB: process.env.TIBIAWIKI_MCP_DB ?? null,\n' +
        '}));\n',
    },
    env,
  });
  assert.equal(run.status, 0, run.log);
  const server = run.checkout['server-env.json'];
  assert.ok(server !== undefined, `the stand-in server never ran\n${run.log}`);
  return {
    calls: run.calls,
    server: JSON.parse(server) as { UV_EXCLUDE_NEWER: string | null; TIBIAWIKI_MCP_DB: string | null },
  };
}

test('every build gives the generator the PyPI cooldown pnpm gives npm packages', () => {
  // uvx resolves the generator's unpinned dependencies afresh on every build, and reads a
  // relative duration from UV_EXCLUDE_NEWER. minimumReleaseAge in pnpm-workspace.yaml is
  // this repository's cooldown, in minutes.
  const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const minutes = Number(/^minimumReleaseAge: *(\d+)$/m.exec(workspace)?.[1]);
  assert.ok(minutes > 0, 'pnpm-workspace.yaml sets no minimumReleaseAge');

  const { calls, server } = build({ UV_EXCLUDE_NEWER: undefined });
  assert.deepEqual(calls, [{ command: 'node_modules/.bin/tibiawiki-mcp', args: ['build-index'] }]);
  assert.equal(server.TIBIAWIKI_MCP_DB, STAND_IN_DB, 'build-index does not write the index the package exports');
  const value = server.UV_EXCLUDE_NEWER;
  assert.notEqual(value, null, 'build-index gets no UV_EXCLUDE_NEWER');
  const duration = /^(\d+) *(days?|weeks?)$/.exec(value!) ?? /^P(\d+)([DW])$/.exec(value!);
  assert.ok(duration, `UV_EXCLUDE_NEWER is ${value}, not a duration in days or weeks`);
  const days = Number(duration[1]) * (/^w/i.test(duration[2]!) ? 7 : 1);
  assert.equal(days * 24 * 60, minutes, `UV_EXCLUDE_NEWER is ${days} days, but minimumReleaseAge is ${minutes} minutes`);
});

test('a UV_EXCLUDE_NEWER set in the environment wins over the build default', () => {
  // `false` is how uv turns exclude-newer off.
  for (const value of ['3 days', 'false']) {
    assert.equal(build({ UV_EXCLUDE_NEWER: value }).server.UV_EXCLUDE_NEWER, value);
  }
});
