# pi-delegate verification map

This directory is the maintained source for verifying the user-facing behavior of pi-delegate.
Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- `npm run build` passes from the repo root.
- The run uses a disposable root: `HOME` and `PI_CODING_AGENT_DIR` point inside it, never the
  real home (`test/setup.ts` enforces this and refuses otherwise).
- The model is the loopback fixture (`--model fixture/fixture` with `test/fixture.ts`
  `provider()`), so runs prove extension and TUI behavior, never model quality.
- Each run owns its tmux server (`tmux -L <socket>`). Never drive another run's instance.
- `tmux -L <socket> capture-pane -p -t pi` shows `FIXTURE-READY` with no `[Extension issues]`
  and no `shortcut conflict` before any recipe starts.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Send literal text with `send-keys -t pi -l`, keys (`Enter`, `C-j`, `C-o`, `C-u`, `Escape`)
  without `-l`.
- Poll the capture until the expected pattern matches or 15 seconds pass. Report the full
  screen text on failure.
- Save text and ANSI captures before and after each key interaction.
- Restore seeded state after a mutation. Never remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command sent, the pane before and after, and the side effect, not only the
  final screen.
- TUI proof includes the text capture and, for styling claims, the ANSI capture.
- Mutation proof includes a read-only second view of the stored value (`trace.jsonl`,
  `.mom` sidecar, tool result).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Never report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible
behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with tmux` starts with `Preconditions:` and uses labeled bullets that pair each
   user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required
state, commands, and observable proof.

## Features

- [Spawn a child run](./delegate.md) covers asking the parent to delegate, the Agents panel,
  live output, completion, join, resume, and restart.
- [Control running work](./control.md) covers `delegate_ctl` roles, status, and result output
  with collapsed and expanded rows.
- [Mom background map](./mom.md) covers the `/mom settings` UI and the map the model maintains.
- [Install the extension](./install.md) covers packing, isolated install, tool registration,
  roles, and the ACP runtime handshake.

## Not yet mapped

- `/todo` TUI interaction beyond tool registration (the `todo` tool registering exactly once is
  proved by the install recipe). Map it when a TUI drive asserts its rendered output.
- `/deals` command output. Same treatment when needed.
