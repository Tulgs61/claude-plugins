// Shared helpers for the click-loop tests. Not a test file itself.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'click-loop.mjs');

const children = new Set();

// Last-resort cleanup for a test file: kill whatever a test left running.
export function killAll() {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
}

export function run(args, { env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

export function runAsync(args, { env } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', c => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', c => (stderr += c));
    child.on('close', (status, signal) => {
      children.delete(child);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// A fresh loop dir from `init`, removed after the test.
export function initLoop(t) {
  const r = run(['init']);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
  const dir = r.stdout.trim();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function alive(child) {
  return child.exitCode === null && child.signalCode === null;
}

// Starts `serve` and resolves once the URL line is printed. The server is killed after the test.
export function startServer(t, dir, { args = [], env } = {}) {
  const child = spawn(process.execPath, [CLI, 'serve', '--dir', dir, ...args], { env: { ...process.env, ...env } });
  children.add(child);
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  exited.then(() => children.delete(child));
  t.after(async () => {
    if (alive(child)) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', c => (stderr += c));
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve printed no URL; stderr: ${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8').on('data', c => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const url = out.slice(0, nl).trim();
      resolve({ child, url, port: Number(new URL(url).port), exited, stderr: () => stderr });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`serve exited early; stderr: ${stderr}`));
    });
  });
}

// Raw HTTP request to 127.0.0.1:<port>: the path is sent as is and the Host header can be overridden.
export function request(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers, agent: false, timeout: 5000 },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export const readPicks = dir => {
  try {
    return fs.readFileSync(path.join(dir, 'picks.jsonl'), 'utf8');
  } catch {
    return '';
  }
};
