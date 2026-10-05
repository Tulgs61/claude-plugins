#!/usr/bin/env node
// Prints the CHANGELOG.md entry of one plugin version: the body of `### [<version>]` under `## <name>`.
// Used by .github/workflows/release.yml for the release notes and by tests/marketplace.test.mjs.
// Usage: node .github/scripts/changelog-section.mjs <name> <version> [changelog path]
// Exit 1 with a message on stderr when the entry is missing or empty. Node built-ins only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns the trimmed body of the entry, '' when the entry exists but is empty, or null when it is missing.
export function changelogSection(text, name, version) {
  const lines = text.split(/\r?\n/);
  const pluginHead = new RegExp(`^## ${escape(name)}\\s*$`);
  const versionHead = new RegExp(`^### \\[${escape(version)}\\](\\s|$)`);
  let inPlugin = false;
  let body = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (body !== null) break;
      inPlugin = pluginHead.test(line);
      continue;
    }
    if (!inPlugin) continue;
    if (/^### /.test(line)) {
      if (body !== null) break;
      if (versionHead.test(line)) body = [];
      continue;
    }
    if (body !== null) body.push(line);
  }
  return body === null ? null : body.join('\n').trim();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [name, version, file] = process.argv.slice(2);
  if (!name || !version) {
    console.error('usage: changelog-section.mjs <name> <version> [changelog path]');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const text = readFileSync(file || path.join(root, 'CHANGELOG.md'), 'utf8');
  const section = changelogSection(text, name, version);
  if (!section) {
    console.error(`CHANGELOG.md has no ${section === null ? '' : 'non-empty '}### [${version}] entry under ## ${name}`);
    process.exit(1);
  }
  console.log(section);
}
