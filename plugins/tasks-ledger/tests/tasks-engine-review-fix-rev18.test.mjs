// Review fix rounds: a rejected review sends the task back to its implementer with the findings, up to
// two times, before it blocks. The reviewer runs on the task's reviewModel, else on its own model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, GOOD_REVIEW } from './helpers/relay.mjs';

const task = (id, extra = {}) => ({
  id,
  title: `task ${id}`,
  acceptance: `acceptance ${id}`,
  proof: 'true',
  budget: '5 turns',
  files: [`src/${id}/**`],
  dependsOn: [],
  status: 'todo',
  ...extra,
});

const reject = message => ({
  verdict: 'rejected',
  acceptance_met: false,
  scope_ok: true,
  constraints_ok: true,
  findings: [{ severity: 'high', file: 'src/T1/a.js', line: 7, message }],
  evidence: 'checked the diff',
});

// The `status ... T1 blocked ... reviewed` call the helper gets when a review-path block records the head.
const blockedReviewed = lines => lines.some(l => /^status \S+ T1 blocked .* reviewed$/.test(l));

// Answers the reviewer from `reviews` in order (the last one repeats) and records every call.
async function run(records, reviews, opts = {}) {
  const calls = [];
  let n = 0;
  const out = await runEngine(records, {
    ...opts,
    taskAgent: (prompt, options) => {
      const role = /^TASK: /.test(prompt) ? 'implementer' : 'reviewer';
      calls.push({ role, prompt, options });
      if (role === 'implementer') return 'done';
      return reviews[Math.min(n++, reviews.length - 1)];
    },
  });
  return { ...out, calls, impl: calls.filter(c => c.role === 'implementer'), rev: calls.filter(c => c.role === 'reviewer') };
}

test('a rejected review goes back to the implementer with the findings, then merges once verified', async () => {
  const { result, impl, rev, counts } = await run([task('T1')], [reject('the confirm sound is missing'), GOOD_REVIEW]);
  assert.equal(result.results.find(r => r.id === 'T1').status, 'merged');
  assert.equal(impl.length, 2);
  assert.equal(rev.length, 2);
  assert.doesNotMatch(impl[0].prompt, /REVIEW FINDINGS/);
  assert.match(impl[1].prompt, /REVIEW FINDINGS:/);
  assert.match(impl[1].prompt, /\[high\] \(src\/T1\/a\.js:7\) the confirm sound is missing/);
  assert.match(impl[1].prompt, /Verdict: rejected \(acceptance not met\)/);
  assert.equal(counts.verify, 2, 'the fix round is verified again before the re-review');
});

test('a task the reviewer keeps rejecting blocks after two fix rounds', async () => {
  const { result, impl, rev, opsLines } = await run([task('T1')], [reject('still wrong')]);
  const r = result.results.find(x => x.id === 'T1');
  assert.equal(r.status, 'blocked');
  assert.match(r.note, /^review rejected: still wrong/);
  assert.equal(rev.length, 3);
  assert.equal(impl.length, 3);
  assert.ok(blockedReviewed(opsLines), 'the block records the reviewed head');
});

test('needs_input blocks at once, without a fix round', async () => {
  const { result, impl, rev, opsLines } = await run([task('T1')], [{ ...reject('which colour?'), verdict: 'needs_input' }]);
  assert.equal(result.results.find(x => x.id === 'T1').status, 'blocked');
  assert.equal(impl.length, 1);
  assert.equal(rev.length, 1);
  assert.ok(blockedReviewed(opsLines));
});

test('an inconsistent "verified" (a high finding) also gets a fix round', async () => {
  const inconsistent = { ...GOOD_REVIEW, findings: [{ severity: 'high', message: 'off by one' }] };
  const { result, impl } = await run([task('T1')], [inconsistent, GOOD_REVIEW]);
  assert.equal(result.results.find(x => x.id === 'T1').status, 'merged');
  assert.equal(impl.length, 2);
  assert.match(impl[1].prompt, /off by one/);
});

test('the reviewer defaults to the task model, in every round', async () => {
  const { impl, rev } = await run([task('T1', { model: 'haiku' })], [reject('no'), GOOD_REVIEW]);
  for (const c of [...impl, ...rev]) assert.equal(c.options.model, 'haiku', `${c.role} runs on haiku`);
});

test('a reviewModel still wins over the task model', async () => {
  const { impl, rev } = await run([task('T1', { model: 'haiku', reviewModel: 'sonnet' })], [reject('no'), GOOD_REVIEW]);
  for (const c of impl) assert.equal(c.options.model, 'haiku');
  for (const c of rev) assert.equal(c.options.model, 'sonnet');
});

test('a fix round whose verification fails twice blocks with both reasons', async () => {
  const verify = (_id, n) => (n === 1 ? { ok: true, tail: 'ok' } : { ok: false, error: 'verify.cmd exited 1', tail: 'FAIL' });
  const { result, rev, opsLines } = await run([task('T1')], [reject('wrong')], { answers: { verify } });
  const r = result.results.find(x => x.id === 'T1');
  assert.equal(r.status, 'blocked');
  assert.match(r.note, /verification failed twice: verify\.cmd exited 1 \(fix round 1 after: review rejected: wrong\)/);
  assert.equal(rev.length, 1);
  assert.ok(blockedReviewed(opsLines), 'a failed fix round still records the rejected head');
});
