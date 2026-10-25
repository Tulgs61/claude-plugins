#!/usr/bin/env node
// Stand-in for the gh / glab CLI in the tasks-git tests (TASKS_GIT_GH / TASKS_GIT_GLAB point here).
// Appends its arguments as one JSON line to $FAKE_GH_LOG and prints a PR (or MR) URL numbered by
// the call count. FAKE_GH_FAIL=1 makes it exit 1 without a URL. `pr view` / `mr view` print the
// request's state as JSON instead: FAKE_GH_STATE (merged, open or closed; default merged) and the
// head sha FAKE_GH_HEAD, unless FAKE_GH_REQUESTS (JSON: URL -> { state, head }) names the request.
// Never touches the network.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
if (!log) {
  process.stderr.write('fake-gh: FAKE_GH_LOG is not set\n');
  process.exit(2);
}
const n = (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0) + 1;
appendFileSync(log, JSON.stringify(args) + '\n');
if (process.env.FAKE_GH_FAIL === '1') {
  process.stderr.write('fake-gh: failing on request\n');
  process.exit(1);
}
if (args[1] === 'view') {
  const own = JSON.parse(process.env.FAKE_GH_REQUESTS || '{}')[args[2]] || {};
  const state = own.state || process.env.FAKE_GH_STATE || 'merged';
  const head = own.head || process.env.FAKE_GH_HEAD || '';
  const answer = args[0] === 'mr'
    ? { state: state === 'open' ? 'opened' : state, sha: head }
    : { state: state.toUpperCase(), headRefOid: head };
  process.stdout.write(JSON.stringify(answer) + '\n');
  process.exit(0);
}
const url = args[0] === 'mr' ? `https://forge.example/o/r/-/merge_requests/${n}` : `https://forge.example/o/r/pull/${n}`;
process.stdout.write(url + '\n');
