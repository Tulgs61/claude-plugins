// Preload for the process under test (node --require <this file>), rev 10 amendments 22 and 26.
// - With TASKS_LEDGER_TEST_FOREIGN_FILE set (only the tests set it), only that file looks owned by another
//   user: lstatSync, statSync and fstatSync (on a descriptor opened for that path) report a different uid
//   for it, and for nothing else.
// - Without it, process.getuid() returns a uid other than the real one, so every file the test created
//   as the real user looks owned by another user.
// Lets the foreign-owner tests run without root.
'use strict';

if (typeof process.getuid === 'function') {
  const otherUid = process.getuid() + 1;
  const target = process.env.TASKS_LEDGER_TEST_FOREIGN_FILE;
  if (target) {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.resolve(target);
    const isTarget = p => (typeof p === 'string' || Buffer.isBuffer(p)) && path.resolve(String(p)) === file;
    const foreign = st => {
      if (st) st.uid = typeof st.uid === 'bigint' ? BigInt(otherUid) : otherUid;
      return st;
    };
    const fds = new Set();
    const { lstatSync, statSync, fstatSync, openSync, closeSync } = fs;
    fs.lstatSync = function (p, ...rest) {
      const st = lstatSync.call(this, p, ...rest);
      return isTarget(p) ? foreign(st) : st;
    };
    fs.statSync = function (p, ...rest) {
      const st = statSync.call(this, p, ...rest);
      return isTarget(p) ? foreign(st) : st;
    };
    fs.openSync = function (p, ...rest) {
      const fd = openSync.call(this, p, ...rest);
      if (isTarget(p)) fds.add(fd);
      else fds.delete(fd);
      return fd;
    };
    fs.closeSync = function (fd, ...rest) {
      fds.delete(fd);
      return closeSync.call(this, fd, ...rest);
    };
    fs.fstatSync = function (fd, ...rest) {
      const st = fstatSync.call(this, fd, ...rest);
      return fds.has(fd) ? foreign(st) : st;
    };
  } else {
    process.getuid = () => otherUid;
  }
}
