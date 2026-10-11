# Spawn a child run

Asking the parent to delegate starts a child run the user can watch live in the Agents panel,
follow to completion, join mid-flight, and resume or restart under the same identity.

## Sub-features

- `delegate-spawn` starts a scout child from a plain-language request and shows it active.
- `delegate-live` streams the child's tool output collapsed, without leaking raw arguments.
- `delegate-complete` records the outcome exactly once when the child finishes.
- `delegate-join` hands a running child back to the parent without freezing the parent turn.
- `delegate-resume` revives the same child identity for follow-up work.
- `delegate-restart` restarts the same child after a stop.

## How to get to it (user POV)

- Type a task in the parent prompt, for example `Join a child`, and submit it.
- Open `/agents` to see finished delegate history.
- Watch the `Agents` frame in the TUI while the child runs.

## Driving it with tmux

Preconditions:

- Baseline state from the map README holds (`FIXTURE-READY`, no banners).
- The fixture provider scripts the child task, for example
  `api.script("Join a child", { tool: { name: "delegate", arguments: { role: "scout", ... } } })`.

- **Spawn.** Submit the task. Run `tmux -L $SOCKET send-keys -t pi -l "Join a child"` then
  `tmux -L $SOCKET send-keys -t pi Enter`. The pane matches `Agents.*1 active`.
- **Live output.** While the child tool runs, the pane shows its output lines (for example
  `OUTPUT-30`) and does not show `"command":` or `"path":` argument dumps.
- **Completion.** After the child finishes, the pane matches `complete ·` and the outcome line
  (for example `✓ Joined child`) appears exactly once. Confirm with a second view:
  `trace.jsonl` holds one `launch` event and `complete` events with segments 1 through 4.
- **Join.** While a child runs, the pane does not show `parent blocked in wait` once the join
  resolves. The joined outcome renders as a styled row.
- **Resume.** Submit follow-up against the finished child (for example `Resume detail`). The
  pane shows the resumed reply (for example `**RESUMED-SAME-CHILD**`).
- **Restart.** Stop the child (`C-x`, expect `Enter restart`), then submit again. The pane shows
  the restarted reply under the same child.
- **Proof.** Save text and ANSI captures of the active, completed, and resumed states to
  `$ROOT/artifacts/delegate/`. The `trace.jsonl` `launch`/`complete` pair backs the completion
  claim.

## Gotchas

- A launch must hand off before the child finishes. A drive that waits on the child outcome
  instead of scripting a release gate deadlocks the parent turn.
- Completion segments run 1 through 4 with statuses complete, complete, cancelled, complete
  sharing one session file. Assert all four before calling the run clean.
- Draft text (`C-j` submit, `C-u` clear) belongs to the parent prompt. Clear it between
  sub-features or one recipe's input leaks into the next.
