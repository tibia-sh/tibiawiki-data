/**
 * The digest of an index's content, which the drift workflow compares across a rebuild.
 *
 *   node scripts/index-digest.ts <index.db>
 *
 * It prints one line, a lowercase SHA-256 hex digest, and nothing else. The drift job digests
 * the committed index.db and the rebuilt one, and a refresh opens only when the two differ. So
 * the digest covers what this package publishes, the whole index, and leaves out only what
 * changes without the content changing:
 *
 *   - the column named timestamp, which the generator gives every row of the main tables. It is
 *     the wiki page's last-edit time. An edit that changes nothing the generator extracts still
 *     moves it, and is no reason to publish.
 *   - every database_info row but version. The version is the generator's, and decides what rows
 *     the wiki becomes. The other keys stamp the run, such as generate_time, or the build host,
 *     such as python_version. It is an allowlist, because a denylist would have to know every
 *     stamp in advance, and the next one a generator adds would open a refresh on every run.
 *
 * Everything else counts: every table in sqlite_master of type table, but SQLite's own sqlite_
 * ones, and every column pragma table_xinfo lists, generated and hidden ones included. An index
 * with no table, or without the version row, is refused, since SQLite opens a zero-byte file as
 * an empty database and its digest would compare like any other.
 *
 * The encoding is the one the server's index-digest used at 0.10.0. A value is its storage
 * class in 1 byte, its payload length in 4 bytes and the payload: an integer's two's complement
 * or a real's IEEE 754 in 8 bytes, text as UTF-8, a blob as it is, nothing for NULL. Numbers are
 * big-endian. A row is its covered values in declared order. Tables come in name order, and each
 * contributes its name, its covered column count in 8 bytes, each covered column's name, its row
 * count in 8 bytes, and then its rows sorted by their encoding. A name is framed like a text
 * value. The lengths and counts frame everything, and the class tells equal payloads apart, since
 * NULL, '' and x'' are all empty. So an added table or column changes the digest, a table with no
 * covered column still counts through its name and rows, and no two layouts give the same bytes.
 *
 * Sorting the encoded rows orders them without leaning on anything SQLite decides: not storage
 * order, not a key, not a column's collation, and not the file's text encoding, which SQLite
 * stores and compares text in. Table names are sorted by their UTF-8 bytes for the same reason.
 *
 * Like scripts/drift-guard.ts, this file imports node builtins only and runs under plain `node`.
 * test/index-digest.test.ts pins what moves the digest and what does not.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

/** The column every main table has for the wiki page's last-edit time. */
const EDIT_TIME = 'timestamp';

/** Of database_info, only the row with this key is content. */
const COVERED_INFO_KEY = 'version';

/** SQLite's own type codes, from sqlite3.h. */
const INTEGER = 1;
const REAL = 2;
const TEXT = 3;
const BLOB = 4;
const NULL = 5;

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** SHA-256, as lowercase hex, over the index at `path`, opened read-only. */
export function indexDigest(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table'").all()
      .map((row) => row['name'])
      .filter((name): name is string => typeof name === 'string' && !name.startsWith('sqlite_'))
      .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    if (tables.length === 0) throw new Error(`${path} has no table.`);
    // BINARY, so a key column declared NOCASE cannot let a 'VERSION' row stand in for it.
    const infoWhere = ` where "key" = '${COVERED_INFO_KEY}' collate binary`;
    if (!tables.includes('database_info') || db.prepare(`select 1 from database_info${infoWhere}`).get() === undefined) {
      throw new Error(`${path} has no ${COVERED_INFO_KEY} row in database_info.`);
    }

    const hash = createHash('sha256');
    for (const table of tables) {
      const columns = db.prepare(`pragma table_xinfo(${quoted(table)})`).all()
        .map((column) => String(column['name']))
        .filter((name) => name !== EDIT_TIME);
      hash.update(Buffer.concat(frame(TEXT, Buffer.from(table, 'utf8'))));
      hash.update(count(columns.length));
      for (const column of columns) hash.update(Buffer.concat(frame(TEXT, Buffer.from(column, 'utf8'))));

      // A table with no covered column still has rows, each of which encodes as nothing.
      const selected = columns.length > 0 ? columns.map(quoted).join(', ') : '1';
      const where = table === 'database_info' ? infoWhere : '';
      const read = db.prepare(`select ${selected} from ${quoted(table)}${where}`);
      // As BigInt, each JS type node:sqlite returns is exactly one storage class. As a JS
      // number, an integer would look like a real, and past Number.MAX_SAFE_INTEGER throw.
      read.setReadBigInts(true);
      const rows: Buffer[] = [];
      for (const row of read.iterate()) {
        rows.push(Buffer.concat(columns.flatMap((column) => encode(row[column]))));
      }
      rows.sort(Buffer.compare);
      hash.update(count(rows.length));
      for (const row of rows) hash.update(row);
    }
    return hash.digest('hex');
  } finally {
    db.close();
  }
}

/** A count as 8 bytes. */
function count(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/** A value's header and payload, as two chunks. */
function encode(value: SQLOutputValue | undefined): [Buffer, Uint8Array] {
  if (value === null) return frame(NULL, new Uint8Array(0));
  // Text is hashed as UTF-8 of the decoded string, so the file's own text encoding does not
  // count. Invalid UTF-8 would decode to U+FFFD and two such values would hash alike, but the
  // generator writes Python strings, which are always valid.
  if (typeof value === 'string') return frame(TEXT, Buffer.from(value, 'utf8'));
  if (value instanceof Uint8Array) return frame(BLOB, value);
  const payload = Buffer.alloc(8);
  if (typeof value === 'bigint') {
    payload.writeBigInt64BE(value);
    return frame(INTEGER, payload);
  }
  if (typeof value === 'number') {
    payload.writeDoubleBE(value);
    return frame(REAL, payload);
  }
  throw new Error(`Unexpected ${typeof value} value in the digest read`);
}

function frame(storageClass: number, payload: Uint8Array): [Buffer, Uint8Array] {
  const head = Buffer.alloc(5);
  head.writeUInt8(storageClass, 0);
  head.writeUInt32BE(payload.length, 1);
  return [head, payload];
}

const USAGE = 'Usage: node scripts/index-digest.ts <index.db>\n';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.exitCode = 2;
    process.stderr.write(USAGE);
  } else {
    try {
      const digest = indexDigest(args[0]!);
      process.stdout.write(`${digest}\n`);
    } catch (error) {
      // The reason is a sentence the job log shows, rather than a stack trace over a missing file.
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
