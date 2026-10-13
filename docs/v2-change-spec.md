# v2 change spec: deciding what changes before writing them

`v2` currently asks one model for the whole edit (`commit_v2`), with the host checking structure.
That works at 35B-class models and fails in two measured ways: it settles work no evidence settled,
and it records "drop X" as a new work item. This note is the design for fixing that by putting a
cheap decision model (Beverly, over System One) in front of the big one:

1. **One Beverly call** reads the map and the batch and answers **what changes, per node**.
2. Those answers **are the spec** — an explicit list of operations over node ids.
3. The big model is asked for the **content** of those operations only, and is told what will be
   accepted. Anything outside the spec is rejected and retried with a focused reason
   ("`sso-login` is not in the spec", "`csv-export` was not to be removed").

This is not `act_labels`, which died for one reason: there the host chose the **target** by token
overlap and the model never named a node. Here every question names its node, so no target is
inferred. The host owns only the shape of the answer, never its meaning.

## The question set (the thing being tuned)

Per work node `X` on the map, two choice questions — a choice is read by argmax, so there is no
threshold to fit:

- `state__X` — what the activity did to `X`'s **state**. The menu **follows the node's current
  state** (this matters: a single menu let a settled node be called "deferred"):
  - active: `none` · `finished` · `deferred` · `dropped`
  - parked: `none` · `resumed` · `dropped`
  - settled: `none` · `reopened` · `dropped`
- `attach__X` — what the activity adds **to** `X`: `none` · `child` · `rule` · `note`.
  An attachment counts only when it beats `none` by ≥ 0.05; a spurious `child` is a phantom work
  item, so this gate is one-sided on purpose.

Once, for the whole map:

- `new_work` — what the user's own message does: `work` · `existing` · `both` · `report` · `none`.

**Focus is not asked.** Focus is derived from the ops: a `resumed` node, else a `reopened` node,
else new work, else the current focus — and if the current focus is dropped, the remaining work.
Three attempts to ask a model for focus all failed (whole-map choice 1/3, per-node 8/14, derived
1/3); the ops already carry it.

## How to run it

Run these commands from the repository root:

```sh
npx tsx scripts/v2-spec-tune.mts tuning    # fits what can be fitted, prints per-pair misses
npx tsx scripts/v2-spec-tune.mts holdout   # scores the same wording and cutoffs on unseen pairs
```

- Beverly must be reachable. `SPEC_CAL_URL` (default `http://192.168.1.52:9999/v1/systemone`) and
  `SPEC_CAL_MODEL` (default `beverly-4B`). **The `192.168.1.51` host answers HTTP 500 for every
  model as of this writing** — do not "fix" a failure by pointing at it.
- Tuning writes `fitted.json` under the OS temporary directory in `v2-spec-tune/`. Holdout reads
  that same file. Set `SPEC_CAL_DIR` to use another output directory for both commands.
- `tuning` has 20 pairs and `holdout` 10. Each pair is `(map, one lead turn)` with expectations read
  off the v2 contract, **not** off any model's behaviour. Pairs are in the script.
- A run is ~20 calls, a few seconds. It prints per-pair `OK`/`MISS` and then, for every failed
  expectation, the actual probabilities — quote those numbers when tuning.
- `tuning` creates the output directory and writes fitted cutoffs to `fitted.json`; `holdout` reads it.

## Baseline (2026-10-10, beverly-4B)

```
tuning   75/83 -> 83/83     state 29->30/30   attach 30/30   focus 2->3/3   new_work 14->20/20
holdout  23/30 -> 26/30     state 10/10       attach 6/10    new_work 7->10/10
```

The holdout row is the number that means anything: the tuning set is saturated, and `attach` does not
generalise. Both rows are the parent's own runs, not the tuning run's report.

Per-pair: all 20 pairs pass except misses confined to `new_work` (and one `state`, pair 6).

Known remaining misses and why they matter:

| pair | want | got | note |
|---|---|---|---|
| 3 standing rule | `new_work` false | `work:0.33` | a standing rule read as a request for work |
| 9 decision | `new_work` false | `both:0.39` | a decision read as asking for work |
| 10 drop, user only | `new_work` false | `both:0.54` | **the defect**: "drop it" read as new work |
| 11 drop, with reply | `new_work` false | `both:0.55` | same, with the assistant's reply |
| 15 attention to parked work | `new_work` false | `both:0.65` | a pivot read as asking for work |
| 20 rule lifted | `new_work` false | `both:0.44` | a rule change read as work |
| 6 stated outcome | `state__csv-export` `finished` | `none:0.53` | "its tests pass and it is done" missed |
| 11 drop, with reply | `focus` `sso-login` | `new` | downstream of `new_work` firing |

The whole `new_work` family is the problem: the `both` name is too attractive on batches that only
touch existing work. Note the trap that took several rounds to see: **the state question is already
close to perfect, so a tuning change that improves `new_work` at the cost of `state` or `attach` is
a loss** — a spurious settled/parked node corrupts the map, a missed one only leaves it stale.

## What the host accepts (the mapping)

