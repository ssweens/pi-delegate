# Map modes

`commit_graph` remains the default. `v2` is the opt-in minimal map. On eligible background batches, a decision model writes a per-node change spec; an empty spec skips Mom's model. When no usable spec is available, v2 fails open to Mom's model and checks structure only. (`act_labels` was deleted; see **Current evidence**.)

## Purpose

A mode defines the split between model judgment and host code:

| Mode | Mom model decides | Decision model classifies | Host decides |
|---|---|---|---|
| `commit_graph` | Graph changes, targets, states, and focus | Whether parked work is retired | Validation, source repair, and single-writer acceptance |
| `v2` | The contents of each accepted map edit | Per-node state, attachment and new-work ops for eligible background batches | Structural invariants, plus state/removal compliance with a non-empty spec |

## Selection and persistence

Select **Tracking**, **Suggestions**, **Automatic continuity**, **Map mode**, **Model**, and **Decision
model** in `/mom settings`. The client stores them in `<agentDir>/pi-delegate.json`, in the `mom`
section beside `defaults` and `ratings`. It writes the file atomically with mode `0600` before the
slice hears about a change, so the save succeeds when Oven is down. New or reconfigured Mom slices
read the saved value. Saving a control in one Pi session does not reconfigure slices in other running
sessions. Those slices keep the configuration they last received. `Quiet this session` is the one
exception. It is a session toggle and is never persisted.

`--mom-mode <name>` and `--mom-decider <provider/id>` supply the initial values. A saved setting takes
precedence over them, and older session control records remain as a fallback. The loader drops malformed
fields instead of throwing, so one bad value does not prevent a Mom slice from loading. The former
settings files (`delegate-models.json`, `delegate-ratings.json`) are folded in on the first write.

The decision-model picker lists Pi's registered private-IPv4 System One classifiers and resolves their
endpoint from the registry. With no usable decision model, `v2` sends every update to Mom without a
change spec; the host then checks structure only. A missing classifier, failed/slow endpoint, oversized
batch or incomplete answer fails open the same way. The client warns once per session when a chosen
reference does not resolve to a registered local System One classifier. Unknown modes are refused rather
than replaced with defaults.

After the save acknowledgment, the client reconfigures Mom's slice. A busy slice takes the
new configuration for its next operation. Each operation pins its mode and its evidence,
so a settings change cannot alter an update already in progress.

Pi `/reload` reloads the client, not the shared Oven daemon's cached extension modules.
After changing the Mom extension source, restart Oven to load that code:

```sh
node ../oven/bin/oven.mjs stop
node ../oven/bin/oven.mjs start
```

Restarting Oven is not required for an ordinary mode or model settings change.

## The operation

1. The model calls `mom_begin`. The host stages the operation: the mode's map, the new evidence,
   and the obligations the mode tracks.
2. The model finishes with the mode's own finalizer as a sole direct call. The host validates it
   against the mode's contract and the observed evidence before saving.
3. A rejected payload gets one repair. A second failure ends the operation; an update's turn fails
   so oven retries it.

The tool list is phase-specific: `mom_begin` alone before preparation, then the finalizer and the
evidence tools. Each operation starts a fresh context; earlier operations stay in her slice's
storage and out of the model's input.

Large historical catch-up is never raw evidence. The host compresses the backlog locally into a
thread-map chapter digest, and either mode reconciles that digest with its own finalizer. The
default `commit_graph` also uses that path for its frontier updates.

Compaction retains the independent thread-map mechanism: a child step reconstructs chapter state
from the raw evidence before the operation reconciles it. Raw tool or receipt evidence can require
inspection; a summary-only section establishes no new raw facts. Historical gaps are not marked
audited merely because current evidence was reconciled. Recovery processes bounded prefixes and
preserves the unattempted suffix and the coverage cursor.

`/mom relabel` repairs saved labels without consuming the live backlog. The model supplies IDs and
labels through `commit_labels`; the host applies them using the saved sources, and the decision
model guards the rewrite — it refuses a label that describes the conversation rather than the work,
and a replacement that names nothing in that work's intent. IDs, structure, evidence, notes, and
unfinished obligations are preserved; ordinary backlog processing continues on the next update.

## v2: the minimal map

`v2` maintains one tree with three node kinds and one pointer:

```ts
type V2Graph = { focus: ID | null; nodes: V2Node[] };
type V2Node = { id; parent: ID | null; kind: "work" | "rule" | "note"; state?: "active" | "parked" | "settled"; label; sources };
```

Mom commits with `commit_v2 { put, remove, focus }`. A `put` replaces the whole node, except that
`sources` accumulate. `commit_v2 {}` records that nothing durable changed. The host always checks
structure and reports every defect at once:

