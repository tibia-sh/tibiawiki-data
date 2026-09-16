/**
 * Reading and running this repository's GitHub workflows from the test suite.
 *
 * A workflow cannot run inside the suite, so its tests read the files. Its scripts are the
 * exception: runStep runs one the way a runner does, against stand-in commands.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows', import.meta.url));

/** Every workflow in the repository, by file name. */
export const workflowFiles = (): string[] => readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

export const read = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

/**
 * A workflow without comments or blank lines. The prose in a comment names the very
 * things these tests look for, such as id-token: write, so a presence check against the
 * raw text would pass with the setting itself deleted. A YAML comment starts at a `#`
 * preceded by whitespace, and none of these workflows' values contain one.
 */
export const code = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '')
    .join('\n');

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, a key at the block's
 * shallowest indentation, or '' when there is none. A deeper key of the same name, such as
 * a job's own `permissions:`, does not count.
 */
export const under = (yaml: string, key: string): string => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  if (indents.length === 0) return '';
  const depth = Math.min(...indents);
  return new RegExp(`^ {${depth}}${key}:\\n((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml)?.[1] ?? '';
};

/** A scalar key's value at a block's shallowest indentation. */
export const scalar = (block: string, key: string): string | undefined => {
  const depth = Math.min(...block.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return new RegExp(`^ {${depth}}${key}: *(.*)$`, 'm').exec(block)?.[1];
};

/** The keys at a block's shallowest indentation, in order. */
export const keys = (yaml: string): string[] => {
  const lines = yaml.split('\n').filter((line) => line.trim() !== '');
  const depth = Math.min(...lines.map((line) => line.search(/\S/)));
  return lines.filter((line) => line.search(/\S/) === depth).map((line) => line.trim().replace(/:.*$/, ''));
};

/** A job's steps, one string per list item. */
export const steps = (job: string): string[] => {
  const block = under(job, 'steps');
  const marker = /^ *- /.exec(block)?.[0];
  return marker ? block.split(new RegExp(`^(?=${marker})`, 'm')) : [];
};

/** A step with its `- ` marker replaced by spaces, so its keys sit at one indentation for `under` and `scalar`. */
export const stepBody = (step: string): string => step.replace(/^( *)- /, '$1  ');

/**
 * The inputs under a step's `with:`, whichever of the step's keys sits on the `- ` line. The runner
 * takes an input whose key is quoted, capitalised or followed by a space before its colon, and
 * `scalar` finds none of those. So each input has to be a plain lowercase key, written once, or
 * the calling test fails, and a check that an input is absent cannot pass on a spelling it misses.
 */
export const stepInputs = (step: string): string => {
  const inputs = under(stepBody(step), 'with');
  const names = keys(inputs);
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${stepName(step)} has an input written in a form this test cannot read: ${name}`);
  }
  assert.equal(new Set(names).size, names.length, `${stepName(step)} sets an input more than once`);
  return inputs;
};

/** A step's `if:`, whether it is the first key on the `- ` line or a later one. */
export const stepIf = (step: string): string | undefined => /^ *(?:- +)?if: *(.*)$/m.exec(step)?.[1];

export const stepName = (step: string): string =>
  /^ *(?:- +)?(?:name|id|uses|run): *(.*)$/m.exec(step)?.[1] ?? step.trim();

/** The index of the one step among `list` whose id is `id`. */
export const stepIndex = (list: string[], id: string): number => {
  const matches = list.flatMap((step, index) => (new RegExp(`^ *(?:- +)?id: *${id}$`, 'm').test(step) ? [index] : []));
  assert.equal(matches.length, 1, `expected exactly one step with id: ${id}`);
  return matches[0]!;
};

/**
 * The `run: |` script of the one step in `yaml` whose id is `id`, as the runner receives
 * it: its lines from the raw workflow, comments included, with the block's indentation
 * removed.
 */
export const stepScript = (yaml: string, id: string): string => {
  const lines = yaml.split('\n');
  const idLines = lines.flatMap((line, index) => (new RegExp(`^ *(?:- +)?id: *${id}(?: +#.*)?$`).test(line) ? [index] : []));
  assert.equal(idLines.length, 1, `expected exactly one step with id: ${id}`);
  let start = idLines[0]!;
  while (start > 0 && !/^ *- /.test(lines[start]!)) start--;
  const item = lines[start]!.indexOf('-');
  const step = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= item) break;
    step.push(line);
  }
  const run = step.findIndex((line) => /^ *(?:- +)?run: *\|$/.test(line));
  assert.notEqual(run, -1, `the step with id: ${id} is not a run: | block`);
  const key = step[run]!.indexOf('run:');
  const body: string[] = [];
  for (const line of step.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= key) break;
    body.push(line);
  }
  const depth = Math.min(...body.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return `${body.map((line) => line.slice(depth)).join('\n')}\n`;
};