The spec is a strict whitelist for work-state changes and drops, plus a worklist that permits some
additions. The host rejects unauthorized state/removal changes and work additions, while deliberately
tolerating optional rule/note edits under work touched by the spec because attachment classification
has measured holdout misses.

| spec op | the commit must | rejection text if it does not |
|---|---|---|
| `state: finished` | put that node `settled` | `sso-login: the spec settles this work, but the commit does not` |
| `state: deferred` | put it `parked` | `dark-mode: the spec parks this work, but the commit does not` |
| `state: resumed` / `reopened` | put it `active` | `csv-export: the spec reopens this work, but the commit does not` |
| `state: dropped` | remove that work item; a note does not substitute for its removal | `csv-export: the spec drops this work, but the commit keeps it` |
| *(no state op)* | leave that node's state alone | `sso-login: the commit changes a state the spec leaves alone` |
| `attach: rule` | may add/rewrite rules under touched work; optional, and not limited to one | `dark-mode: the commit adds a rule under work the spec never touched` |
| `attach: note` | may add/rewrite notes under touched work; optional, and not limited to one | `sso-login: the commit adds a note under work the spec never touched` |
| `attach: child` | may add one work item under the named parent; optional | `lint: the commit adds work under this node, but the spec adds nothing there` |
| `new_work` | may add one work item under the purpose (the root on a cold start) | — |
| *(nothing)* | Path's model is skipped; the host saves coverage only | `nothing in the spec changes the map` |

Three deliberate asymmetries, each from a measured failure:

- **Only existing work-state changes and drops are strictly whitelisted.** Those are the ops that
  corrupt the map when wrong; `state` scored 30/30 on tuning and 10/10 on unseen pairs. A new work
  item requires `new_work` or a named `child` op. Those permissions are optional: an omitted permitted
  item is logged as `unmet`, never invented. Rule/note additions and rewrites are also optional, but
  `applySpec` tolerates them under any touched work even if the classifier did not emit an attach op.
  The holdout motivates this exception: `attach` scored 30/30 on tuning but **6/10 on unseen pairs**,
  missing a prohibition, an idea and a measurement, and firing where nothing should attach. Making
  attachments a strict whitelist would reject correct findings. Rule/note edits under untouched work
  are rejected; their kind and parent stay fixed when rewritten.
- **Focus is the host's, not the commit's.** Three attempts to have a model choose focus failed
  (whole-map 1/3, per-node 8/14, derived 1/3), and the ops already carry it: a `resumed` node, else a
  `reopened` node, else added work, else the focus it had — unless it was dropped, in which case the
  remaining work. The commit's own `focus` is ignored.
- **No spec means structural checks only.** With no decision model configured, or when the read fails
  open, the commit still must satisfy structure and may not empty the map. With a spec, the empty-map
  guard is replaced by per-node drop authorization: every work item must be explicitly dropped before
  the board can become empty. The whole mechanism is fail-open.

**The checker's vocabulary is fixed** (`SpecOp` in `src/mom/v2.ts`: `state`/`attach`/`new_work` over the
semantic names above). If tuning renames a criteria name, only the thin adapter from a verdict to a
`SpecOp` changes — the checker, the mapping table, and the tests stay as they are.

## What the decision model is told

The same classifier answers one call of questions per background batch (`readSpec` in `src/mom/spec.ts`),
and its answers become the ops its model must write. There is no separate "gate" call any more: a batch
whose answers decode to no ops is the case where nothing is recorded, and its model is skipped. Every
other path — no decision model, a failed or slow endpoint, a batch past `SPEC_CHARS`, an unanswered
question, a first map, a correction, catch-up, an audit, a retry — runs its model on the structural
checks alone. The spec never writes edits itself; it enforces state/drop decisions and permits some
additions, but does not validate labels or other prose. It is never what stops an update. Each v2
decision is logged beside its `.mom` file as `v2-spec`: ops, chosen names, any permitted operations
its model omitted (`unmet`), whether its model ran, and whether the map changed. Eligible fail-open reads
record `no-client`, `oversized`, `incomplete`, or
`classifier-error`; ineligible operations record their skip reason, such as `no-checkpoint`, `retry-gap`,
or `correction`.

## Where the tuned questions live

`src/mom/spec.ts`: `specQuestions()` (the tuned wording, verbatim), `stateChoices`/`attachChoices`,
`evidenceState()` (the one renderer the gate and the spec share), and `specOps()` — the adapter that
turns answers into ops by the rules the tuning harness scored: argmax above `SPEC_FLOOR`, an
attachment only with an `ATTACH_MARGIN` win over `none`, new work only for `work` or `both`, and never
a name the node's own menu did not offer. `test/mom-v2.test.ts` pins all four.

## Where the tuning lives (so it survives a lost session)

- **The harness**: `scripts/v2-spec-tune.mts` (currently untracked in this checkout), runnable as
  `npx tsx scripts/v2-spec-tune.mts tuning|holdout`. Its edits *are* the tuned prompt; that is the
  artifact worth keeping.
