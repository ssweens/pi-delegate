# Control running work

`delegate_ctl` reports on delegation without starting anything: which roles exist, which children
are live or finished, and what a child actually returned. Long content stays collapsed to one
row until the user expands it.

## Sub-features

- `control-roles` lists each role on one aligned row with its context mode and tool count.
- `control-roles-expand` reveals the role source and full purpose behind the collapsed row.
- `control-status` lists live and finished children as one styled row each.
- `control-result` shows a child's report collapsed to its outcome line until expanded.

## How to get to it (user POV)

- Ask the parent `Show the roles`, `Show all runs`, or `Show that report`.
- Press `C-o` on a collapsed row to expand it, `C-o` again to collapse.

## Driving it with tmux

Preconditions:

- Baseline state from the map README holds (`FIXTURE-READY`, no banners).
- At least one finished child exists so status and result have content.

- **Roles.** Submit `Show the roles` with the provider scripted to call `delegate_ctl` with
  `{ action: "roles" }`. The pane matches `delegate_ctl roles 3` and shows one row each for
  `reviewer`, `scout`, and `worker` with context and tool counts (for example
  `scout fresh:low needs approval read-only · 5 tools`). It does not show `roles/scout.md` or
  the prose purpose (`Read-only recon of code`) in the collapsed row.
- **Roles expand.** Press `C-o`. The pane now shows `roles/scout.md` and the full purpose
  (`Read-only recon of code the parent has not seen`). Press `C-o` again to collapse.
- **Status.** Submit `Show all runs` with `{ action: "status" }` scripted. The pane matches
  `delegate_ctl status 2 children` with one styled row per child (for example
  `✓ Native detail scout · `).
- **Result.** Submit `Show that report` with `{ action: "result", runId: <id> }` scripted. The
  report renders collapsed to its outcome line. Press `C-o` to reveal the full report, `C-o`
  to collapse.
- **Proof.** Save text and ANSI captures of each collapsed state and each expanded state to
  `$ROOT/artifacts/control/`. The ANSI capture backs the one-row-per-child styling claim.

## Gotchas

- Prose written for the model does not survive a column. Any collapsed row ending mid-word is
  a rendering defect, not a data defect.
- The outcome is recorded once. Two `✓ <child>` lines for one run means the completion was
  reprinted, which the suite explicitly rejects.
- `runId` for the result recipe comes from the latest `launch` event in `trace.jsonl`. Read
  it from the trace rather than copying it from the pane.