1. IDs are unique; every cited source is an observed evidence ID.
2. Exactly one root, and it is work. The root is the purpose.
3. Every parent is work, with no cycles. Only work has a state.
4. `focus` is null only for an empty map; otherwise it is work.
5. Settled work holds no active or parked work.
6. Without a non-empty change spec, a commit never empties a non-empty map. With a spec, every
   removed work item must be individually authorized as dropped.

There are no edges, prose fields beyond the label, fold or merge, or unfinished ledger. Historical
catch-up digests use `commit_v2`, not `commit_graph`. The map is stored in the shared map record (work
as `feature`, notes as `observation`, empty `intent`/`observed`), so existing readers still work.
Converting a richer map to v2 is lossy: unsupported edges and prose are dropped. The model sees the
map without sources.

### The change spec

For an eligible background delivery with an existing map and a usable decision model, `readSpec`
(`src/mom/spec.ts`) asks one choice question per work node for state and attachment, plus one question
for new work. The answers become `SpecOp`s and are included as `changes` in Mom's request. `applySpec`
checks her commit against that spec: state changes and removals are constrained; additions are
permitted, not required, because the attachment classifier has known holdout misses. An existing
rule or note may be rewritten only under work the spec touched; its kind and parent cannot change.
Focus is derived from the accepted ops, not chosen by Mom.

If the decision model returns a complete set of answers but no ops, the host saves evidence coverage
and skips Mom's model. A spec never writes edits itself: it enforces state/drop decisions and permits
some additions. It does not validate labels or other prose.

The decision path is fail-open. A first map, explicit request, correction, review, catch-up, retry or
recovery does not get a spec. Nor does a batch if the classifier is absent, fails, times out, exceeds
`SPEC_CHARS`, or omits an answer. Mom then runs with structural checks only, including the non-empty
map guard. This preserves progress but means the per-node protection is not active on those paths.
V2 decision records are logged beside the session as `v2-spec`. Eligible fail-open reads include `no-client`, `oversized`, `incomplete`, or `classifier-error`; ineligible operations record their skip reason (for example `no-checkpoint`, `retry-gap`, or `correction`).

The spec's deliberate asymmetries and measured tuning are documented in
[`v2-change-spec.md`](v2-change-spec.md).

## Mode contract

`src/mom/modes.ts` declares and resolves modes:

```text
MapMode
  name        stable lowercase_underscore id
  description human-readable description
  prompt      standing map-maintenance instructions
  operation   optional operation instructions (commits to the shared one)
  finalizer   tool that commits this mode's output
  turns       classification rounds required, excluding preparation and repair
  apply       optional host application of non-transaction output
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

### M5 — non-transaction output requires host application

| Mode | Finalizer | Graph application |
|---|---|---|
| `commit_graph` | `commit_graph` | Model-authored transaction, checked and applied by the host through `acceptGraph` |
| `v2` | `commit_v2` | Model-authored edits applied and checked by `V2_MODE.apply` (`src/mom/v2.ts`); `acceptGraph` is not used. |

## Adding a mode

1. Declare the mode in `MODES` with its prompt, finalizer, and classification-round count.
2. Supply `apply` unless the output is a graph transaction.
3. Register the finalizer and teach the existing operation seam to recognize its accepted output.
4. Keep preparation and finalization bound to the same evidence and mode.
5. Measure native behavior with actual model responses: authority, preservation, unfinished work,
   consecutive updates, cold catch-up, compaction, and restart durability.

Offline variant results are hypothesis-selection evidence, not native readiness evidence.

## Current evidence

`act_labels` was deleted after its live-map semantic gate failed **0/12 phases across three
replays** against `omlx/Qwen3.5-4B-MLX-4bit`: focus, current findings, abandoned-work handling, and
stale-state complaint retention failed even though every operation was accepted and nine
`commit_acts` calls landed. Accepted writes and fresh timestamps did not make the map semantically
current — the host inferred targets and actions from prose with token matching, and that inference
was wrong. `v2` removes the inference: the model writes the map, and the host checks structure plus any available per-node spec. Old `.mom` sidecars remain append-only: replay ignores superseded mode values and maps a final retired `act_labels` value to the safe `commit_graph` default.

`test/mom-v2.test.ts` covers map invariants, change-spec enforcement, source accumulation, and
save/reload round trips. `test/mom-v2-live.test.ts` exercises the finalizer and decision-model
skip/run behavior through a real Oven daemon with fixture models. The opt-in
`test/mom-v2-semantic.test.ts` gate passed on October 10, 2026 with Qwen3.6-35B-A3B-8bit: the direct
no-classifier scenario passed 33/33 checks, and the root-drop guard passed 6/6 after its repair prompt
was clarified. With Beverly 4B enabled as the System One classifier, the end-to-end scenario passed
16/16 checks, including new work, finish, drop, and no-op skip. These results cover the tested paths;
without a usable spec the host still enforces structure only.