- **Archived tuning materials**, including throwaway probes, are in
  `~/.pi/agent/v2-spec-scratch/`. That archive is separate from the runtime `fitted.json` file above;
  the probes are diagnostics, not deliverables.
- **The delegate run that is tuning it**: run id `worker-004e5f23-82c1-4e77-9870-55359e76d96e`
  (role `worker`, fresh context, MiMo 2.6 Flash), session transcript
  `.agents/pi/subsessions/2026-10-10T16-54-33-074Z_01a126bc-d972-74fd-be83-acdd201d2cdb.jsonl`.
  A parent reopen restores the child without running it; `delegate_ctl steer` with that run id revives
  it with its context if it was stopped.

### The `new_work` family: what the gap is, and how it was widened

The decision is "does this batch ask for work that is not on the map" (true) versus "does it only touch
work that is" (false). The *gap* is `min(score | true) − max(score | false)` over a set of pairs; a
positive gap means one cutoff decides the whole set. It began negative — no cutoff worked at all.

**Every instrument tried, and what it measured** (pooled gap over the pairs each was measured on):

| instrument | pooled gap | why it went |
|---|---|---|
| one 5-way choice, argmax on the winner | — | a false case won a name by 0.07 while true ones won by 0.01 |
| its probability mass, names `work`/`both` | **−0.05** | "scrap X" read `both`: an ask *is* present and *does* touch the map |
| three separate nouls in the same call | −0.37 | worse, and adding them degraded the 5-way to a 0.000 gap — questions in one call interfere |
| `(mass − existing)/2`, fitted | +0.045 | looked like the answer, then scored 0.025 against the shipped rule's 0.050 on unseen pairs |
| a grid over weightings | (illusion) | multiplying every weight by k multiplies the gap by k; normalizing killed the effect |
| **names that say what they mean** + one clause in `new_only` | **+0.010** | shipped |

The two changes that worked, each from a specific failing sentence:

1. **Rename the names.** `work` → `new_only`, `both` → `new_and_existing`, `existing` →
   `existing_only`, `report` → `report_only`, `none` → `nothing`. `both` was being answered "two things
   are involved", which is true of every instruction about the map, so it took "scrap the export" as
   readily as "park the export and build the import tool". The prose changed three times before with no
   effect; the *names* were the problem.
2. **One clause in `new_only`**: a stated need for something that does not exist counts
   (`"I need a way to export the audit trail."`), which lifted that case from 0.49 to **0.71**.

Two attempts that backfired, both the same way: adding excluded acts to a criterion *attracts* them.
A negation list ("a message that only parks, drops, scraps…") inside `new_and_existing` dropped pair 8
to 0.36; abandonment synonyms in `existing_only` lowered pair 8 from 0.55 to 0.43. Prose that names the
acts it excludes pulls those acts in.

**Final measurements, shipped rule** (`SPEC_NEW_MASS = 0.5` in `src/mom/spec.ts`):

| set | n | min-true | max-false | gap |
|---|---|---|---|---|
| tuning | 20 | 0.56 | 0.55 | +0.010 |
| holdout | 10 | 0.77 | 0.54 | +0.230 |
| gap | 10 | 0.64 | 0.44 | +0.200 |
| **fresh2** (written after the last change, never fitted) | 8 | 0.60 | 0.46 | **+0.140** |
| pooled | 48 | 0.56 | 0.55 | +0.010 |

A cutoff of 0.56 scores 48/48, and that is exactly why 0.50 is shipped: 0.56 would sit 0.005 from the
hardest true case, while 0.50 keeps 0.06 of slack and costs two permissions among 48 pairs — both on
sentences that only touch existing work, and both only *permitting* one work item, which is logged as
`unmet` rather than invented. "Park the export for now. I need SSO login working before the demo."
(0.56) and "The export also needs to include the current filter state." (0.55) remain 0.01 apart, and
they are the whole remaining margin: any future change to this family is judged on all four sets, with
`fresh2`-style pairs written *after* the change as the only evidence that counts.

## Implementation and validation evidence

The spec path is wired: `engine.ts` calls `readSpec` for eligible v2 deliveries, attaches its ops to
the operation, and saves coverage without calling Path when the complete spec has no ops. The v2
finalizer passes non-empty specs through `V2_MODE.apply` to `applySpec`; `specFocus` derives focus.
New work without a named parent goes under the purpose. Fixture-backed end-to-end coverage lives in
`test/mom-v2-live.test.ts`, while unit tests pin spec mapping, state/removal enforcement, root promotion,
and fail-open diagnostics.

On October 10, 2026, `test/mom-v2-semantic.test.ts` passed with the local Qwen3.6-35B-A3B-8bit model:
33/33 checks without a decision model, plus 6/6 checks for the no-empty-map drop guard. With Beverly
4B registered as the real System One classifier, the end-to-end scenario passed 16/16 checks for new
work, completion, drop, and no-op coverage skip. The no-classifier path remains intentionally
fail-open: if the classifier is absent, incomplete, too slow, or the batch is ineligible, Path runs
with structural checks only. Those fallback semantics are not a classifier-backed guarantee.
