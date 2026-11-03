#!/usr/bin/env node
// Runs a long tasks-git.js command (verify, merge: often 30+ minutes) detached from the calling shell, so the
// Bash tool's 10-minute limit cannot kill it half-way, and waits for it in slices shorter than that limit.
//   node ops-detach.js start <out> <script> [args...]  runs `node <script> args...` detached; stdout and stderr go
//                                                      to <out>, <out>.done holds its exit code once it ends
//   node ops-detach.js wait <out>                      waits up to 9 minutes; prints <out> when done, else PENDING
// A `start` while the same <out> still has a live run prints RUNNING and starts nothing, so an ops agent that is
// retried never runs a merge twice at once.
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const WAIT_MS = 9 * 60 * 1000;
const POLL_MS = 5000;

const [mode, out, ...rest] = process.argv.slice(2);
if (!out || (mode !== 'start' && mode !== 'wait') || (mode === 'start' && !rest.length)) {
  console.log('usage: ops-detach.js start <out> <script> [args...] | wait <out>');
  process.exit(1);
}
const done = `${out}.done`;
const pidFile = `${out}.pid`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

if (mode === 'start') {
  const pid = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '', 10);
  if (!fs.existsSync(done) && Number.isInteger(pid) && pid > 0 && alive(pid)) {
    console.log(`RUNNING ${pid}`);
    process.exit(0);
  }
  for (const f of [out, done, pidFile]) fs.rmSync(f, { force: true });
  fs.writeFileSync(out, '');
  // A small node parent, detached from this shell, opens <out> itself (file descriptors are not inherited by
  // number on Windows), runs the command and writes the marker when it exits.
  const runner = [
    "const fs=require('node:fs');",
    `const fd=fs.openSync(${JSON.stringify(out)},'a');`,
    `const c=require('node:child_process').spawn(process.execPath,${JSON.stringify(rest)},{stdio:['ignore',fd,fd],windowsHide:true});`,
    `c.on('error',e=>{fs.writeSync(fd,String(e)+'\\n');fs.writeFileSync(${JSON.stringify(done)},'error');});`,
    `c.on('exit',code=>fs.writeFileSync(${JSON.stringify(done)},String(code)));`,
  ].join('');
  const child = spawn(process.execPath, ['-e', runner], { detached: true, stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  console.log(`STARTED ${child.pid}`);
  process.exit(0);
}

const deadline = Date.now() + WAIT_MS;
(function poll() {
  if (fs.existsSync(done)) {
    process.stdout.write(fs.readFileSync(out, 'utf8'));
    return;
  }
  if (Date.now() > deadline) {
    console.log('PENDING');
    return;
  }
  setTimeout(poll, POLL_MS);
})();
