# Releasing

Merging a commit to `main` publishes its `package.json` `version` if npm does not have
that version yet. On every push to `main`, `.github/workflows/release.yml` runs the
`oldest-consumer` gate from [How the index is built](MAINTAINING.md#how-the-index-is-built), and its release
job waits for that gate. The release job then asks npm whether it lists that exact version. If
it does, the run publishes nothing and ends green. Every merge that leaves `version` alone,
and passes the gate, ends this way. If it does not, the run installs from the lockfile, runs
`pnpm test`, and runs `npm publish`.

- The gate runs on every push, whether the run publishes or not, so an index that breaks the
  oldest or the newest published server turns the run red even when nothing is published.
- The check is for existence, never a comparison with `latest`. A revert leaves
  `version` below `latest`, and `npm publish` moves `latest` itself.
- A registry the check cannot read fails the run. It is never taken for a missing
  version.
- The run packs the committed `index.db` and never rebuilds it, so the file published is
  the file the pull request carried and its checks tested.
- It publishes through npm trusted publishing, so no npm token exists to leak, and npm
  attaches a provenance attestation for the merged commit. The trusted publisher is
  registered for the file name `release.yml`, and renaming the file breaks publishing
  with no warning.
- Once npm has accepted the publish, the run's `hosting` job tells `tibia-sh/mcp.tibia.sh`
  about the version. Its `bump.yml` pins it, opens a pull request and merges it when the
  checks pass, so the hosted endpoint `https://mcp.tibia.sh/wiki` serves the new index
  within minutes. When that job is red, follow
  [The hosting dispatch](#the-hosting-dispatch).
- The run's `github-release` job tags the published commit `vX.Y.Z` and creates the GitHub
  release for it, with notes generated from the index. When that job is red, follow
  [The GitHub release](#the-github-release).
- Every pull request runs the same `pnpm test` and the same gate, in `.github/workflows/ci.yml`.
- A data refresh reaches `main` by itself. The drift job pushes its pull request and turns on
  auto-merge with `DRIFT_TOKEN`, so the merge is a push by you, the token's owner, and this
  workflow runs on it as on any merge. [The drift token](#the-drift-token) says what that token
  can do, and [When the drift job needs a look](#when-the-drift-job-needs-a-look) covers a
  refresh the drift job held.

The tag and the release are created only after npm accepted the publish, so a failed publish
still strands nothing.

## When a release run fails

A failed run leaves nothing stranded. `main` holds a version npm does not have, and the next release run tries it again.

| Cause | What to do |
|---|---|
| Something in the repository, such as a failing test | Fix it in a pull request and merge. The merge's run publishes. |
| Something outside it: npm was down, or the trusted publisher on npmjs.com does not match and `npm publish` failed with `ENEEDAUTH` | Fix that, then re-run the most recent release run. |
| npm lists the version although the run failed | The publish went through, and the next run publishes nothing. When the `hosting` job is red or was skipped, follow [The hosting dispatch](#the-hosting-dispatch). Check the GitHub release the same way, with [The GitHub release](#the-github-release). |

Never re-run a release run expecting a different result when nothing outside the repository changed.

npm never accepts the same version twice, even after an unpublish, per its [unpublish policy](https://docs.npmjs.com/policies/unpublish). To replace a published version, bump to the next patch. An unpublished version needs the same bump. npm keeps refusing it, although `npm view` no longer lists it.

## When the oldest-consumer job fails

The release job waits for `oldest-consumer`, so a red gate blocks the publish. The gate installs the oldest and the newest published servers that depend on `^N`, each together with the packed index, and pages every item through each. When one server is both, the gate sweeps it once. Its log ends with a `FAIL` line, and the lines under it name the case. When the case happened in one consumer, the first of them names that consumer, such as `The newest consumer, @tibia.sh/tibiawiki-mcp@0.4.0, failed.` Look up the message after it:

| The log under `FAIL` says | Cause | What to do |
|---|---|---|
| `is an error, so the server could not serve it`, `came from an index generated at`, `matching items, but the index holds`, `came back on page`, `distinct items, but the index holds`, `the sweep returned no items` or `is not in the shape the gate reads` | The sweep failed | A published `^N` server breaks on this index, so do not publish it as `N.x`. Fix the index or the generator, or treat the change as a new major under [Bumping the schema version](#bumping-the-schema-version). |
| `The sweep did not finish within` or `Request timed out` | The sweep timed out | Re-run the run once. When the same commit times out a second time, treat it as a failed sweep. |
| `npm installed`, `resolves @tibia.sh/tibiawiki-data/index.db to`, `holds @tibia.sh/tibiawiki-data@`, `DB_PATH is` or `is not defined by "exports"` | An install check failed | The install did not come out the way a user gets it, for example because of the candidate's `exports` map or its `DB_PATH`. Fix the package shape, not the index. |
| `No published @tibia.sh/tibiawiki-mcp depends on a range that` | No consumer | The candidate is a new major, and no published server depends on it yet. Follow the schema-bump procedure, [Bumping the schema version](#bumping-the-schema-version). |
| `Could not read https://registry.npmjs.org/`, `spawnSync npm ETIMEDOUT`, or a network error from npm, such as `npm error code ECONNREFUSED` | npm was unreachable or too slow | Re-run the run once npm is back. The run publishes only a version npm lacks. |
| `npm error code ETARGET`, `npm error code ENOVERSIONS` or `npm error code ERESOLVE` | npm could not resolve the install | npm takes everything but the two tarballs from before the `--before=` date in the log, 7 days back. Look up the package npm names with `npm view <name> time`. If every version that would do was published after that date, wait until one is 7 days old, then re-run the run. Otherwise the consumer and the candidate cannot install together. Fix the package shape, not the index. |

## Runs close together

Two version bumps merged close together can run in either order, because GitHub does not guarantee the order of waiting runs. When the lower version runs last, npm 12 refuses it with [`Cannot implicitly apply the "latest" tag`](https://github.com/npm/cli/blob/v12.0.2/lib/commands/publish.js#L185), as long as the higher version is neither deprecated nor a prerelease. Nothing needs doing, and that version number is skipped.

That refusal also needs the run to read the higher version from the registry. A run whose read misses it can publish the lower version instead, and move `latest` back to it. After two close bumps, check that `npm view @tibia.sh/tibiawiki-data dist-tags.latest` prints the higher version. If it does not, and the higher version is not deprecated, point `latest` at it, with `X.Y.Z` as the higher version:

```bash
npm login
npm dist-tag add @tibia.sh/tibiawiki-data@X.Y.Z latest
```

A push right after a publish can also read a version list from before that publish. Its run then tries to publish the same version again, and fails when npm refuses a version it already has. Nothing needs doing. A later run reads the new list and publishes nothing.

## The hosting dispatch

Once npm accepts the publish, the run's `hosting` job tells `tibia-sh/mcp.tibia.sh` about the release. Its one step, `Tell mcp.tibia.sh about the release`, sends a `repository_dispatch` of type `first-party-release` that names the package and the version, using the `HOSTING_DISPATCH_TOKEN` secret of the `release-trigger` environment. It makes up to three attempts, 30 seconds apart, and prints `Told tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-data X.Y.Z in attempt N.` once one got through. A run that publishes nothing skips the job.

The dispatch starts `bump.yml` in the hosting repository. That run pins the version, opens a pull request, turns on auto-merge and waits for the merge, and the merge deploys. [How a release reaches the endpoint](https://github.com/tibia-sh/mcp.tibia.sh/blob/main/docs/OPERATING.md#how-a-release-reaches-the-endpoint) in that repository's `docs/OPERATING.md` describes the chain and what can go wrong there. `gh run list --workflow bump.yml -R tibia-sh/mcp.tibia.sh` lists its runs.

A red `hosting` job leaves npm untouched. The publish happened before the job started. The job is red when the version does not look like `X.Y.Z`, or when all three attempts failed. Its error line names the version, and the log carries what `gh` said about each attempt, so you can tell a rejected token from an outage. Three attempts that all hang take 7.5 minutes, inside the job's 8, so the job normally ends with that error line. `Bad credentials (HTTP 401)` means the token expired or was revoked, and [The release trigger token](https://github.com/tibia-sh/mcp.tibia.sh/blob/main/docs/OPERATING.md#the-release-trigger-token) in the hosting repository's `docs/OPERATING.md` describes how to rotate it.

Re-running the whole release run does not send the dispatch again. Its release job finds the version on npm and publishes nothing, so `released` stays empty and the `hosting` job is skipped. Run `bump.yml` by hand instead, on `main` of the hosting repository, with the version npm has:

```bash
gh workflow run bump.yml -R tibia-sh/mcp.tibia.sh --ref main -f package=@tibia.sh/tibiawiki-data -f version=X.Y.Z
```

The run it starts does what the dispatch would have. A version the hosting repository already pins ends it green with nothing to do, so a dispatch that arrived after all costs nothing. A version below the pinned one fails it, because `bump.yml` refuses a downgrade.

## The GitHub release

Once npm accepts the publish, the run's `github-release` job tags the published commit `vX.Y.Z` and creates its GitHub release. Its first step, `Write the release notes`, finds the highest `vX.Y.Z` tag below this version, reads that release's `index.db` out of the tag, and runs `scripts/release-notes.ts` over both indexes. Its second step, `Create the GitHub release`, hands those notes to `gh release create`, which creates the tag on the commit the run published and adds GitHub's own generated notes since the previous tag. Every release is listed at [github.com/tibia-sh/tibiawiki-data/releases](https://github.com/tibia-sh/tibiawiki-data/releases).

A red `github-release` job leaves npm and the hosting dispatch untouched. The publish happened before the job started, and the `hosting` job does not wait for this one, so the endpoint still gets the new index. The job is red when the version does not look like `X.Y.Z`, when the tag `vX.Y.Z` exists already, or when the create failed. An existing tag is worth looking at rather than working around: the job runs only for a version npm did not have, so a tag for it should not exist. `git fetch --tags` and then `git log -1 vX.Y.Z` says which commit it points at, and the `gh release view` below says whether a release already sits on it.

Look before you create anything by hand. A `gh release create` GitHub accepted can still report a failure, for example when its answer never arrived, and then the release and its tag are already there:

```bash
gh release view vX.Y.Z
```

When it is there, nothing needs doing. When it is not, create it from any up-to-date checkout, with `X.Y.Z` as the published version and the commit that merged it as the target. The index comes out of that commit and not out of the working tree, so a release created days later still describes the snapshot its tag points at. The commands run in one subshell that stops at the first failure, so nothing is created unless the notes were written:

```bash
git fetch --tags
version=X.Y.Z
commit=<the merged commit>
(
  set -euo pipefail
  previous=$(git tag --list 'v*' | node scripts/release-notes.ts --previous-tag "$version")
  git show "$commit:index.db" > /tmp/index.db
  if [ -n "$previous" ]; then
    git show "$previous:index.db" > /tmp/previous-index.db
    node scripts/release-notes.ts "$version" /tmp/index.db "${previous#v}" /tmp/previous-index.db > /tmp/release-notes.md
    gh release create "v$version" --target "$commit" --title "v$version" --notes-file /tmp/release-notes.md --generate-notes --notes-start-tag "$previous"
  else
    node scripts/release-notes.ts "$version" /tmp/index.db > /tmp/release-notes.md
    gh release create "v$version" --target "$commit" --title "v$version" --notes-file /tmp/release-notes.md --generate-notes
  fi
)
```

`gh` can refuse the create with `"workflow" scope may be required`. GitHub does that when your token lacks the `workflow` scope and the workflow files at the target commit differ from those at every branch tip, which is the usual case for a commit that is no longer the tip of `main`. It happened for `v3.0.1` and `v3.0.2` when the first four releases were backfilled on 2026-09-18, and not for the two commits whose workflow files matched a branch. Push the tag over SSH, which no token scope limits, and create the release on it. In the block above, replace `--target "$commit"` with `--verify-tag` after:

```bash
git update-ref "refs/tags/v$version" "$commit"
git push origin "refs/tags/v$version"
```

The job itself tags the commit the run published, which is the tip of `main` unless a later merge changed a workflow in the minute between.

That is the job's own logic, so it covers a first release too: with no tag below the version, `previous` comes back empty and the notes are written from this index alone, with no start tag for the generated part.

Do not re-run the release run once npm accepted the publish. Its release job finds the version on npm and publishes nothing, so `released` stays empty and both this job and `hosting` are skipped.

## The drift token

`DRIFT_TOKEN` is your fine-grained personal access token, with `tibia-sh` as its resource owner and
`tibiawiki-data` as the only repository it can reach. It is a secret of this repository's `drift`
environment, which deploys from `main` only, and admins cannot bypass that rule. One step reads it,
`Push drift/index, open or update its pull request, and get it merged` in the `pr` job of
`drift.yml`. It is not `HOSTING_DISPATCH_TOKEN`, which the `hosting` job reads from the
`release-trigger` environment and which reaches `mcp.tibia.sh` only. Each token reaches one repository.

The token holds these permissions on `tibiawiki-data`:

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Metadata | Read, which GitHub adds to every fine-grained token |

The token has no expiry, so it lasts until it is rotated or revoked.

The drift job needs it because GitHub starts no workflow for a push, a pull request or a merge made
with `GITHUB_TOKEN`. With that token the pull request's CI would never run, and neither would
`release.yml` after the merge. With this one, the push, the pull request and the merge are yours.

The token means control of what npm publishes as `@tibia.sh/tibiawiki-data`. The ruleset requires
`test` and `oldest-consumer` and has no review rule, and those checks run the pull request's own
scripts and tests. So a holder can push a branch whose checks pass by construction, open a pull
request, turn on auto-merge, and land whatever `index.db`, `src/`, `package.json` or lockfile they
like on `main`. They can also push to `main` a commit whose checks already passed. `release.yml` then
publishes that content to npm with provenance, `package.json` and its scripts included.
`@tibia.sh/tibiawiki-mcp` installs it through `^3`, and the hosted endpoint serves it within
minutes. The token is your own identity, so no rule can tell its pull requests and merges from
yours, and the provenance attestation looks like any other release's. It cannot publish to npm
outside `release.yml`, and it cannot touch the other repositories. Without the Workflows permission
it cannot change a workflow file. The maintainer accepted that trade-off, as for the hosting
repository's release trigger token.

If this token leaks, revoke it first, on github.com under Settings, Developer settings, Personal
access tokens, Fine-grained tokens. Then check what `main` and npm hold:

1. Turn off auto-merge on every open pull request, or close it, your own included. One with
   auto-merge on merges without the token once its checks pass, and its merge publishes.
2. Read `git log` on `main` for commits you did not land yourself.
3. Run `npm view @tibia.sh/tibiawiki-data time` for versions published since the leak.
4. In a pull request, revert anything you did not land, and set `version` to the next patch npm
   does not have. Its merge publishes clean content above whatever the holder published, and the
   hosting repository moves to it, since its `bump.yml` pins the version it is told about.
5. Deprecate each version the holder published, with `npm login` and then
   `npm deprecate @tibia.sh/tibiawiki-data@X.Y.Z "<why>"`. npm never accepts the same version
   twice, so a bad one cannot be replaced, and deprecation warns everyone who installs it.

Then rotate it. Until the new token is stored, a drift run that finds a change fails in its `pr`
job and comments on the alert issue.

To rotate it:

1. Create a new token the same way: resource owner `tibia-sh`, repository access `tibiawiki-data`
   only, the permissions above, and no expiration.
2. Run `gh secret set DRIFT_TOKEN --env drift --repo tibia-sh/tibiawiki-data`. It prompts for the
   token, so it stays out of your shell history.
3. Revoke the old token.

The next drift run that finds a change uses the new token. To try it at once, run
`gh workflow run drift.yml --repo tibia-sh/tibiawiki-data --ref main`, which merges and publishes a
refresh when the wiki changed.

## When the drift job needs a look

A run of `drift.yml` on `main` that fails, or holds a refresh, comments on one issue, titled
`The drift job needs a look`, opened by `github-actions[bot]` and assigned to `drptbl`. An assignee
is notified of every comment whatever their watch settings. When no such issue is open, the run
opens it. Each comment links the run and says what happened:

| The comment says | What to do |
|---|---|
| `The build job failed.` | Open the run and read the red step. A tripped gate in `pnpm build-index`, a failing `pnpm test`, a wiki the build could not read, or `The guard could not compare the indexes.` each end it there, before anything is pushed. Fix the cause, or run drift again once the wiki is back. |
| `The pr job failed.` | Open the run and read the red step. `npm does not list X.Y.Z from package.json yet` means the release of the version on `main` is still running or failed, so follow [When a release run fails](#when-a-release-run-fails) and run drift again once npm has it. `was closed without merging` means someone closed the pull request. `has not merged 3600 seconds after auto-merge was on` means its checks failed or are still running: auto-merge stays on, so it merges by itself once they pass, for example after you re-run a check that failed for a reason outside the repository. `Bad credentials` from `gh` means the token expired or was revoked, so rotate it as [The drift token](#the-drift-token) describes. |
| `The refresh was held for review:` and its reasons | Follow the steps below. |

A held refresh has its reasons twice: in the comment, and at the top of the pull request's body,
under **Held for review.** Each reason names a table, such as `item lost 120 of 9,800 rows (1.2%)`,
`table quest is empty, it had 370 rows` or `table spell is missing`.

1. Read the reasons, and find out whether the wiki really lost those pages, or whether the
   generator or a bad week on the wiki dropped them.
2. When the refresh is right, merge the pull request by hand once its checks pass, with Rebase and
   merge, as the drift job would. The merge publishes it like any other.
3. When it is not, close the pull request and find the cause. While the cause lasts, every run that
   finds a change opens a new pull request, holds it and comments again.

You can also leave the pull request open and wait. A later run updates it, and when that run's
guard finds no reason to hold, it turns auto-merge on and the pull request merges by itself.

Close the issue once each comment is dealt with, and the next alert opens a new one.

The alert issue does not cover the release. Once a drift pull request merges, the `pr` job ends
green, and `release.yml` runs on the merge as on any push to `main`. When that run is red, GitHub
emails whoever pushed, which for a drift merge is the token's owner, as long as your notification
settings for Actions send email. [When a release run fails](#when-a-release-run-fails) says what
to do. While npm lacks that version, the next drift run that finds a change fails at
`Set version to the next patch npm does not have`, and that failure does comment on the alert
issue.

## Bumping the schema version

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
5. Create the GitHub release for `N.0.0` by hand, with the sequence in
   [The GitHub release](#the-github-release) and `commit` set to the commit step 4 merged, which
   is where that `index.db` landed on `main`. That merge publishes nothing, so the
   `github-release` job never runs for it, and without this step every new major would miss its
   release.

Do not merge a data refresh here between steps 2 and 4. `main` is still on N-1 then, and
npm refuses to publish a version below `N.0.0` without a dist-tag, so its release run
fails. The drift job merges a refresh by itself, so before step 2 run
`gh workflow disable drift.yml --repo tibia-sh/tibiawiki-data` and turn off auto-merge on an
open drift pull request, or close it. Once step 4 has merged, run
`gh workflow enable drift.yml --repo tibia-sh/tibiawiki-data`.

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
fails the next `pnpm dedupe`. pnpm 12.4.1 fails `update --no-save` with
`ERR_PNPM_STRICT_MIN_RELEASE_AGE_REQUIRES_SAVE` whenever `minimumReleaseAge` is set
([pnpm#14835](https://github.com/pnpm/pnpm/issues/14835)). Until `packageManager` names a
pnpm with the fix, run `pnpm update @tibia.sh/tibiawiki-data` without `--no-save`, restore
`^N` in the server's `package.json`, then run `pnpm install`. The lockfile moves and the range
stays.

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
