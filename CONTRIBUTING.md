# Contributing

Thanks for helping. This repository is a Claude Code plugin marketplace: `.claude-plugin/marketplace.json`
lists the plugins under `plugins/`, and each plugin is versioned and released on its own.

## Development setup

- **Node.js 22 or newer** on `PATH`. Every hook, script and test uses only Node built-ins.
- **git**.
- **Claude Code**, for `claude plugin validate` and for trying a plugin out.

There is no `package.json` and nothing to install: no `npm install`, no build step.

Try a plugin from your clone by adding the clone as a marketplace inside Claude Code:

```text
/plugin marketplace add /path/to/clone
/plugin install handover@tulgs61-plugins
```

## Checks

Run both before you open a pull request:

```bash
node scripts/verify.mjs
claude plugin validate --strict .
```

`scripts/verify.mjs` (also run by `.claude/verify.cmd`) does a leak scan, checks every JSON file and the
syntax of every JavaScript file, and runs all `*.test.*` files with `node --test`. It exits 0 when the
repository is clean and prints every problem it finds otherwise. `node scripts/verify.mjs --only <dir>`
runs only the tests under `<dir>`; the other checks still cover every file.

### Optional leak patterns

The leak scan has no built-in patterns. To catch strings that must never be committed (names, hosts,
paths, tokens of your own), put them in `.claude/private/leaks.txt`. The file is ignored by git and
never leaves your machine. Format, one pattern per line:

```text
# comments and blank lines are ignored
/Exact Case Name/        regex literal form: /source/flags (the g and y flags are dropped)
internal-host-\d+        bare source: compiled as a case-insensitive regex
```

A task worktree uses the main checkout's file unless it has its own. Without the file the leak scan is
skipped with a notice and the other checks still run. Findings name the pattern by its line number in
`leaks.txt`, never by its text.

## Pull requests

- One concern per pull request.
- Add or update tests under the plugin's `tests/` (or `tests/` at the root for marketplace checks).
- Update the plugin's `README.md` when behaviour changes.
- Add the change to the plugin's section in `CHANGELOG.md` when it will ship in a release.

## Release process

Each plugin has its own version, following [Semantic Versioning](https://semver.org/): a patch for
fixes, a minor version for new backward-compatible features, a major version for breaking changes.

1. Bump `version` in the plugin's `plugins/<name>/.claude-plugin/plugin.json` **and** in its entry in
   `.claude-plugin/marketplace.json`, to the same value. The tests fail when the two differ or when a
   version is not strict semver.
2. Add a `### [<version>] - YYYY-MM-DD` entry under the plugin's `## <name>` section in `CHANGELOG.md`
   ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format). The tests fail when the entry for
   the current version is missing.
3. Merge to `main`.

On every push to `main`, the [release workflow](.github/workflows/release.yml) checks each marketplace
entry. When the tag `<name>--v<version>` (the same convention as `claude plugin tag`) does not exist
yet, it creates that annotated tag, pushes it and publishes a GitHub release titled `<name> <version>`
whose notes are the plugin's CHANGELOG entry for that version. Versions that already have a tag are
skipped, so a merge that changes no version releases nothing. The workflow can also be started by hand
(`workflow_dispatch`).

Do not create release tags or GitHub releases by hand.

Installed users only receive an update when the plugin's `version` changes. A change merged without a
version bump stays invisible to them until the next release.
