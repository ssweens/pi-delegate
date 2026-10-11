# Mom background map

Mom tracks durable work in the background and exposes it through `/mom`. The settings UI shows
whether background tracking is on, and the map itself persists as sidecar records next to the
session file.

## Sub-features

- `mom-settings` opens the settings UI and shows background tracking state.
- `mom-settings-suggest` offers eligible findings from the map while navigating settings.
- `mom-map` records multi-turn work across sessions without tracking transient chatter.

## How to get to it (user POV)

- Run `/mom settings` to open the settings UI.
- Run `/mom` with no arguments for the compact overview.
- Ask about durable work and check that later sessions still reference it.

## Driving it with tmux

Preconditions:

- Baseline state from the map README holds (`FIXTURE-READY`, no banners).
- Mom is enabled in the fixture agent dir (the suite writes Mom-enabled settings before launch).

- **Settings.** Submit `/mom settings`. The pane matches `SETTING HELP` and shows
  `Background tracking` with `work map in the background` copy.
- **Suggestions.** Press `Down` in the settings UI. The pane matches
  `eligible findings from Mom's map`. Press `Escape` and assert the settings UI is gone
  (`Mom settings` absent from the pane).
- **Map write.** Drive a multi-turn exchange the map should track, then read the session's
  `.mom` sidecar file directly (session file path with the extension swapped to `.mom`). The
  map record holds the work item the UI claims. Status questions and single-turn chatter leave
  no new work items.
- **Proof.** Save text and ANSI captures of the settings and suggestions states to
  `$ROOT/artifacts/mom/`. The sidecar file contents back the persistence claim.

## Gotchas

- Escape must fully close the overlay. A lingering `Mom settings` match after `Escape` means
  the overlay leaked, not that the test was too fast.
- Only durable, multi-turn work becomes tracked items. Seeding the drive with a status
  question and then asserting a new work item fails by design.
- The map mode matters: `commit_graph` never mutates task state, while `v2` edits the minimal
  map through the host-validated spec. Name the mode under test with every artifact.
