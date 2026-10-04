#!/usr/bin/env node
// PreToolUse hook on Agent: an implementer agent is only launched when its prompt carries a PROOF
// and a BUDGET section. Exit 2 blocks (stderr goes to Claude), exit 0 lets the call proceed.
// Fails open: unparseable input or any internal error exits 0.
'use strict';

const fs = require('node:fs');

const GUARDED = new Set(['implementer', 'task-implementer']);

// Leading markdown markup: whitespace, heading/quote/emphasis/code markers, list bullets and
// numbered-list markers such as "1." or "2)".
const LEADING_MARKUP = /^(?:[\s#>*_`~+-]|\d+[.)])*/;

// True when some line of `prompt` labels a section named `word`: after the leading markup the line
// starts with the word, followed by ":" or the end of the line, optionally with "**" in between.
function hasSection(prompt, word) {
  const label = new RegExp(`^${word}(?:\\*\\*)?(?::|$)`, 'i');
  return prompt.split(/\r?\n/).some(line => label.test(line.replace(LEADING_MARKUP, '').trimEnd()));
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (!input || typeof input !== 'object') return 0;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return 0;
  const type = toolInput.subagent_type;
  if (typeof type !== 'string' || !GUARDED.has(type.split(':').pop())) return 0;

  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  const missing = ['PROOF', 'BUDGET'].filter(word => !hasSection(prompt, word));
  if (missing.length === 0) return 0;

  const what = missing.map(word => `no ${word}`).join(' and ');
  process.stderr.write(
    `Blocked dispatch to ${type}: the prompt has ${what}. ` +
    'An implementer prompt needs a PROOF section (the command that proves the work) and a BUDGET ' +
    'section (when to stop and report). Use the tasks-ledger dispatch skill ' +
    '(/tasks-ledger:dispatch) to render the full contract.\n',
  );
  return 2;
}

let code = 0;
try {
  code = main();
} catch {
  code = 0;
}
process.exitCode = code;
