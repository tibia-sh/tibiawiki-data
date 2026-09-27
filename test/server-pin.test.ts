import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decidePin } from '../scripts/server-pin.ts';

/**
 * Which server the drift job builds with decides what it publishes, so the decision is pinned here: decidePin on
 * version literals, and the command the way the drift workflow runs it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'server-pin.ts');

const run = (args: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('a dispatched version above the pin moves the pin to it, whatever npm lists as latest', () => {
  assert.deepEqual(decidePin('0.14.1', '0.15.0', '0.14.1'), { target: '0.15.0', action: 'move' });
  // The dispatch wins over a latest that is newer still.
  assert.deepEqual(decidePin('0.14.1', '0.15.0', '0.16.0'), { target: '0.15.0', action: 'move' });
});

test('a dispatched version below the pin is refused, and the pin stays', () => {
  assert.deepEqual(decidePin('0.15.0', '0.14.1', '0.15.0'), { target: '0.15.0', action: 'refuse' });
  // Numbers, not strings: 0.9.0 is below 0.10.0.
  assert.deepEqual(decidePin('0.10.0', '0.9.0', '0.10.0'), { target: '0.10.0', action: 'refuse' });
});

test('a dispatched version equal to the pin keeps it', () => {
  assert.deepEqual(decidePin('0.14.1', '0.14.1', '0.14.1'), { target: '0.14.1', action: 'keep' });
});

test('without a dispatch, the pin moves to latest only when latest is above it', () => {
  assert.deepEqual(decidePin('0.14.1', null, '0.14.1'), { target: '0.14.1', action: 'keep' });
  assert.deepEqual(decidePin('0.14.1', null, '0.14.2'), { target: '0.14.2', action: 'move' });
  assert.deepEqual(decidePin('0.9.9', null, '0.10.0'), { target: '0.10.0', action: 'move' });
  // A latest below the pin, such as one a dist-tag moved back, never moves it down.
  assert.deepEqual(decidePin('0.14.1', null, '0.14.0'), { target: '0.14.1', action: 'keep' });
});

test('decidePin throws on a version that is not x.y.z', () => {
  for (const bad of ['', '0.14', '0.14.1-rc.1', 'v0.14.1', '0.14.1\n', ' 0.14.1', '0.14.x']) {
    assert.throws(() => decidePin(bad, null, '0.14.1'), /not an x\.y\.z version/, `current ${JSON.stringify(bad)}`);
    assert.throws(() => decidePin('0.14.1', bad, '0.14.1'), /not an x\.y\.z version/, `requested ${JSON.stringify(bad)}`);
    assert.throws(() => decidePin('0.14.1', null, bad), /not an x\.y\.z version/, `latest ${JSON.stringify(bad)}`);
  }
});

test('the command prints the action and the target on one line', () => {
  const cases: Array<[string[], string]> = [
    [['0.14.1', '0.14.1'], 'keep 0.14.1\n'],
    [['0.14.1', '0.14.2'], 'move 0.14.2\n'],
    [['0.14.1', '0.14.1', '0.15.0'], 'move 0.15.0\n'],
    [['0.15.0', '0.15.0', '0.14.1'], 'refuse 0.15.0\n'],
  ];
  for (const [args, stdout] of cases) {
    const result = run(args);
    assert.equal(result.status, 0, `${JSON.stringify(args)}\n${result.stderr}`);
    assert.equal(result.stdout, stdout, JSON.stringify(args));
    assert.equal(result.stderr, '');
  }
});

test('the command exits 1, printing nothing, on a version that is not x.y.z', () => {
  for (const args of [['0.14.1', ''], ['0.14.1', '0.14.1', '0.15.0; echo'], ['latest', '0.14.1']]) {
    const result = run(args);
    assert.equal(result.status, 1, `${JSON.stringify(args)} did not exit 1\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not an x\.y\.z version/);
  }
});

test('a wrong argument count prints the usage and exits 2', () => {
  for (const args of [[], ['0.14.1'], ['0.14.1', '0.14.1', '0.14.1', '0.14.1']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} did not exit 2\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node scripts\/server-pin\.ts <current> <latest> \[<requested>\]/);
  }
});
