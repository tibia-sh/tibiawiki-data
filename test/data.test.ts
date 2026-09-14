/**
 * The package's contract, checked through the published server.
 *
 * `pnpm test` runs this file against this checkout. scripts/smoke.mjs copies it
 * unchanged beside an installed tarball or registry version and runs it there. The
 * same imports then land on the installed package and the installed server. So this
 * file imports only node builtins and packages by name, and reaches the server through
 * ../node_modules/.bin. A relative import would break the smoke check. A path into this
 * repository would make it quietly check this checkout instead of the artefact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
// Imported by the package's own name, so it resolves through the exports map to the
// built dist/ and its declarations - what a consumer gets - rather than to src/.
import { DB_PATH, SCHEMA_VERSION } from '@tibia.sh/tibiawiki-data';

/** The server CLI from the devDependency. The server has `bin` only, no library entry. */
const SERVER_BIN = fileURLToPath(new URL('../node_modules/.bin/tibiawiki-mcp', import.meta.url));

/** Runs one read-only query against the shipped index, naming the path if it is missing. */
function queryIndex(sql: string): Array<Record<string, unknown>> {
  assert.ok(existsSync(DB_PATH), `no index at ${DB_PATH}, so the package would ship without one`);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/**
 * The contract that matters: can the published server serve this index? It runs the
 * server's own openDb validation - every required table and column, and an exact
 * schema version match - through its public interface.
 *
 * tools/list alone proves nothing about the index. A server that cannot open its
 * index still starts and advertises every tool, then answers each call with an error.
 * Only a query that returns data separates the two.
 */
test('the published server serves the shipped index and answers a real query', async () => {
  const [info] = queryIndex("select value from database_info where key = 'generate_time'");
  assert.ok(info, 'the index has no generate_time, so its provenance cannot be checked');
  const generatedAt = String(info['value']);

  const transport = new StdioClientTransport({
    command: SERVER_BIN,
    args: ['serve'],
    // Added to the SDK's small default environment rather than to process.env, so
    // nothing from this shell or from `pnpm run` reaches the server. The path is
    // explicit because the default resolution could land on another index entirely,
    // such as the copy of this package a newer server brings in as a dependency.
    env: { TIBIAWIKI_MCP_DB: DB_PATH },
  });
  const client = new Client({ name: 'tibiawiki-data-test', version: '1.0.0' });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'tibia_get'), 'tools/list does not advertise tibia_get');

    // `type` keeps the lookup unambiguous if the wiki ever adds another page named Dragon.
    const res = await client.callTool({
      name: 'tibia_get',
      arguments: { name: 'Dragon', type: 'creature' },
    });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
      .join('\n');
    assert.notEqual(res.isError, true, `the server could not answer from the shipped index: ${text}`);

    const dragon = res.structuredContent as {
      type: string;
      title: string;
      source: { indexGeneratedAt: string };
    };
    assert.equal(dragon.type, 'creature');
    assert.equal(dragon.title, 'Dragon');
    assert.equal(dragon.source.indexGeneratedAt, generatedAt,
      'the answer came from an index other than DB_PATH');
  } finally {
    await client.close();
  }
});

/**
 * Release tooling has no way to hold a major version, so this is what stops a data
 * release from shipping under the wrong one. SCHEMA_VERSION is a literal for the same
 * reason: derived from package.json, this would compare a value with itself.
 */
test('SCHEMA_VERSION is the package major version', () => {
  // The manifest of the package under test, found through the package's own entry
  // point (dist/index.js, one level below it). The file beside this test is only the
  // same file in this checkout. Where the smoke check runs, it is the scratch consumer's.
  const manifest = new URL('../package.json', import.meta.resolve('@tibia.sh/tibiawiki-data'));
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  assert.equal(SCHEMA_VERSION, Number(version.split('.')[0]),
    `package.json is at ${version}, but SCHEMA_VERSION is ${SCHEMA_VERSION}`);
});

/**
 * SCHEMA_VERSION, and so the major version, covers only the server's enrichment tables.
 * The server also requires the tables tibiawikisql generates, and nothing versions
 * those, so an index rebuilt with another generator could ship as a 3.x that a ^3
 * server cannot read. The oldest-consumer gate, scripts/oldest-consumer.ts, installs the
 * oldest and the newest published servers that depend on ^N, each together with the packed
 * index, before every publish, and pages every item through each. That sweep covers items
 * only, not creatures, NPCs, quests or spells, so the generator the shipped index was built
 * with stays pinned here as a literal. A rebuild with any other generator fails this test
 * and cannot publish, which turns a generator change into a decision someone makes rather
 * than a side effect of the next refresh.
 */
test('the shipped index was generated by tibiawikisql 9.0.0', () => {
  const [generator] = queryIndex("select value from database_info where key = 'version'");
  assert.ok(generator, 'the index has no generator version, so what built it is unknown');
  assert.equal(generator['value'], '9.0.0',
    'the index was built by another tibiawikisql version, which no version of this package covers yet');
});

test('the shipped index carries SCHEMA_VERSION', () => {
  const rows = queryIndex('select version from mcp_schema_version');
  assert.equal(rows.length, 1, `mcp_schema_version holds ${rows.length} rows, expected exactly 1`);
  const version = Number(rows[0]!['version']);
  assert.equal(version, SCHEMA_VERSION,
    `the index is schema ${version}, but SCHEMA_VERSION is ${SCHEMA_VERSION}`);
});

/**
 * The server finds the packaged index by resolving `@tibia.sh/tibiawiki-data/index.db`.
 * Without that subpath in the exports map, Node throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * and the server never reads the packaged index. This resolves the subpath through
 * the same exports map and checks it names the file DB_PATH does.
 */
test('the ./index.db export resolves to DB_PATH', () => {
  const resolved = createRequire(import.meta.url).resolve('@tibia.sh/tibiawiki-data/index.db');
  assert.equal(resolved, DB_PATH);
});
