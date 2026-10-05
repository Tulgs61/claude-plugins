# Security policy

## Supported versions

Only the latest released version of each plugin (`handover`, `tasks-ledger`, `mockup-loop`) receives
security fixes. The current versions are listed in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)
and in [`CHANGELOG.md`](CHANGELOG.md). Update to the latest version before you report a problem.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the
[Security tab](https://github.com/Tulgs61/claude-plugins/security) of this repository and choose
**Report a vulnerability**.

**Do not open a public issue, pull request or discussion for a vulnerability.**

Include, as far as you can:

- the affected plugin and version;
- what an attacker can do and under which conditions;
- steps to reproduce, or a minimal proof of concept;
- your Claude Code version, operating system and Node.js version.

You will get an answer in the private advisory. A confirmed vulnerability is fixed in a new release of the
affected plugin, and the advisory is published once the fix is out.

## Scope

In scope: the hooks, scripts, skills, agents and workflows in `plugins/`, the release tooling in
`.github/`, and `scripts/verify.mjs`. The security notes in the [README](README.md#security-notes)
describe what the plugins run and what they never do; a way around one of those guarantees is in scope.

Out of scope: Claude Code itself (report those to its maintainers), and the effects of a
`.claude/verify.cmd` or other project file you chose to run.
