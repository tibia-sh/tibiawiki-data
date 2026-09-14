# Releasing

A push to `main` publishes the `version` in `package.json`, after the `oldest-consumer` gate and `pnpm test`, when npm does not list that version yet. Nothing is tagged. [Releases](../README.md#releases) in the README has the details.

## When a release run fails

A failed run leaves nothing stranded. `main` holds a version npm does not have, and the next release run tries it again.

| Cause | What to do |
|---|---|
| Something in the repository, such as a failing test | Fix it in a pull request and merge. The merge's run publishes. |
| Something outside it: npm was down, or the trusted publisher on npmjs.com does not match and `npm publish` failed with `ENEEDAUTH` | Fix that, then re-run the most recent release run. |
| npm lists the version although the run failed | Nothing. The publish went through, and the next run publishes nothing. |

Never re-run a release run expecting a different result when nothing outside the repository changed.

npm never accepts the same version twice, even after an unpublish, per its [unpublish policy](https://docs.npmjs.com/policies/unpublish). To replace a published version, bump to the next patch. An unpublished version needs the same bump. npm keeps refusing it, although `npm view` no longer lists it.

## When the oldest-consumer job fails

The release job waits for `oldest-consumer`, so a red gate blocks the publish. The gate installs the oldest and the newest published servers that depend on `^N`, each together with the packed index, and pages every item through each. When one server is both, the gate sweeps it once. Its log ends with a `FAIL` line, and the lines under it name the case. When the case happened in one consumer, the first of them names that consumer, such as `The newest consumer, @tibia.sh/tibiawiki-mcp@0.4.0, failed.` Look up the message after it:

| The log under `FAIL` says | Cause | What to do |
|---|---|---|
| `is an error, so the server could not serve it`, `came from an index generated at`, `matching items, but the index holds`, `came back on page`, `distinct items, but the index holds`, `the sweep returned no items` or `is not in the shape the gate reads` | The sweep failed | A published `^N` server breaks on this index, so do not publish it as `N.x`. Fix the index or the generator, or treat the change as a new major under [Bumping the schema version](../README.md#bumping-the-schema-version). |
| `The sweep did not finish within` or `Request timed out` | The sweep timed out | Re-run the run once. When the same commit times out a second time, treat it as a failed sweep. |
| `npm installed`, `resolves @tibia.sh/tibiawiki-data/index.db to`, `holds @tibia.sh/tibiawiki-data@`, `DB_PATH is` or `is not defined by "exports"` | An install check failed | The install did not come out the way a user gets it, for example because of the candidate's `exports` map or its `DB_PATH`. Fix the package shape, not the index. |
| `No published @tibia.sh/tibiawiki-mcp depends on a range that` | No consumer | The candidate is a new major, and no published server depends on it yet. Follow the schema-bump procedure, [Bumping the schema version](../README.md#bumping-the-schema-version). |
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

## Schema bumps

A schema bump publishes one release by hand, outside this workflow. That release has no trusted publisher, so pnpm refuses it in both repositories until each excludes it from its trust policy. Follow [Bumping the schema version](../README.md#bumping-the-schema-version).
