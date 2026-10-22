// Test helper for the relay check on helper answers. The check is computed here independently of
// the scripts under test: standard FNV-1a 32-bit over the UTF-16LE bytes of the canonical text,
// through Buffer, where the scripts hash code units by hand.
import { Buffer } from 'node:buffer';

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
