#!/usr/bin/env node
// Stand-in for the gh / glab CLI in the tasks-git tests (TASKS_GIT_GH / TASKS_GIT_GLAB point here).
// Appends its arguments as one JSON line to $FAKE_GH_LOG and prints a PR (or MR) URL numbered by
// the call count. FAKE_GH_FAIL=1 makes it exit 1 without a URL. Never touches the network.
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
const url = args[0] === 'mr' ? `https://forge.example/o/r/-/merge_requests/${n}` : `https://forge.example/o/r/pull/${n}`;
process.stdout.write(url + '\n');
