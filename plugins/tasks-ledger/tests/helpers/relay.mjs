// Test helper for the relay check on helper answers. The check is computed here independently of
// the scripts under test: standard FNV-1a 32-bit over the UTF-16LE bytes of the canonical text,
// through Buffer, where the scripts hash code units by hand.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Number((BigInt((h ^ byte) >>> 0) * 0x01000193n) & 0xffffffffn);
  return h.toString(16).padStart(8, '0');
}

// The check fields of `payload`: the length of its canonical text and the hash of that text.
export function checkOf(payload) {
  const canonical = JSON.stringify(payload);
  return { len: canonical.length, sum: fnv1a32(Buffer.from(canonical, 'utf16le')) };
}

// The answer line the helper prints for `payload`.
export const sealed = payload => JSON.stringify({ ...payload, ...checkOf(payload) });

const filled = value => typeof value === 'string' && value.trim() !== '';
const SUMMARY_KEYS = ['id', 'status', 'dependsOn', 'files', 'branch', 'base', 'worktree', 'pr', 'resumeVerified'];

// The scheduling summary the helper lists for a task: no title, acceptance, proof, budget or
// constraints, and `needsAcceptance` also true for a title-only task without proof or budget.
export function summaryOf(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return t;
  const o = {};
  for (const k of SUMMARY_KEYS) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
  o.needsAcceptance = t.needsAcceptance === true || (!filled(t.acceptance) && (!filled(t.proof) || !filled(t.budget)));
  return o;
}

// A fake helper relay for engine tests: `reply(op, id, answer)` is what an ops agent hands back.
// Tasks listed in an answer are kept as full records and listed as summaries, the way the helper
// lists them; a plain `{ ok: true }` answer to `task <id>` becomes that task's record.
export function fakeRelay() {
  const records = new Map();
  const listed = tasks =>
    tasks.map(t => {
      if (t && typeof t === 'object' && typeof t.id === 'string' && !records.has(t.id)) records.set(t.id, t);
      return summaryOf(t);
    });
  return (op, id, answer) => {
    let a = answer;
    if (op === 'task' && a && a.ok === true && !Object.prototype.hasOwnProperty.call(a, 'task')) {
      a = records.has(id) ? { ok: true, task: { ...records.get(id) } } : { ok: false, error: `no task ${id}` };
    }
    if (a && Array.isArray(a.tasks)) a = { ...a, tasks: listed(a.tasks) };
    return { stdout: sealed(a) };
  };
}

// The engine run against a fake helper, shared by the relay tests. The engine path is resolved here,
// not imported from git-sandbox.mjs, which imports this file.
const ENGINE = fileURLToPath(new URL('../../workflows/tasks-engine.js', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');
const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `records` are the ledger tasks: prepare lists their summary
// and `task <id>` returns the record. `answers` overrides the payload per subcommand (a function of
// the parts after the ledger path and of the call count). `relay(op, n, line)` turns the sealed
// answer line of the n-th call of `op` into the stdout the ops agent hands back (default: as is).
export async function runEngine(records, { answers = {}, relay = (_op, _n, line) => line } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const opsLines = [];
  const prompts = [];
  const logs = [];
  const counts = {};
  const byId = new Map(records.map(r => [r.id, r]));
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: records.map(summaryOf) }),
    task: id => (byId.has(id) ? { ok: true, task: byId.get(id) } : { ok: false, error: `no task ${id}` }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    finish: () => ({ ok: true, runStatus: 'finished', tasks: records.map(summaryOf) }),
    ...answers,
  };
  const agent = async (prompt, options) => {
    if (options.agentType !== undefined) {
      prompts.push(prompt);
      return /^TASK: /.test(prompt) ? 'done' : GOOD_REVIEW;
    }
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    counts[op] = (counts[op] || 0) + 1;
    const payload = canned[op] ? canned[op](...rest, counts[op]) : { ok: true };
    return { stdout: relay(op, counts[op], sealed(payload), payload) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  const result = await run(args, agent, () => {}, message => logs.push(message));
  return { result, opsLines, prompts, logs, counts };
}