/**
 * Every `run:` script in the raw workflow text, block scalars included. Comments stay in,
 * because GitHub substitutes `${{ }}` inside a block scalar's comment lines too.
 */
export const runScripts = (yaml: string): string[] => {
  const lines = yaml.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^( *(?:- +)?)run:(.*)$/.exec(line);
    if (!match) return [];
    const script = [match[2]!];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= match[1]!.length) break;
      script.push(next);
    }
    return [script.join('\n')];
  });
};

/** One call a stand-in command received. */
export type Call = { command: string; args: string[] };

/**
 * Commands a step could reach the network or the repository with, and timeout, which runs
 * whatever command follows its bound. Unless a test stands in for one, a call to it fails,
 * so no test can publish, push or open a pull request for real.
 */
const GUARDED = ['npm', 'npx', 'pnpm', 'git', 'gh', 'curl', 'wget', 'timeout'];

/** The regular files under `root`, by path relative to it, as text. Symlinks are left out. */
const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => lstatSync(join(root, name)).isFile())
      .sort()
      .map((name) => [name, readFileSync(join(root, name), 'utf8')]),
  );

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

let launcherFile: string | undefined;

/**
 * The one executable every stand-in command runs through, made once per process: it runs
 * the JavaScript in STEP_FAKES named after the link it was started through. macOS scans a
 * new executable for about a third of a second the first time it runs, measured, while a
 * symlink to one it has already run starts at once. The JavaScript is a .cjs file, because
 * Node reads an extensionless file as an ES module under a "type": "module" package.json.
 */
const launcher = (): string => {
  if (launcherFile === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-launcher-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    launcherFile = join(dir, 'launcher');
    writeFileSync(launcherFile, `#!/bin/sh\nexec ${quote(process.execPath)} "$STEP_FAKES/\${0##*/}.cjs" "$@"\n`);
    chmodSync(launcherFile, 0o755);
  }
  return launcherFile;
};

/**
 * Runs `script` the way a runner does: `bash -e`, from a checkout holding `files`, with
 * GITHUB_OUTPUT set and RUNNER_TEMP holding `runnerTemp`. Each entry of `commands` is
 * JavaScript that node runs as that command, after recording its arguments. A name without
 * a slash lands first on PATH, and a path lands in the checkout. The result carries both
 * directories' files as the script left them. Everything is removed afterwards.
 */
export function runStep(
  script: string,
  { files = {}, runnerTemp = {}, commands = {}, env = {} }: {
    files?: Record<string, string>;
    runnerTemp?: Record<string, string>;
    commands?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tibiawiki-data-step-'));
  try {
    const checkout = join(dir, 'checkout');
    const bin = join(dir, 'bin');
    const temp = join(dir, 'runner-temp');
    for (const path of [checkout, bin, temp]) mkdirSync(path);
    const put = (path: string, content: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    for (const [name, content] of Object.entries(files)) put(join(checkout, name), content);
    for (const [name, content] of Object.entries(runnerTemp)) put(join(temp, name), content);

    const log = join(dir, 'calls.jsonl');
    const fakes = join(dir, 'fakes');
    const refuse = "process.stderr.write('this test does not stand in for this command\\n');\nprocess.exitCode = 99;\n";
    const stand = { ...Object.fromEntries(GUARDED.map((name) => [name, refuse])), ...commands };
    const names = Object.keys(stand).map((name) => basename(name));
    assert.equal(new Set(names).size, names.length, `two stand-in commands share a file name: ${names.join(', ')}`);
    for (const [name, source] of Object.entries(stand)) {
      put(join(fakes, `${basename(name)}.cjs`),
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, ` +
          `JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n');\n` +
          source);
      const path = name.includes('/') ? join(checkout, name) : join(bin, name);
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(launcher(), path);
    }

    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'step.sh'), script);
    const run = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      cwd: checkout,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: temp,
        ...env,
        STEP_FAKES: fakes,
      },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Call);
    return {
      status: run.status,
      output: readFileSync(output, 'utf8'),
      calls,
      checkout: snapshot(checkout),
      runnerTemp: snapshot(temp),
      log: `${run.stdout}${run.stderr}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
