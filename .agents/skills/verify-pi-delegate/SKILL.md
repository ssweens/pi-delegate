---
name: verify-pi-delegate
description: Drive pi-delegate the way a user does. Real Pi TUI in tmux with the real extension plus the isolated install check. Reach for it to prove delegate, delegate_ctl, todo, or Mom behavior, or to validate a change end to end.
---

# Verify pi-delegate

pi-delegate is a Pi extension, not a standalone app. Its user surface is the Pi terminal UI with the
extension loaded: the `delegate`, `delegate_ctl`, `todo`, and `mom` tools, the `/mom`, `/todo`,
`/agents`, and `/deals` commands, the Agents panel, and the Mom settings UI. There is no web UI and
no HTTP API of its own. Every recipe below drives that real surface. Only the remote model is
scripted, through the repo's own loopback provider (`test/fixture.ts`), which is a supported Pi
custom provider speaking real `openai-completions` transport. That proves extension, TUI, and
transport behavior. It never proves model quality.

## Launch

Build once from the repo root, then launch Pi with an isolated home. Never reuse the developer's
real home.

```sh
cd /Users/ssweens/src/pi-packages/pi-delegate
npm run build
```

Per-run isolation follows `test/setup.ts`. Create a run root under the system temp dir and point
everything at it:

```sh
RUN_ID="verify-$$"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-delegate-verify-${RUN_ID}-XXXX")"
AGENT_DIR="$ROOT/agent"
mkdir -p "$ROOT/project" "$AGENT_DIR"
export HOME="$ROOT" PI_CODING_AGENT_DIR="$AGENT_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 DO_NOT_TRACK=1
unset PI_AGENT_DIR PI_CODING_AGENT_SESSION_DIR
```

`test/setup.ts` refuses to run when the agent dir resolves under the real home. Keep that guard:
any launch that points `HOME` or `PI_CODING_AGENT_DIR` at the real home is aborted, not driven.

Launch Pi with the real extension inside its own tmux server. Resolve the CLI through the
installed package, never by hardcoded path (the bundle moved from `bundle/cli.js` to
`dist/bundle/cli.js` before, so probe rather than assume):

```sh
SOCKET="verify-pi-${RUN_ID}"
FIXTURE="$PWD/test/terminal-fixture.ts"
CLI="$(find node_modules/@earendil-works/pi-coding-agent -name cli.js -path '*bundle*' | head -1)"
[ -f "$CLI" ] || { echo "no Pi CLI bundle found under node_modules/@earendil-works/pi-coding-agent"; exit 1; }
tmux -L "$SOCKET" new-session -d -s pi -x 110 -y 36 \
  "$PWD/node_modules/.bin/tsx" --import ./test/setup.ts test/terminal-smoke.ts
```

That entry runs the full TUI suite. For a single feature, launch Pi directly the way
`test/terminal-smoke.ts` does and drive it per the feature file:

```sh
node <cli.js> --offline --no-extensions --no-skills --no-prompt-templates --no-themes \
  --no-context-files --extension "$FIXTURE" --model fixture/fixture --thinking off \
  --tui-mode regular --session-dir "$ROOT/sessions"
```

with `DELEGATE_SMOKE_ROOT="$ROOT"` in the environment so the fixture extension can write its trace.
Readiness is the `FIXTURE-READY` status line in the captured pane. Startup diagnostics are
failures: any `[Extension issues]` banner or `shortcut conflict` text fails the run even when the
ready line appears.

Teardown is `tmux -L "$SOCKET" kill-server`. Never kill by process name. Kill only the server the
run started.

## Doctor

Run these read-only checks first whenever anything looks off. Do not drive an instance that was
not started by this verification run.

