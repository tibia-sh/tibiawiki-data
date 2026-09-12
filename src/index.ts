import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the TibiaWiki index this package ships.
 *
 * Resolved from this module's own location, so it is right wherever the package is
 * installed. Consumers load the compiled `dist/index.js`, one directory below the
 * package root where `index.db` ships, so `../index.db` lands on it. The same file is
 * also exported as the `@tibia.sh/tibiawiki-data/index.db` subpath.
 */
export const DB_PATH: string = fileURLToPath(new URL('../index.db', import.meta.url));

/**
 * The enrichment schema version of the shipped index: the single row of its
 * `mcp_schema_version` table, which the server compares with its own
 * `MCP_SCHEMA_VERSION`. It is also this package's major version, so npm refuses to
 * pair a server with an index schema it cannot read.
 *
 * A literal on purpose. Read from package.json, the test that this equals the
 * package's major would compare a value with itself and could never fail, and that
 * test is the only thing stopping a release from shipping under the wrong major.
 */
export const SCHEMA_VERSION: number = 3;
