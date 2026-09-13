# tibiawiki-data

The prebuilt TibiaWiki index served by
[`@tibia.sh/tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp). It is one
SQLite file, plus a module that gives its path and its schema version.

## Use

```js
import { DB_PATH, SCHEMA_VERSION } from '@tibia.sh/tibiawiki-data';
```

- `DB_PATH` is the absolute path to `index.db` inside the installed package.
- `SCHEMA_VERSION` is the index's enrichment schema version (its `mcp_schema_version`
  row), and always equals this package's major version.

The file is also exported as the subpath `@tibia.sh/tibiawiki-data/index.db`. The
server finds the packaged index by resolving that subpath, so it must stay in
`exports`. Without it, Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## The major version is the schema version

The first release is `3.0.0`, not `1.0.0`, because the server's `MCP_SCHEMA_VERSION`
is `3`. Do not reset it. A server that reads schema N depends on `^N`, so npm refuses
to install an index the server cannot read. Without that, the server would only find
out at startup, and would then answer every query with an error. Releases within a
major are data refreshes of the same schema.

`SCHEMA_VERSION` is a literal in `src/index.ts`, and `pnpm test` asserts that it
equals both the `package.json` major and the index's `mcp_schema_version` row.
Change all three together, following
[Bumping the schema version](#bumping-the-schema-version). The literal is deliberate.
Derived from `package.json`, that assertion would compare a value with itself and could
never fail, and it is the only thing that stops a release from shipping under the wrong
major.

## Why the index is committed

`index.db` is committed to this repository in plain git.

- **A fresh clone is a complete package.** It has an index to test and to pack, so
  publishing a release packs the committed file and never needs a crawl.
- **A data refresh is reviewable.** It is a pull request whose diff is the new
  `index.db`, so the file reviewed is the file published.

**Measured cost, for the `3.0.0` index (2026-09-12):**

| Measurement | Size |
|---|---|
| `index.db` on disk | 18,042,880 bytes |
| One committed build, as a git pack | 5.36 MiB |
| The npm tarball | 5.38 MiB |
| A second real build added to the same repository, after `git gc --aggressive` | +0.48 MiB |

SQLite does not diff as text, but git's binary deltas are effective on it. The second
build was generated the same day as the first, so a refresh after a week of wiki
edits may delta less well. Budget for a full 5.4 MiB per committed refresh as the
upper bound.

**Why not Git LFS.** Plain git is self-contained: there is no LFS storage or bandwidth
quota, every checkout gets the index without extra configuration, and a clone is
everything needed to test and pack. Move to LFS only if clone times become a real
complaint.

## Identifying a release

A release is a snapshot of a wiki that keeps changing. It can be identified, but not
reproduced byte for byte. Three values identify it:

- the package version;
- `version` in the index's `database_info` table, which is the tibiawiki-sql
  generator version;
- `generate_time` in the same table, which records when the index was generated.
  It is a timestamp, not a wiki revision. The generator records no revision.

What each release was built from:

| Release | Generator `version` | `generate_time` |
|---|---|---|
| `3.0.0` | `9.0.0` | `2026-09-12T19:53:53.020856+00:00` |

To read them from any index:

```bash
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('index.db', { readOnly: true }); console.log(db.prepare(\"select key, value from database_info where key in ('version', 'generate_time')\").all())"
```

The server reports the same two values. Its MCP instructions name both, and every
tool response carries `generate_time` as `indexGeneratedAt`.

## How the index is built

The index is built by the server's own `build-index` command, run from this
repository's devDependency. The server's gates decide whether a build is good enough.
Those gates cover coverage, parse failures, image resolution and spell shapes, and
they are defined and tested in the server. They are not repeated here.

```bash
pnpm build-index
```

That builds `dist/`, then `scripts/build.ts` runs the devDependency's
`tibiawiki-mcp build-index` with `TIBIAWIKI_MCP_DB` set to `DB_PATH`, so the build
writes exactly the file this package ships and exports. Every build resolves the
generator's PyPI dependencies after a 7-day cooldown, matching the one pnpm applies to npm
packages, and setting `UV_EXCLUDE_NEWER` overrides it.

`build-index` needs [`uv`](https://docs.astral.sh/uv/) and network access to
TibiaWiki. It validates the new index before replacing `index.db`, so a build that
trips a gate exits non-zero and leaves the committed `index.db` as it was. While it
works, it writes `.tibiawiki.db.<pid>.<hex>.tmp` next to the target, and SQLite keeps
its journal beside that. `.gitignore` excludes both, and must never exclude
`index.db`. The `3.0.0` build took just under six minutes, most of it the generator's
crawl.

`pnpm test` pins the generator too. It fails for an index whose `database_info` `version`
is anything but `9.0.0`. The major version covers only the server's enrichment tables,
and no version covers the tables tibiawiki-sql writes.

A generator upgrade does not bump the major. Instead, before you release an index built by a
new generator, the oldest published server that depends on `^N` has to pass its full item
sweep in `test/regression.test.ts` against that index. Until that gate exists, the `9.0.0`
guard blocks any generator change.

### Drift

`.github/workflows/drift.yml` rebuilds the index every Monday at 06:17 UTC, and when you
run it by hand from the Actions tab. It digests the committed `index.db` with the
devDependency's `tibiawiki-mcp index-digest`, runs `pnpm build-index`, digests the
rebuilt index, and runs `pnpm test` against it. The digest covers what the server reads,
and leaves out stamps that change on every run, such as `generate_time`. The run's log
shows both digests.

When the digests match, the run ends green and opens nothing. When they differ, the
content changed. The run pushes the rebuilt `index.db` to the `drift/index` branch, with
`version` set to the next patch npm does not have. It opens a pull request carrying both
digests, or updates the one already open. Merging that pull request publishes the new
patch.

- The pull request is opened with `GITHUB_TOKEN`, so its CI waits for you. Click
  "Approve workflows to run" on it, then review the pull request before you merge it.
- The workflow never merges and never turns on auto-merge, so a bad day on the wiki can at
  most open a pull request.
- A red run is a signal. A tripped gate, a failing test, an unreadable registry, or a
  `version` on `main` that npm does not list yet each end the run red, and nothing is
  pushed or opened. Find out why before the next run.
- Each run that finds a change replaces `drift/index`, so an open pull request always
  carries the newest rebuild.
- GitHub turns off a schedule after 60 days without activity in a public repository, and
  that stops the job without a red run. Turn it back on from the Actions tab.

## The devDependency on the server

`@tibia.sh/tibiawiki-mcp` is a devDependency for three jobs: its `build-index` produces
the index, its `index-digest` tells the drift job whether a rebuild changed it, and its
`serve` validates it, in `pnpm test` here and in `pnpm smoke` against an installed copy.

**When to bump it.** On a `0.x` version, `^0.3.0` means `>=0.3.0 <0.4.0`. Left alone,
it pins every rebuild to the 0.3 generator and its gates while the server moves on.
Bump it whenever the server's indexer changes: `build-index`, its enrichment, its
gates, or the schema. Write the new range by hand. This repository saves exact
versions, so `pnpm add` records a pin instead.

**The dependency cycle is intentional.** The server depends on this package, and this
package devDepends on the server. npm and pnpm allow it because this side is
dev-only and never resolved at runtime. Do not "fix" it. Because the server depends on
this package, `node_modules` here also holds a published copy of this package,
installed as the server's dependency. The server's default index resolution could
find that copy instead of `index.db`. So the test always passes `TIBIAWIKI_MCP_DB`
explicitly, and checks that the answer's `indexGeneratedAt` matches `index.db`.

## Development

Requires Node 22.18 or later, because the tests run TypeScript directly, and pnpm
10.33.0, pinned in `packageManager`.

```bash
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` does three things, in this order:

1. It builds `dist/`.
2. It typechecks `src/`, `test/` and `scripts/`, the JavaScript in `scripts/`
   included. This must come after the build: the test imports this package by its own
   name, so it typechecks against the built declarations, as a consumer does.
3. It runs every `test/*.test.ts`. `test/data.test.ts` spawns the server from the
   devDependency against `index.db`, and makes a real query. The other files check the
   release and drift workflows, the smoke check and the test floor, with no network.

The run fails when fewer than `MIN_TESTS` tests pass. `node --test` still exits 0 for a
file that declares no tests, for a skipped test, and for a `--test-name-pattern` that
filters tests away, one inherited through `NODE_OPTIONS` included. Without the floor, an
emptied test file would pass the gate every publish runs. Adding a test needs no change. When
you remove or skip one on purpose, lower `MIN_TESTS` in `test/min-tests.ts` in the same
commit.

`prepublishOnly` runs `pnpm test` too, so publishing from the directory always builds
`dist/` first.

After changing `version` in `package.json`, run `pnpm install` before `pnpm test`.
`verifyDepsBeforeRun` treats a version change as a workspace change and refuses to
run scripts until you do.

The tarball ships `index.db` and `dist/`, plus the `package.json`, `README.md` and
`LICENSE` that npm always adds. `@tibia.sh/*` packages are exempt from this
repository's seven-day install cooldown. `pnpm-workspace.yaml` says why.

### Checking a release, before and after publishing

```bash
pnpm smoke ./tibia.sh-tibiawiki-data-3.0.0.tgz   # a packed tarball, before publishing
pnpm smoke @tibia.sh/tibiawiki-data@3.0.0        # the published version, after
```

`pnpm smoke` installs the package under test into a throwaway directory, together with
the server and the MCP client at the versions `package.json` names, and runs
`test/data.test.ts` there. Inside that directory the test's imports land on the
installed package and it spawns the installed server, so it checks the artefact rather
than this checkout. That is why the test file imports only node builtins and packages
by name.

## Releases

Merging a commit to `main` publishes its `package.json` `version` if npm does not have
that version yet. On every push to `main`, `.github/workflows/release.yml` asks npm
whether it lists that exact version. If it does, the run publishes nothing and ends
green. Every merge that leaves `version` alone ends this way. If it does not, the run
installs from the lockfile, runs `pnpm test`, and runs `npm publish`.

- The check is for existence, never a comparison with `latest`. A revert leaves
  `version` below `latest`, and `npm publish` moves `latest` itself.
- A registry the check cannot read fails the run. It is never taken for a missing
  version.
- The run packs the committed `index.db` and never rebuilds it, so the file published is
  the file reviewed in the pull request.
- It publishes through npm trusted publishing, so no npm token exists to leak, and npm
  attaches a provenance attestation for the merged commit. The trusted publisher is
  registered for the file name `release.yml`, and renaming the file breaks publishing
  with no warning.
- Every pull request runs the same `pnpm test`, in `.github/workflows/ci.yml`.

Nothing is tagged, so a failed publish leaves nothing stranded. When a release run fails,
follow [docs/RELEASING.md](docs/RELEASING.md).

### Bumping the schema version

**Not yet exercised.** No schema bump has gone through this procedure.

A bump from N-1 to N cannot pass the automated gates. This package's `N.0.0` runs
`pnpm test` against its devDependency server, which has to read schema N, so it needs a
schema-N server on the registry. That server's CI needs this package's `N.0.0` on the
registry: its `^N` dependency has to install, and its `test/data-package.test.ts` and
regression sweep read the installed index. So one side is published outside its
pipeline. It is this package, because no published server installs `N.0.0`. Server
`0.1.0` does not use this package, and every later server depends on a major below N.

1. On the server's schema-N branch, run `pnpm build`, then `npm pack`. Build this
   repository's index with that tarball's `build-index`. The published server stamps the
   index N-1, which this repository's tests reject. Then cross-validate: install each
   repository's counterpart from the other's local tarball, and run both full test
   suites. Neither repository builds `dist/` when it packs, so build before every
   `npm pack`, or the tarball carries a stale `dist/` or none.
2. The maintainer publishes this package's `N.0.0` by hand, from the validated tarball.
   `npm publish` runs no lifecycle scripts for a tarball, so step 1 is the only gate it
   gets. The release carries no provenance and no trusted publisher.
3. The server's pull request sets `MCP_SCHEMA_VERSION` to N and its dependency range to
   `^N`. It also adds `trustPolicyExclude` for exactly `@tibia.sh/tibiawiki-data@N.0.0`
   to the server's `pnpm-workspace.yaml`, with the reason in a comment:

   ```yaml
   # @tibia.sh/tibiawiki-data N.0.0 was published by hand, so it has no trusted publisher.
   trustPolicyExclude:
     - '@tibia.sh/tibiawiki-data@N.0.0'
   ```

   Its CI passes against the registry, and its release PR publishes it through the
   server's pipeline.
4. This repository's pull request commits that exact `index.db`, with `SCHEMA_VERSION` N,
   `version` `N.0.0`, and the devDependency moved to the new server. The new server
   depends on `^N`, so the install here resolves the hand-published `N.0.0` too, and the
   pull request adds the same exclude to this repository's `pnpm-workspace.yaml`. Its CI
   passes, and merging it publishes nothing, because npm already has `N.0.0`.

Do not merge a data refresh here between steps 2 and 4. `main` is still on N-1 then, and
npm refuses to publish a version below `N.0.0` without a dist-tag, so its release run
fails.

Both repositories set `trustPolicy: no-downgrade`, which makes pnpm refuse a version with
weaker trust evidence than any version published before it. The release workflow publishes
with a trusted publisher, and a publish by hand has none. So once npm has a release of this
package from the release workflow, an install that resolves `N.0.0` without the exclude
fails with `ERR_PNPM_TRUST_DOWNGRADE`. pnpm reads only the first `trustPolicyExclude` entry
that names a package, so keep one entry for it.

Once npm has `N.0.1` or later from the release workflow, remove both excludes. In each
repository, remove it in the pull request that moves the lockfile off `N.0.0` with
`pnpm update @tibia.sh/tibiawiki-data --no-save`. Without `--no-save`, pnpm also raises the
server's `^N` to the new version, such as `^N.0.1`, and the server's
`test/data-package.test.ts` rejects that. Without the exclude, a lockfile still on `N.0.0`
fails the next `pnpm dedupe`.

**Verify the deadlock before relying on this.** On a scratch branch, set the server's
`MCP_SCHEMA_VERSION` to N: its `test/data-package.test.ts` and regression sweep must
fail. Here, set `SCHEMA_VERSION` and `version` to N against the schema-(N-1)
devDependency: the suite must fail before anything is published. If either suite passes,
it is not checking what this procedure assumes, so stop and find out why. Once npm has a
release of this package from the release workflow, the server's install of the
hand-published `N.0.0` fails with `ERR_PNPM_TRUST_DOWNGRADE` without the exclude from
step 3. Do not try to reproduce that against the real registry, because it takes a real
publish by hand.

This repository's half was checked on 2026-09-13 for N = 4, on a clone. `pnpm test`
fails at `the shipped index carries SCHEMA_VERSION`. With the index's
`mcp_schema_version` row set to 4 as well, it fails at the server test instead, because
the schema-3 server refuses a schema-4 index. Either way `npm publish` stops in
`prepublishOnly` and packs nothing.

The trust failure was checked on 2026-09-13 with pnpm 10.33.0, against a local stand-in
for the registry and never the real one. With `3.0.1` from a trusted publisher and `4.0.0`
published by hand after it, the server's install of `^4` and this repository's install of
a server that depends on `^4` both fail with `ERR_PNPM_TRUST_DOWNGRADE`. An exclude for
exactly `@tibia.sh/tibiawiki-data@4.0.0` lets both through.

## Licence

`index.db` is adapted from TibiaWiki (https://tibia.fandom.com), whose text is
licensed [CC BY-SA 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/)
by TibiaWiki and its contributors, and it is released under the same licence. Tibia
is made by CipSoft, and its game content is copyright CipSoft GmbH. The index is
generated by [tibiawiki-sql](https://github.com/Galarzaa90/tibiawiki-sql).

The JavaScript module in `dist/` is MIT licensed. See `LICENSE` for both.
