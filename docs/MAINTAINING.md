# Maintaining

How the index is built, tested and refreshed. [RELEASING.md](RELEASING.md) covers publishing.

## The `index.db` export

The file is exported as the subpath `@tibia.sh/tibiawiki-data/index.db`. The
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
[Bumping the schema version](RELEASING.md#bumping-the-schema-version). The literal is deliberate.
Derived from `package.json`, that assertion would compare a value with itself and could
never fail, and it is the only thing that stops a release from shipping under the wrong
major.

## Why the index is committed

`index.db` is committed to this repository in plain git.

- **A fresh clone is a complete package.** It has an index to test and to pack, so
  publishing a release packs the committed file and never needs a crawl.
- **A data refresh is a pull request.** Its diff is the new `index.db`, so the file its
  checks tested, and the file you look at when the drift job holds it, is the file published.

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

- The package version.
- `version` in the index's `database_info` table, which is the tibiawiki-sql
  generator version.
- `generate_time` in the same table, which records when the index was generated.
  It is a timestamp, not a wiki revision. The generator records no revision.

What each release was built from is on its own release page, at
[github.com/tibia-sh/tibiawiki-data/releases](https://github.com/tibia-sh/tibiawiki-data/releases).
A release is named after the package version, and its notes carry the other two values.

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
writes exactly the file this package ships and exports. From `0.3.1`, the server installs
the generator from its own requirements file, where every Python dependency is pinned and
hashed, so every build runs the same packages. Builds still set a 7-day PyPI cooldown,
matching the one pnpm applies to npm packages. It is a backstop for a server older than
`0.3.1`, which resolves those dependencies fresh on every build. You can override it with
`UV_EXCLUDE_NEWER`.

`build-index` needs [`uv`](https://docs.astral.sh/uv/) and network access to
TibiaWiki. It validates the new index before replacing `index.db`, so a build that
trips a gate exits non-zero and leaves the committed `index.db` as it was. While it
works, it writes `.tibiawiki.db.<pid>.<hex>.tmp` next to the target, and SQLite keeps
its journal beside that. `.gitignore` excludes both, and must never exclude
`index.db`. The `3.0.0` build took just under six minutes, most of it the generator's
crawl.

`pnpm test` pins the generator too. It fails for an index whose `database_info` `version`
is anything but the generator the pinned server installs: `test/data.test.ts` reads it from the
first line of the server's shipped lock, `data/tibiawikisql-requirements.txt`, which reads
`# tibiawikisql <version> and every dependency`. From `0.12.0`, the server's `build-index`
runs tibia.sh's copy of tibiawiki-sql, and the `+tibiash.N` suffix of that version marks the
copy. The major version covers only the server's enrichment tables, and no version covers the
tables tibiawiki-sql writes.

The generator's tables can grow within a major, but only because of how the servers read them.
Every published `^N` server checks that the tables and columns it requires are present, and
reads columns by name. So an index that only adds tables or columns ships in a minor. A change
that would break a `^N` server is not a minor. That includes an added column, once a server reads
columns by position or refuses columns it does not know.

A generator upgrade does not bump the major. If you installed any published server that depends
on `^N`, your next install gets every new `N.x` of this package. So before every publish, and in
CI, the `oldest-consumer` job installs the oldest and the newest published `^N` server from npm,
each together with the packed candidate, and pages every item through each one's
`tibia_find_items`. The oldest has the oldest serving code that still gets a new `N.x`. The newest
is the one a fresh install gets, and newer serving code can refuse an index the oldest serves. When
one server is both, the job sweeps it once. The gate passes only when, for each server, no page
is an error, every page carries the candidate index's `generate_time`, and every item in the
index comes back exactly once. `pnpm oldest-consumer` runs the same gate, and needs network
access to npm.

The sweep covers items only, not creatures, NPCs, quests or spells. So the generator moves only
with the server pin, and an index built by any other generator cannot publish.

### Drift

`.github/workflows/drift.yml` rebuilds the index on Tuesdays and Fridays at 06:17 UTC, when
you run it by hand from the Actions tab, and when tibiawiki-mcp's release workflow sends the
`repository_dispatch` event `server-release`, with `{"version": "<x.y.z>"}` as its payload,
once npm accepted a server publish.

Before the generator runs, its `Pin the server` step decides which server builds the index, with
`scripts/server-pin.ts`:

- A `server-release` dispatch names the version. The step checks it whole as `x.y.z`, and a
  version above the pin moves the pin to it. One at the pin keeps it. One below the pin, such as
  a dispatch that arrived after a newer server was pinned, is refused with a notice in the log:
  the pin stays, and the run goes on as a scheduled run would.
- Any other run moves the pin to the version npm lists as `latest` when that is above the pin,
  so a release whose dispatch was lost is picked up by the next scheduled run.

A move waits up to 15 minutes, checking every 30 seconds, until `npm view` lists the version's
tarball and a `HEAD` on it answers 200, then runs `pnpm add -D --save-exact`. The step holds no
token. It hands the `pr` job the server, whether the pin moved, and the SHA-256 of
`package.json` and `pnpm-lock.yaml` as it built with them.

The job then digests the committed `index.db` with `scripts/index-digest.ts`, keeps a copy of
it, runs `pnpm build-index`, digests the rebuilt index, and runs `pnpm test` against it. The
run's log shows both digests.

The digest covers the whole index this package publishes: every table, and every column of
it, generated and hidden columns included. It leaves out two things that change without the
content changing:

- the `timestamp` column the generator gives every row of the main tables. It is the wiki
  page's last-edit time, so an edit that changes nothing the generator extracts still moves
  it, and that is no reason to publish.
- every `database_info` row but `version`. The others stamp the run or the build host, such
  as `generate_time` and `python_version`.

The script refuses an index with no table or without the `version` row, and the run ends red.
The same script digests both indexes, so a change to the script alone never opens a refresh.
`test/index-digest.test.ts` pins what moves the digest and what does not.

When the digests match and the pin stayed, the run ends green and opens nothing. When they
differ, the content changed, and `scripts/drift-guard.ts` compares the kept copy with the
rebuilt index. It holds the refresh for a person when:

1. one of the eight main tables, `item`, `creature`, `npc`, `book`, `house`, `achievement`,
   `quest` and `spell`, lost more than 1% of its committed rows
2. any table of the committed index is missing from the rebuilt one
3. any table that had rows in the committed index has none
4. any table or column of the committed index is gone from the rebuilt schema, as
   `scripts/schema-diff.ts` finds it, since a published `^N` server can require it

Growth never holds, and a table or column only the rebuilt index has is growth. Each reason is
one line, such as `item lost 120 of 9,800 rows (1.2%)`, `table quest is empty, it had 370 rows`
or `creature.race_id is gone from the rebuilt index`. The row count reasons name a table once at
most, and a table that went missing is named by both 2 and 4.

The job also reads the schema level from `scripts/schema-diff.ts`: `minor` when the rebuilt
index added a table or a column, as [How the index is built](#how-the-index-is-built) says a minor may,
and `patch` otherwise. A changed `SCHEMA_VERSION` fails `pnpm test`, since the package major
must equal it, so a new major ends the run red for a person rather than opening a pull request.

The `pr` job first checks each value the build job handed on whole: `changed` and `pin_moved`
are `true` or `false`, the level is `patch` or `minor`, and the server is `x.y.z`, above `main`'s
pin when it moved and `main`'s pin when it did not. The build job ran the generator, so the `pr`
job takes none of its files but the index. When the pin moved, it recomputes the pin itself with
`pnpm add --lockfile-only --ignore-scripts --ignore-pnpmfile`, which installs nothing and runs no
dependency code, requires that the recompute changed `package.json` and `pnpm-lock.yaml` alone,
and `package.json` only in the server's version, and requires both files to hash to what the
build job built with. Its `pnpm/setup` installs pnpm alone and restores no cache.

When the content changed, it sets `version` to the next patch or minor npm does not have, as
the level says, pushes the rebuilt `index.db`, with the moved pin if there is one, to the
`drift/index` branch, and opens a pull request titled
`chore: release a refreshed index as X.Y.Z` that carries both digests, or updates the one
already open. When only the pin moved, the pull request carries `package.json` and
`pnpm-lock.yaml` alone, at the version `main` has, is titled `chore: pin the server at X.Y.Z`,
and says that merging it publishes nothing. It pushes and opens with a token of the tibia-sh
App, so the pull request's CI starts by itself.
[The tibia-sh App](RELEASING.md#the-tibia-sh-app) says what that token can do.

After the push and the update, the job reads the pull request again. When it merged or closed
between the lookup and the push, the job opens a new one for `drift/index` and goes on with
that. Auto-merge is turned on or off from what this read shows.

- **Not held.** The job turns on auto-merge with rebase and waits up to 60 minutes for the
  merge, checking every 30 seconds. Auto-merge merges the pull request once `test` and
  `oldest-consumer`, which the ruleset requires, pass, and the merge publishes the new patch
  through `release.yml`. Only a merge of the commit this run pushed counts. The wait is a step
  of its own that reads with `GITHUB_TOKEN`, since the App token expires within the hour, so it
  turns nothing on. A read of the pull request that fails is tried again 10 seconds later. The
  job ends red when the pull request is closed without merging, merges another commit, has
  auto-merge off, is still open at the deadline, or cannot be read 3 times in a row.
- **Held.** The job turns auto-merge off first when the open pull request has it, then pushes
  and opens or updates the pull request, and turns auto-merge off again when the read after the
  push finds it on. Its body starts with **Held for review.** and lists the reasons. The run
  ends green and the pull request waits for you.

A run on `main` whose `build` or `pr` job fails, times out or is cancelled, or that holds a
refresh, comments on the issue `Automation needs a look`, or opens it assigned to `drptbl`.
`alert.yml` comments on the same issue for a `release.yml` run that does not succeed.
[When automation needs a look](RELEASING.md#when-automation-needs-a-look) says what to do.

- A tripped gate, a failing test, a guard that cannot read an index, an unreadable registry, a
  dispatch that names no `x.y.z` version, a server npm does not serve within 15 minutes, a
  build job output or a recomputed pin the `pr` job does not accept, or a `version` on `main`
  that npm does not list yet each end the run red before anything is pushed. A pull request closed without merging, merged at another commit, left with auto-merge
  off, or not merged within 60 minutes ends it red after the push.
- Each run that finds a change replaces `drift/index`, so an open pull request always carries
  the newest rebuild. A held pull request you leave open is not frozen: when a later run's
  guard finds no reason to hold, that run turns auto-merge on and it merges by itself.
- A run you dispatch from another branch builds, tests and guards, and pushes, opens, merges
  and alerts nothing. Only `main` can use the `drift` environment, where the job mints the App
  token.
- GitHub turns off a schedule after 60 days without activity in a public repository, and
  that stops the job without a red run. Turn it back on from the Actions tab.

## The devDependency on the server

`@tibia.sh/tibiawiki-mcp` is a devDependency for two jobs: its `build-index` produces
the index, and its `serve` validates it, in `pnpm test` here and in `pnpm smoke` against
an installed copy.

**How it moves.** It is pinned to an exact version, and a test in
`test/drift-workflow.test.ts` fails on a range. The drift job moves it: each server release
sends `server-release`, and each scheduled run picks up a newer `latest`, as [Drift](#drift)
says. Its pull request, a refresh or a pin-only one, carries the new pin. To move it by hand,
run `pnpm add -D --save-exact @tibia.sh/tibiawiki-mcp@X.Y.Z`.

A server release that brings a new generator needs no second change: `test/data.test.ts` reads
the generator version from the pinned server's shipped lock. The README links to the releases
page of tibia.sh's copy and names no release.

The drift job's digest is this repository's own `scripts/index-digest.ts`, so a bump never
changes how an index is digested. When the new `build-index` produces other content, the
next run sees it in the digest and opens a refresh.

**The dependency cycle is intentional.** The server depends on this package, and this
package devDepends on the server. npm and pnpm allow it because this side is
dev-only and never resolved at runtime. Do not "fix" it. Because the server depends on
this package, `node_modules` here also holds a published copy of this package,
installed as the server's dependency. The server's default index resolution could
find that copy instead of `index.db`. So the test always passes `TIBIAWIKI_MCP_DB`
explicitly, and checks that the answer's `indexGeneratedAt` matches `index.db`.

## Development

Requires Node 22.18 or later, because the tests run TypeScript directly, and pnpm
12.6.0, pinned in `packageManager`.

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
   workflows, the smoke check, the oldest-consumer gate's decisions and the test floor, with
   no network.

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
`LICENSE` that npm always adds. `@tibia.sh/*` packages and pnpm itself are
exempt from this repository's seven-day install cooldown. `pnpm-workspace.yaml` says why.

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
