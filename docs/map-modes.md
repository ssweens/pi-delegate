# Map modes

`commit_graph` remains the default. `act_labels` is an opt-in mode with known inherited live-map
semantic failures. Those failures are post-move follow-up work. `extract_place` remains an offline
experiment, not a registered mode.

## Purpose

A mode defines the split between model judgment and host code:

| Mode | Model decides | Host decides |
|---|---|---|
| `commit_graph` | Graph changes, targets, states, and focus | Validation, source repair, and single-writer acceptance |
| `act_labels` | One linguistic act per supplied fragment and a short label for each request or assent | Targets, graph changes, states, focus, and role authority |
| `extract_place` (unregistered) | Facts, then their placement | Retrieval, writes, states, and focus |

## Selection and persistence

Select **Map mode** and **Model** in `/mom settings`. Both are durable sidecar controls.
`--mom-mode <name>` supplies the initial mode; a saved control takes precedence.
Unknown modes are refused rather than replaced with the default.

After the save acknowledgment, the client reconfigures Mom's slice. A busy slice takes the
new configuration for its next operation. Each operation pins its mode and supplied fragments,
so a settings change cannot alter an update already in progress.

Pi `/reload` reloads the client, not the shared Oven daemon's cached extension modules.
After changing the Mom extension source, restart Oven to load that code:

```sh
node ../oven/bin/oven.mjs stop
node ../oven/bin/oven.mjs start
```

Restarting Oven is not required for an ordinary mode or model settings change.

## Native act-label lifecycle

1. The model calls `mom_begin`. The host stages numbered fragments, roles, full quotes,
   resolved antecedents, and unfinished obligations.
2. The model calls `commit_acts` with exactly one act for every supplied ID. Request and assent entries also carry a concise model-written work label.
3. Host code derives changes and checks sources, unfinished obligations, and the checkpoint
   before saving it. Missing, duplicate, or invented fragment IDs are refused.

The tool list is phase-specific: `mom_begin` before preparation, then `commit_acts` for an
act-label update. The finalizer also checks the pinned mode. A rejected payload gets one repair.

`/mom relabel` repairs the saved map without consuming the live backlog. Before asking the
model for work labels, it removes older work fabricated from structured dialog answers or
assistant status mistaken for a todo-reminder offer; direct user complaints remain as notes.
The model supplies IDs and labels through `commit_labels`; the host applies them using the
saved sources. IDs, structure, evidence, notes, and unfinished obligations are preserved;
ordinary backlog processing continues on the next update.

A normal update takes **two provider requests**, not one. One classification response is not
one end-to-end request. Large historical catch-up is intentionally not a normal update: the host
compresses the backlog locally and Mom reconciles one thread-map digest with `commit_graph`.
If there are no fragments, an existing map, and no unresolved coverage problem, `mom_begin` saves
the coverage cursor without asking for labels or rewriting the map.

Frontier preparation admits at most 60 narrative fragments per batch, preserving whole source
entries and full quotes. An individual entry over that bound is refused, not truncated. Large
historical catch-up never processes consecutive raw-evidence batches. It uses the local
thread-map chapter digest and temporarily pins that operation to `commit_graph`; the next
frontier update returns to `act_labels`. The default mode uses the same digest path.

Compaction retains the independent thread-map mechanism. Act-label audits use inline narrative
evidence and short source aliases; raw tool or receipt evidence can require inspection. A
summary-only section establishes no new raw facts. Pending raw directions are still audited
and labeled. Historical gaps are not marked audited merely because current fragments were labeled.
Recovery processes bounded prefixes and preserves the unattempted suffix and coverage cursor.

## Mode contract

`src/mom/modes.ts` declares and resolves modes:

```text
MapMode
  name        stable lowercase_underscore id
  description human-readable description
  prompt      standing map-maintenance instructions
  finalizer   tool that commits this mode's output
  turns       classification rounds required, excluding preparation and repair
  apply       optional host derivation of non-transaction output
```

### M1 — default instructions are byte-identical

`modeInstructions(modeFor(undefined), …)` retains the pre-mode instruction string.
`test/mom-modes.test.ts` checks this property. Selecting no mode changes no default.

### M2 — unknown modes are refused

Both the settings control and sidecar loader reject undeclared names. Neither silently falls
back to `commit_graph`.

### M3 — one classification round, plus one repair

`assertRunnable` accepts only `turns: 1`. This is not a cap on total provider requests:
preparation, audits, and recovery have their own steps. A multi-stage mode needs an explicit
operation-seam change before it can be selected.

### M4 — the finalizer belongs to the active operation

The tool registry must register the declared finalizer. Tool visibility and finalizer guards
must agree with the operation's pinned mode.

### M5 — non-transaction output requires host derivation

| Mode | Finalizer | Graph derivation |
|---|---|---|
| `commit_graph` | `commit_graph` | Model-authored transaction, checked and applied by the host |
| `act_labels` | `commit_acts` | `deriveActs` through `ACT_LABELS_MODE.apply`, then host checks. Work labels remain model-authored; source metadata prevents dialog answers from becoming new work. |

Independent constraints append rules. Only an explicit reference to an existing rule replaces
that rule. Assistant suggestions cannot create user rules. Completion negation prevents settlement.
These safeguards do not prove that heuristic target matching is correct for every conversation.

## Adding a mode

1. Declare the mode in `MODES` with its prompt, finalizer, and classification-round count.
2. Supply `apply` unless the output is a graph transaction.
3. Register the finalizer and teach the existing operation seam to recognize its accepted output.
4. Keep preparation and finalization bound to the same evidence and mode.
5. Measure native behavior with actual model responses: authority, preservation, unfinished work,
   consecutive updates, cold catch-up, compaction, and restart durability.

Offline variant results are hypothesis-selection evidence, not native readiness evidence.

## Current evidence

The separate Mom-modes checkout exercised native Mom and isolated Oven against
`omlx/Qwen3.5-4B-MLX-4bit`. Earlier synthetic verification passed **112/112 cases across eight
sessions**; the latest synthetic recheck passed **14/14**. Ordinary updates used two requests;
summary-only compaction used one; pending-direction compaction used three or four; a 102-fragment
backlog used four requests across two batches.

The inherited-map gate passed **0/12 phases across three replays**, despite successful native
operations and nine actual `commit_acts` calls. Focus, current findings, abandoned-work handling,
and stale-state complaint retention failed. Preservation and authority checks passed. This
separates accepted writes and fresh timestamps from a semantically current map. Keep this evidence
as post-move follow-up; it does not block the current contract port.
