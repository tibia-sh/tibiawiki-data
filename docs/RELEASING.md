# Releasing

A push to `main` publishes the `version` in `package.json`, after `pnpm test`, when npm does not list that version yet. Nothing is tagged. [Releases](../README.md#releases) in the README has the details.

## When a release run fails

A failed run leaves nothing stranded. `main` holds a version npm does not have, and the next release run tries it again.

| Cause | What to do |
|---|---|
| Something in the repository, such as a failing test | Fix it in a pull request and merge. The merge's run publishes. |
| Something outside it: npm was down, or the trusted publisher on npmjs.com does not match and `npm publish` failed with `ENEEDAUTH` | Fix that, then re-run the most recent release run. |
| npm lists the version although the run failed | Nothing. The publish went through, and the next run publishes nothing. |

Never re-run a release run expecting a different result when nothing outside the repository changed.

npm never accepts the same version twice, even after an unpublish, per its [unpublish policy](https://docs.npmjs.com/policies/unpublish). To replace a published version, bump to the next patch. An unpublished version needs the same bump. npm keeps refusing it, although `npm view` no longer lists it.

## Runs close together

Two version bumps merged close together can run in either order, because GitHub does not guarantee the order of waiting runs. When the lower version runs last, npm 12 refuses it with [`Cannot implicitly apply the "latest" tag`](https://github.com/npm/cli/blob/v12.0.2/lib/commands/publish.js#L185), as long as the higher version is neither deprecated nor a prerelease. Nothing needs doing, and that version number is skipped.

That refusal also needs the run to read the higher version from the registry. A run whose read misses it can publish the lower version instead, and move `latest` back to it. After two close bumps, check that `npm view @tibia.sh/tibiawiki-data dist-tags.latest` prints the higher version. If it does not, and the higher version is not deprecated, point `latest` at it, with `X.Y.Z` as the higher version:

```bash
npm login
npm dist-tag add @tibia.sh/tibiawiki-data@X.Y.Z latest
```

A push right after a publish can also read a version list from before that publish. Its run then tries to publish the same version again, and fails when npm refuses a version it already has. Nothing needs doing. A later run reads the new list and publishes nothing.

## Schema bumps

A schema bump publishes one release by hand, outside this workflow. Follow [Bumping the schema version](../README.md#bumping-the-schema-version).
