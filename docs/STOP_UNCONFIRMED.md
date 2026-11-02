# In-process child stop/release verification

## Diagnosis and boundaries

Reviewed ADR 0001 (pi/ACP separation, durable ownership and single completion), README's joining/recovery contract, `RunCompletion`, `RunStore`, timeout, launch, subtree stop and owner shutdown before editing. No governing-plan conflict found.

Pi SDK `abort()` signals tools, then waits for idle. The previous timeout handler changed only in-memory status and awaited neither persistence nor actual release; launch could not finish until the gated tool returned. Cancel and owner shutdown awaited that same idle indefinitely. The Agents frame displayed generic `Stopping…`.

The fix separates durable stop intent from confirmed execution settlement:

- Save the first cause, timestamp and segment before abort; later cancel/normal completion cannot replace timeout.
- Show release uncertainty immediately. Keep completion unsettled, active tools, live owner identity, capacity and writer fences. No synthetic completion receipt.
- Cancel permits 1s cooperative grace without joining/claiming the parent's receipt. Shutdown reports uncertainty after that grace, retaining unresolved runs and sessions; actual completion schedules one deferred owner cleanup.
- Timer callbacks capture segment and completion identity. Session events reject replaced sessions and settled runs. No replacement prompt can start until the preceding prompt has returned; existing interrupt queued-until-idle behavior is unchanged.
- Actual prompt return reconciles once, clears uncertainty and persists the stable outcome before normal receipt delivery.

## Red

Command:

```sh
npx tsx --import ./test/setup.ts --test test/stop-unconfirmed.test.ts
```

Initial focused regression, before behavior edits:

```text
✖ timeout persists intent while an abort-observing tool refuses release
AssertionError: timeout intent must be durable before tool release
actual: 'running'
expected: 'timeout'
tests 1; pass 0; fail 1
```

## Green

Final targeted command:

```sh
npx tsx --import ./test/setup.ts --test test/stop-unconfirmed.test.ts test/steer-interrupt.test.ts test/delegate-controls.test.ts test/lifecycle.test.ts test/completion.test.ts test/recovery.test.ts
npm run typecheck
```

Actual output:

```text
unconfirmed in-process release retains all execution fences
  ✔ timeout (3914.529417ms)
  ✔ cancelled (1201.491042ms)
  ✔ shutdown (1212.510041ms)
tests 50; pass 50; fail 0; cancelled 0; skipped 0
```

`npm run typecheck` exited 0: build:acpx, root `tsc --noEmit`, ACP and vendor TypeScript projects.

The gated regression checks on-disk cause before release, bounded cancel/shutdown responses, bounded wait returning uncertainty without a receipt, retained owner/capacity/writer fences, refused restart, no overlapping/revived child requests, timeout surviving later cancel, exactly one settlement/notice, stable persisted outcome and deferred shutdown cleanup. Real SDK sessions and tools run against an isolated loopback provider; no credentials or live agents.

## Runtime smoke

An independent `npx tsx --import ./test/setup.ts --input-type=module -e '…'` invocation launched a real source-tree child with a sandbox extension tool, waited for abort, read status and disk, externally released the tool, then called `delegate_ctl wait`. Actual output:

```json
{"phase":"unreleased","status":"timeout","settled":false,"cause":"timeout","activeTools":1,"release":"execution release unconfirmed; abort requested, waiting for the child to become idle. Capacity and writer ownership remain held; revival is disabled."}
{"phase":"released","status":"timeout","settled":true,"receipt":true,"activeTools":0}
```

An earlier inline smoke using a parent-registered tool did not reach the gate and timed out; the successful invocation used the same sandbox extension-loading path as the regression. Intermediate expanded-test failures were fixture errors (noncanonical cwd comparison, settings missing the `delegate` wrapper, parent completion requests counted as child revival); corrected before the final run.

## Additional checks and known failure

```sh
npx tsx --import ./test/setup.ts --test test/render.test.ts test/agents-navigation.test.ts test/nesting-lifecycle.test.ts test/departed-tree.test.ts
```

Actual: 32 tests, 31 pass, 1 fail. Rendering/navigation and all subtree cancellation/timeout tests passed. `departed-tree.test.ts:54` failed: `while its session is open, the coordinator's runs are live`. Repeated alone: same failure. An isolated `/tmp/pi-delegate-baseline-5FBK1s` source/test copy with `src/pi-backend.ts` replaced by `git show HEAD:src/pi-backend.ts` also failed at exactly that assertion (1 test, 0 pass, 1 fail). No fix to that unrelated session-retirement expectation was attempted. The baseline comparison excludes the pre-existing interrupt/advisory backend edits as well as this lifecycle change; those edits remain untouched in the working source.

