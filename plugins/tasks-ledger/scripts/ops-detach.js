#!/usr/bin/env node
// Runs a long tasks-git.js command (verify, merge: often 30+ minutes) detached from the calling shell, so the
// Bash tool's 10-minute limit cannot kill it half-way, and waits for it in slices shorter than that limit.
//   node ops-detach.js start <out> <script> [args...]  runs `node <script> args...` detached; stdout and stderr go
//                                                      to <out>, <out>.done holds its exit code once it ends
//   node ops-detach.js wait <out>                      waits up to 9 minutes; prints <out> when done, else PENDING
// While the command runs, its runner touches <out>.beat every few seconds. A `start` while that heartbeat is fresh
// prints RUNNING and starts nothing, so a retried ops agent never runs a merge twice at once. `wait` prints
// NOT RUNNING when there is neither a result nor a fresh heartbeat (the runner died, or `start` never ran), and it
// consumes a result it prints, so an answer is never handed out twice or to a later call.
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const WAIT_MS = 9 * 60 * 1000;
const POLL_MS = 5000;
const BEAT_MS = 5000;
// A heartbeat older than this means the runner is gone (machine restart, killed process).
const STALE_MS = 60 * 1000;

const [mode, out, ...rest] = process.argv.slice(2);
if (!out || (mode !== 'start' && mode !== 'wait') || (mode === 'start' && !rest.length)) {
  console.log('usage: ops-detach.js start <out> <script> [args...] | wait <out>');
  process.exit(1);
}
const done = `${out}.done`;
const beat = `${out}.beat`;

function beating() {
  try {
    return Date.now() - fs.statSync(beat).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

if (mode === 'start') {
  if (!fs.existsSync(done) && beating()) {
    console.log('RUNNING');
    process.exit(0);
  }
  for (const f of [out, done, beat]) fs.rmSync(f, { force: true });
  fs.writeFileSync(out, '');
  fs.writeFileSync(beat, '');
  // A small node parent, detached from this shell, opens <out> itself (file descriptors are not inherited by
  // number on Windows), runs the command, keeps the heartbeat fresh and writes the marker when it exits.
  const runner = [
    "const fs=require('node:fs');",
    `const fd=fs.openSync(${JSON.stringify(out)},'a');`,
    `const touch=()=>{try{const t=new Date();fs.utimesSync(${JSON.stringify(beat)},t,t);}catch{}};`,
    `const timer=setInterval(touch,${BEAT_MS});`,
    `const end=code=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},String(code));};`,
    `const c=require('node:child_process').spawn(process.execPath,${JSON.stringify(rest)},{stdio:['ignore',fd,fd],windowsHide:true});`,
    "c.on('error',e=>{fs.writeSync(fd,String(e)+'\\n');end('error');});",
    "c.on('exit',code=>end(code));",
  ].join('');
  const child = spawn(process.execPath, ['-e', runner], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  console.log(`STARTED ${child.pid}`);
  process.exit(0);
}

const deadline = Date.now() + WAIT_MS;
let recheck = false;
(function poll() {
  if (fs.existsSync(done)) {
    const text = fs.readFileSync(out, 'utf8');
    for (const f of [out, done, beat]) fs.rmSync(f, { force: true });
    process.stdout.write(text);
    return;
  }
  if (!beating() && !recheck) {
    // After a machine sleep the runner needs a moment to touch the heartbeat again: look once more.
    recheck = true;
    setTimeout(poll, BEAT_MS * 2);
    return;
  }
  if (!beating()) {
    console.log('NOT RUNNING');
    return;
  }
  recheck = false;
  if (Date.now() > deadline) {
    console.log('PENDING');
    return;
  }
  setTimeout(poll, POLL_MS);
})();
