# mockup-loop

Pick UI variants by clicking. For a visual decision with several plausible variants, Claude renders all of
them side by side in one local page, you click the one that fits, Claude builds the next round from your
pick, the page reloads itself, and the loop repeats until the design fits. Then Claude implements it 1:1 in
your project.

| Component | What it does |
|---|---|
| `/mockup-loop:click-loop [what to design]` | The skill. Runs the loop: writes the variants page, starts the local server and a waiter in background mode, reads your pick, writes the next round, and at the end implements the chosen design and cleans up. Claude also invokes it on phrases such as "show me variants" or "let me pick". |
| [`scripts/click-loop.mjs`](scripts/click-loop.mjs) | One CLI with five commands: `init`, `round`, `serve`, `wait`, `stop`. Node built-ins only. The skill calls it via `${CLAUDE_PLUGIN_ROOT}`. |
| [`scripts/loop-client.js`](scripts/loop-client.js) | The client helper, served as `/__loop.js`. A mockup page includes it and calls `pick('<id>', '<optional note>')`. |

No hooks, no MCP server, no `bin/` directory. Nothing runs unless the skill is invoked.

## How the loop runs

1. `init` creates a loop directory under the OS temp directory (`click-loop-XXXXXX`) with a `.click-loop`
   marker and `round.txt` = `1`, and prints its native absolute path. Claude reuses that path literally in
   every later call, because shell variables do not survive between tool calls.
2. Claude writes `index.html` into the loop directory: the variants side by side, built with your project's
   real design tokens and icons, realistic data, one screen without scrolling. Every variant calls
   `pick('r<round>-<letter>')`.
3. `serve` starts in the Bash tool's background mode and prints `http://127.0.0.1:<port>/`. You open it and
   click a variant. The page shows `sent: <id>` when the pick arrived, `stale page, reloading` when it came
   from an outdated round, and `not delivered — tell Claude in chat` on any other result.
4. `wait` runs in background mode as well and exits as soon as a pick for the current round exists; its exit
   wakes Claude up. A pick made before `wait` started still counts.
5. For the next round Claude writes a new `index.html` and runs `round --next`. The page polls `/__round`
   every 2 s and reloads itself when the round changes; a pending `wait` exits as superseded.
6. When the design fits, Claude implements it in the project and runs `stop --clean`.

You can always answer in chat instead of clicking ("B, but without the label"). A chat answer wins over a
click.

### Commands

| Command | Behaviour |
|---|---|
| `init` | Creates the loop dir, prints its absolute path. |
| `round --dir <dir> (--next \| --set N)` | Writes `round.txt` atomically (temp file and rename) and prints the new round. |
| `serve --dir <dir> [--port 0] [--idle-min 30] [--max-hours 4]` | Serves the dir on `127.0.0.1` (port `0` = any free port), writes `server.json` (`pid`, `port`, `url`, `nonce`, `startedAt`) and prints the URL as the first line. Reuses a running server for the same dir. Exits after `idle-min` minutes without requests (the page's `/__round` polls do not count) and after `max-hours` in any case. Removes `server.json` on exit. Refuses a dir without the `.click-loop` marker. |
| `wait --dir <dir> [--round N] [--timeout-sec 600]` | Waits for the first pick of round `N` (default: the current round). |
| `stop --dir <dir> [--clean]` | Refuses a dir without the `.click-loop` marker. Stops the dir's server if it proves its identity and reports `stopped` once it is down, then removes `server.json`; with `--clean` it also deletes the dir. A `server.json` whose url no longer answers is stale and simply removed. Exits 1 and leaves everything in place when something answers at the url without the right nonce, or when a confirmed server does not go down within 3 s. Idempotent: a missing dir or server is not an error. |

### Exit codes of `wait`

| Exit | stdout | Meaning |
|---|---|---|
| `0` | `{"round":R,"id":"...","note":"...","at":"<ISO time>"}` | The first pick for the round. |
| `2` | `{"timeout":true,"round":R}` | No pick within `--timeout-sec`. Claude asks in chat or waits again. |
| `3` | `{"superseded":true,"round":R}` | `round.txt` moved past `R`; this waiter is obsolete. |
| `1` | (stderr) | Usage error or unreadable loop dir. |

`wait` reads `picks.jsonl` itself every 500 ms (no shell tools), handles lines that arrive in several
chunks and skips malformed lines.

## Security

- **Loopback only.** The server binds `127.0.0.1` and nothing else; it is not reachable from your network.
  There is no LAN or remote mode.
- **Host and Origin checks.** Every request needs a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, else
  `403` (DNS-rebinding guard). A pick or stop request that carries an `Origin` must come from the server's
  own origin, else `403`. Picks are `POST` only.
- **Serves only the given dir.** Paths are decoded once (a malformed escape is `400`); NUL, backslash and
  drive-letter segments are rejected; the resolved real path must stay inside the dir's real path, which
  covers `..`, encoded `..` and symlinks pointing outside (`404`). There is no directory listing, and
  `picks.jsonl`, `server.json` and dotfiles are never served. Responses carry `Cache-Control: no-store`.
- **Bounded input.** Pick ids must match `^[A-Za-z0-9_-]{1,64}$` and notes are capped at 500 characters.
  A pick for an outdated round is rejected with `409` and not recorded.
- **Careful stopping.** `stop` touches only a directory that contains the `.click-loop` marker. It only
  stops a server whose `/__id` answers with the nonce from `server.json`, and never sends a signal to a
  pid. When something else answers at the recorded url, it leaves `server.json` in place and exits 1
  instead of guessing.
- **The note is untrusted.** A pick's `note` is text typed into a web page. The skill tells Claude to treat
  it as data about your preference, never as instructions.
- **No hooks.** The plugin registers no hooks and runs nothing on its own; the server lives only while the
  loop runs and stops after 30 idle minutes or 4 hours at most.

## Requirements

- Node.js on `PATH`. Only built-ins are used; nothing is installed from npm.
- A browser on the same machine as Claude Code (the page is served on `127.0.0.1`).
- Optional: a browser tool in the session, so Claude can send screenshots and verify the final result.

## Tests

```bash
node --test "plugins/mockup-loop/tests/*.test.mjs"
```

Each test uses its own temp dir, kills the servers it started, and the suite finishes in well under a
minute. Test titles start with `spec <n>:`, the case number in the design spec
([`docs/specs/2026-10-02-mockup-loop.md`](../../docs/specs/2026-10-02-mockup-loop.md)).

## Origin

Replaces a personal workflow that served mockups with a generic static file server and detected clicks by
polling its access log, which proved fragile (buffered logs, stale matches across rounds, piled-up watcher
loops, a reaped background server). The workflow is the same; the transport is rebuilt around an explicit
pick endpoint, a round number and a waiter with exit codes.

## License

MIT