No full-suite or visual terminal smoke claim. Actual source diff inspected; prior interrupt and advisory edits preserved.

## Review follow-up: subtree propagation and adopted records

P1 root cause: `cancelRun` discarded `stopTree` rejection, early session disposal consumed the nested binding, and a subsequent detach could return without retrying its retained owner. The ancestor could be removed while the grandchild still held a writer fence. P2 root cause: adoption skipped reconciliation for terminal stop statuses; `restoreRun` unconditionally replaced status with `error` on failed transcript harvest.

Changes in `src/pi-backend.ts`:

- Await the bounded subtree stop attempt in cancel and preserve its failure as release uncertainty. Timeout callbacks retain subtree errors too; delayed error callbacks are fenced by completion/segment identity.
- Close the nested owner before disposing its parent's session. If detach already consumed its binding, retry the retained owner directly. Root shutdown catches subtree uncertainty, retains ancestor ownership, and schedules cleanup against all unresolved descendants, not just immediate runs.
- Block restart of a stopped parent while its subtree is unresolved. Normal completed coordinators keep their existing late-child revival semantics. Late descendant release clears parent uncertainty and completes deferred cleanup without another completion.
- Adoption of an in-process stop record restores `stopIntent.cause`, clears stale live-release uncertainty, sets a recovery end timestamp, and explicitly reports that the previous process ended without observed cooperative settlement. Transcript errors append diagnostics without replacing the cause; repeat reopen does not duplicate diagnostics.

Initial red command, before review behavior edits:

```sh
npx tsx --import ./test/setup.ts --test test/stop-review.test.ts
```

Actual: 3 tests, 0 pass, 3 fail (including the enclosing test). Adoption retained `execution release unconfirmed; waiting for idle`. Parent cancel returned `stopped; automatic revival is disabled` despite the gated grandchild remaining unsettled. The expanded recovery matrix was also run in the existing isolated HEAD-backend copy:

```sh
cp test/stop-review.test.ts /tmp/pi-delegate-baseline-5FBK1s/test/stop-review.test.ts
cd /tmp/pi-delegate-baseline-5FBK1s
./node_modules/.bin/tsx --import ./test/setup.ts --test --test-skip-pattern='retains unresolved grandchild' test/stop-review.test.ts
```

Actual: all four recovery cases failed. Present transcripts retained the stale live-release warning. Missing transcripts returned `error` instead of `timeout` or `cancelled`. Totals: 6 tests, 0 pass, 6 fail (including enclosing tests).

Final green commands:

```sh
npx tsx --import ./test/setup.ts --test test/stop-review.test.ts test/stop-unconfirmed.test.ts test/steer-interrupt.test.ts test/delegate-controls.test.ts test/lifecycle.test.ts test/completion.test.ts test/recovery.test.ts test/nesting-lifecycle.test.ts test/nesting.test.ts
npm run typecheck
```

Actual:

```text
✔ adopt timeout, transcript present
✔ adopt timeout, transcript missing
✔ adopt cancelled, transcript present
✔ adopt cancelled, transcript missing
✔ cancel retains unresolved grandchild ownership until late release
✔ shutdown retains unresolved grandchild ownership until late release
tests 75; pass 75; fail 0; cancelled 0; skipped 0
```

Typecheck exited 0 for `tsconfig.acpx.json`, root `tsconfig.json`, `tsconfig.acp.json`, and `tsconfig.vendor.json`. Existing interrupt, controls, receipts, recovery, cooperative subtree shutdown and normal late-child revival tests passed. No installed extension or operator records changed; no live agent was stopped or restarted. The known `departed-tree.test.ts:54` baseline failure above was not modified or rerun in this follow-up.

Independent runtime probe command: `npx tsx /tmp/pi-stop-review-smoke.mts`. The probe used a sandbox extension tool that remained gated, a real SDK coordinator and delegated writer, direct root shutdown, late external release, then adoption of a saved cancelled record with a missing transcript. Actual final output:

