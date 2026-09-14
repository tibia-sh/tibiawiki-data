import { test } from 'node:test';
import assert from 'node:assert/strict';
import { code, keys, read, scalar, steps, under } from './workflow.ts';

/**
 * ci.yml runs on every pull request, so its oldest-consumer job shows a failing gate before the
 * merge, rather than in the release run after it. The checks across every workflow, in
 * release-workflow.test.ts, cover the job's pins, its pnpm/setup inputs and its store cache.
 */

const jobs = (): string => under(code(read('ci.yml')), 'jobs');

const gateJob = (): string => under(jobs(), 'oldest-consumer');

test('ci.yml has an oldest-consumer job beside the test job', () => {
  assert.ok(keys(jobs()).includes('test'), 'ci.yml has no test job');
  assert.ok(keys(jobs()).includes('oldest-consumer'), 'ci.yml has no oldest-consumer job');
});

test('the ci.yml oldest-consumer job holds exactly contents: read, and no id-token', () => {
  // It runs a published server over the index, and publishes nothing.
  const permissions = under(gateJob(), 'permissions');
  assert.deepEqual(keys(permissions), ['contents'], 'the oldest-consumer job does not hold exactly one permission, contents');
  assert.equal(scalar(permissions, 'contents'), 'read', 'the oldest-consumer job holds more than contents: read');
  assert.doesNotMatch(gateJob(), /\bid-token\b/, 'the oldest-consumer job can mint an OIDC token');
});

test('the ci.yml oldest-consumer job runs pnpm oldest-consumer unconditionally, bounded at 45 minutes', () => {
  // A condition or continue-on-error on the job or on one of its steps can hide a failed or
  // skipped sweep. The script's own bounds add up to 2190 s with two consumers, and the rest of
  // the 45 minutes is checkout and setup.
  assert.ok(steps(gateJob()).some((step) => /^ *(?:- +)?run: *pnpm oldest-consumer$/m.test(step)),
    'the oldest-consumer job never runs pnpm oldest-consumer');
  assert.doesNotMatch(gateJob(), /^ *(?:- +)?(?:if|continue-on-error):/m,
    'the oldest-consumer job or one of its steps has a condition or continue-on-error');
  assert.equal(scalar(gateJob(), 'timeout-minutes'), '45', 'the oldest-consumer job is not bounded at 45 minutes');
});