- `tmux -V` answers (the TUI drive needs tmux; the repo suite uses 3.6a).
- `node --version` satisfies the `engines` floor in `package.json` (>=22.19.0).
- `HOME` and `PI_CODING_AGENT_DIR` point inside the run root, never the real home.
- The captured pane shows `FIXTURE-READY` within 15 seconds of launch.
- The captured pane contains no `[Extension issues]` and no `shortcut conflict`.
- `npm run check:install` passes for install-path questions (it packs, installs into an isolated
  Pi, and asserts the `delegate`, `delegate_ctl`, `todo`, and `mom` tools each register exactly
  once, the `reviewer`/`scout`/`worker` roles load, and both ACP adapters answer `initialize`
  with `protocolVersion 1`).

## Drive

Three recipes, cheapest first. Prefer the repo's own scripts over hand-rolled tmux. Quote pane
text literally; tmux needs `-l` for literal input.

- **Install proof.** Run `npm run check:install` from the repo root. It prints a `PASS` line with
  the packaged file count and peer range on success and removes its temp root on exit.
- **Full TUI proof.** Run `npm run smoke:tui` from the repo root. It drives regular and fullscreen
  modes through spawn, live output, scrolling, resize, drafts, join, `delegate_ctl`, resume,
  restart, and reload, and prints `PASS ... Evidence: <root>` naming the evidence directory.
- **Single feature.** Follow the matching file under `features/`. The shared tmux vocabulary,
  copied from `test/terminal-smoke.ts`, is: `tmux -L "$SOCKET" capture-pane -p -t pi` to read the
  screen, `tmux -L "$SOCKET" send-keys -t pi -l <text>` for literal input,
  `tmux -L "$SOCKET" send-keys -t pi Enter` (also `C-j`, `C-o`, `C-u`, `C-c`, `C-End`, `PPage`,
  `Escape`, `Down`) for keys. Poll the capture until a pattern matches or 15 seconds pass, then
  fail with the full screen text. Save text and ANSI captures (`capture-pane -e`) before and
  after the key interaction, the same way the suite's `save()` does.

## Evidence

Proof artifacts survive teardown in a location the run names. For script runs that is the printed
`Evidence: <root>` directory (`capture-*.txt` / `*.ansi` pane captures plus `trace.jsonl` with
`launch` and `complete` events). For ad-hoc drives write captures to
`$ROOT/artifacts/<feature>/` and report that path. Capture the action and the resulting state,
not just the final screen: the command sent, the pane before and after, and the side effect
(files written, sidecar records, tool results). A `PASS` line without its evidence directory is
not proof. Mutation proof adds a read-only second view of the stored value (for example the
`.mom` sidecar or `trace.jsonl` entry backing a UI claim).

## Cleanup

Run `tmux -L "$SOCKET" kill-server` after every attempt, including failed ones, so broken runs do
not strand servers. Remove only roots the run created (`$ROOT`). Never touch the real home,
never `pkill tmux`, never delete the evidence directory the run reported. `check:install`
removes its own temp root; `smoke:tui` leaves its evidence root in place by design.

## Helpers

This skill ships no new scripts. Its helpers are the repo's own harnesses, invoked exactly as
shown. `test/setup.ts` is preloaded (`--import ./test/setup.ts`) so every process shares one
temporary home and refuses the real one. `test/fixture.ts` provides `provider()` (scripted model
with `script()`/`onUnscripted()`/`classify()` and a `trace.jsonl`-backed `sandbox()`). Keep it
that way: a helper the reader must reverse-engineer is not a helper, and these two already exist.

## Gotchas

- Find the Pi CLI with `find node_modules/@earendil-works/pi-coding-agent -name cli.js
  -path '*bundle*'`, the same bundle `test/terminal-smoke.ts` resolves through
  `import.meta.resolve`. The bundle path already moved once, so probe it on every run.
- tmux cannot send Shift+Enter without extended keys. Send the modifyOtherKeys encoding
  `\x1b[27;2;13~` literally, as the suite does for the multiline draft check.
- In regular mode Pi leaves mouse handling to the terminal emulator. Mouse assertions only hold
  in fullscreen mode.
- `npm run test:acp:e2e` deliberately skips the isolation preload and spends real auth. It is
  not part of verification. Never run it by default.
- The suite asserts background handoff never freezes the parent turn. A drive that blocks on a
  child outcome instead of scripting a release file has deadlocked itself.