```json
{"phase":"unreleased subtree","shutdownRejected":true,"rootRetained":true,"parentRetained":true,"childSettled":false,"writerHeld":true}
{"phase":"released subtree","rootRetained":false,"parentRetained":false,"childRetained":false,"writerHeld":false}
{"phase":"adopt missing transcript","status":"cancelled","cause":"cancelled","settled":true,"receipt":true,"releaseUnconfirmed":false,"transcriptDiagnostic":true,"recoveryDiagnostic":true}
```

An intermediate nested-test expansion used the enclosing test context and deadlocked; corrected to the subtest context. The first runtime probe verified subtree release but then passed the root owner's key to grandchild adoption and correctly failed metadata validation; corrected to the saved grandchild owner key before the final successful probe. Neither changed product behavior.

Shutdown grace is per active run and release attempt, not a global 1s tree deadline. A tree with unresolved descendants remains owned until actual release; recovery after owning-process loss is distinct from a successful cooperative stop.

## Recheck: completed coordinator with subtree-only uncertainty

The first recovery repair required `stopIntent`. Actual cancellation of an already-completed coordinator has no execution intent to add: the record remains `status: complete`, `stopped: true`, with subtree `haltNote`. Adoption therefore retained a stale release fence, issued a settled receipt carrying that warning, and blocked explicit restart.

The adopted in-process recovery branch now also handles `stopped && haltNote`, retaining the completed status and explicit-stop flag without inventing a stop cause. It clears the stale local release warning and adds a recovery diagnostic. The `runtime !== "oven"` boundary remains: external Oven uncertainty is not cleared by local ownership adoption.

New actual-lifecycle regression: `test/stop-subtree-recovery.test.ts`. It launches a real SDK coordinator and gated writing descendant, lets the coordinator complete, then cancels it. The test captures that exact record, confirms restart is fenced while the descendant remains gated, releases the actual local execution, closes its owners, and reopens the same parent with the unowned historical snapshot. It verifies durable reconciliation, settled receipt, preserved `complete`/`stopped`/absent intent, explicit consent still required, and a successful same-ID segment-2 restart. An Oven-shaped control record retains its release warning.

Red command:

```sh
npx tsx --import ./test/setup.ts --test test/stop-subtree-recovery.test.ts
```

Actual before the repair: 1 test, 0 pass, 1 fail. `cleared in-process ownership must reconcile subtree-only uncertainty`: actual retained `execution release unconfirmed in subtree: Parent ended; execution release unconfirmed: …`; expected `undefined`.

Final green commands:

```sh
npx tsx --import ./test/setup.ts --test test/stop-subtree-recovery.test.ts test/stop-review.test.ts test/stop-unconfirmed.test.ts test/steer-interrupt.test.ts test/delegate-controls.test.ts test/lifecycle.test.ts test/completion.test.ts test/recovery.test.ts test/nesting-lifecycle.test.ts test/nesting.test.ts
npm run typecheck
```

Actual: **76 tests, 76 pass, 0 fail, 0 skipped**. Typecheck exited 0 for all four configurations (ACPX, root, ACP, vendor). An intermediate green attempt reached restart but a later restored-descendant receipt caused an unscripted model turn to return the fixture's `Receipt read`; the fixture now scripts restart continuations consistently. No product special case was added for that fixture behavior.

Independent runtime smoke: `npx tsx /tmp/pi-stop-subtree-recovery-smoke.mts`. Actual output:

```json
{"phase":"saved gated subtree","status":"complete","stopped":true,"stopIntent":null,"releaseUnconfirmed":true}
{"phase":"adopted","status":"complete","stopped":true,"stopIntent":null,"settled":true,"receipt":true,"releaseUnconfirmed":false}
{"phase":"restarted","status":"complete","segment":2,"output":"RESTARTED"}
```

All work used source-tree SDK fixtures, sandbox records and loopback transport. No installed-extension edits, git commands or live-session actions in this recheck. The previously documented unrelated departed-tree failure was not rerun.

## Residual limits

An in-process asynchronous tool cannot safely be forcibly killed. If it never releases, its ownership and admission fences remain held indefinitely, explicitly reported as unconfirmed; shutdown does not pretend cleanup succeeded. A tool synchronously blocking the event loop prevents timer/control deadlines from running. Filesystem failure can prevent durable intent; abort is still attempted and persistence failure is surfaced. This change does not add an out-of-process kill boundary or change Oven's existing release protocol. The review follow-up below covers an unresolved gated grandchild through cancel and root shutdown; arbitrary mixed Pi/Oven/ACP subtree failures were not newly fixture-tested.
