# wp4 — land what the probes proved, or record the verdict

One branch per wp2/wp3 outcome. Only the branch the evidence selects gets built.

## Branch A — wp2 = LATE

The 50 ms base grace cancels the stream before upstream serializes conversation state.
**Branch A is one edit.** The wp1 audit removed a second one; see "What branch A is
deliberately not doing" below.

**A1. MODIFY `src/adapters/cursor/live-transport.ts`.** Give a drained client-tool
turn one bounded extension when a checkpoint is wanted and none has arrived. The
extension must happen *before* the terminal events are pushed — once `done` reaches
the client the turn is over.

```diff
   private scheduleClientToolFinalize(
     state: ReturnType<typeof createCursorProtobufEventState>,
     push: (message: CursorServerMessage) => void,
+    graceMsOverride?: number,
   ): void {
     this.clearPendingFinalize();
     this.pendingFinalize = setTimeout(() => {
       this.pendingFinalize = undefined;
      if (this.expectedClose) return;
-      const terminal = finalizeAfterDrain(state);
-      if (terminal.length === 0) return;
+      // A suspended tool turn is the turn whose state we most want to resume from,
+      // and the one turn we cancelled before upstream could send it (#4245). Extend
+      // once, bounded, rather than raising the blanket grace: the common case stays
+      // at 50 ms and a stream that never sends a checkpoint still dies at a known
+      // deadline.
+      // This MUST run before finalizeAfterDrain(): that call reaches
+      // finalizeTurnEvents(), which sets state.terminated = true, and
+      // finalizeAfterDrain() returns [] for a terminated state. Draining first and
+      // then re-arming would make the retry return [] at the length check and leave
+      // the stream uncancelled. So mirror its two guards here instead of calling it.
+      if (!state.terminated
+        && state.openToolCalls.size === 0
+        && this.wantsCheckpointCapture
+        && !this.capturedCheckpointBytes
+        && !this.checkpointGraceExtended) {
+        this.checkpointGraceExtended = true;
+        this.scheduleClientToolFinalize(state, push, CHECKPOINT_CAPTURE_GRACE_MS);
+        return;
+      }
+      const terminal = finalizeAfterDrain(state);
+      if (terminal.length === 0) return;
       for (const event of terminal) push(event);
       debugProviderDiagnostic("cursor", "client-tool-suspend", {
         reason: "Responses bridge owns client tools; ending turn without fake mcpResult",
         framesReceived: this.framesReceived,
         elapsedMs: Date.now() - this.turnStartedAt,
+        graceMs: graceMsOverride ?? this.activeClientToolFinalizeGraceMs,
+        checkpointGraceExtended: this.checkpointGraceExtended,
       });
       this.cancelCursorRun();
-    }, this.activeClientToolFinalizeGraceMs);
+    }, graceMsOverride ?? this.activeClientToolFinalizeGraceMs);
   }
```

Also NEW beside the constants at :114-117:
`const CHECKPOINT_CAPTURE_GRACE_MS = <measured>;` sized from the arrival latency wp2
actually observed, not guessed. NEW private fields beside `pendingFinalize`:
`private checkpointGraceExtended = false;` and
`private wantsCheckpointCapture = false;` — the latter set where the run request is
applied (:643, next to `activeClientToolFinalizeGraceMs`) from
`activeRequest.contextUsageStoreCheckpoints !== false`. Reset
`checkpointGraceExtended = false` in `open()` (:1033) alongside `framesReceived`.

The added `graceMs` field also repays wp2's instrumentation debt: after this lands,
the NEVER verdict 010 could not reach becomes measurable from shipped diagnostics.

**Termination.** `checkpointGraceExtended` is set before the re-arm, so at most one
extension happens per turn; the second pass falls through to `finalizeAfterDrain` and
cancels. A sibling tool call reopening `openToolCalls` during the window is handled by
the `size === 0` guard, which also stops the one extension from being spent on a turn
that was not actually drained.

### What branch A is deliberately not doing

The obvious companion edit — dropping `isCursorExternalWireModel` from
`toolSuspendedCommit` in `src/adapters/cursor.ts:190` so native models also commit a
tool-suspended checkpoint — is **excluded**, folded from the wp1 audit (high).

`capturedAfterClientTool` is set at `cursor.ts:312` from *arrival order*
(`capturedAfterClientTool = emittedClientTool` when the byte-set changes). But
`live-transport.ts:1221` classifies `conversationCheckpointUpdate` as **liveness-only**,
the same bucket as a heartbeat. A periodic liveness snapshot can arrive after the tool
call while its *contents* predate it. Arrival order is therefore not coverage, and
committing on it would claim a prefix the bytes do not contain — the exact failure this
unit was opened to prevent.

A1 alone is still a real fix: it makes the external tool-suspended path, which the code
already intends and which has never once succeeded in production, actually work.
`checkpointUsable` stays `!toolSuspendedCommit`, so nothing widens what a checkpoint
claims.

Extending this to native models needs content coverage proven, not assumed. That is a
separate work-phase (wp5) whose first task is to decode a captured
`ConversationStateStructure` and check whether the tool call is in it. The wp1 auditor
explicitly left that decode UNVERIFIED; do not skip it.

**Tests.** `tests/providers/cursor/cursor-tool-suspended-checkpoint.test.ts`: a fake
transport that emits `conversationCheckpointUpdate` after `tool_call_end` but later
than the base grace must yield `checkpointRef` defined and `checkpointUsable: false`;
one that never emits must still refuse with `capturedBytes: 0`; and composer-2.5 must
keep whatever `cursorNeedsExternalToolContinuation` already guarantees.

**Risk.** Every suspended tool turn gets up to one extra bounded wait before the
stream closes. That is added latency on the tool path, so the constant must come from
the measurement, and the no-frame case must still terminate.

## Branch B — wp3 = UNSTABLE

Identity, not capture. The checkpoint exists and is simply unreachable because turn
N+1 derives a different `conversationId`. The fix is in how
`_cursorConversationId` / `_providerContinuation` are threaded on the Responses path,
which is request-assembly territory rather than adapter transport.

Do not start this as a patch. Write the observed identity chain into a `021` doc
first, then decide whether the correct owner is the Cursor adapter or the Responses
state layer. If it turns out to need `src/server/responses/core.ts`, it is out of this
unit's scope and becomes NEEDS_HUMAN with the evidence attached.

## Branch C — wp2 = NEVER and wp3 = STABLE

Nothing is safely fixable here. Deliverable is the recorded verdict: this file gains a
closing section, `000_plan.md` gets the outcome, issue #4245 gets a comment naming
what was measured and what would change the answer, and the unit moves to `_fin/`.

A recorded negative with captured evidence is a real outcome. The failure mode this
unit was opened against was a plausible patch that fixed nothing, so shipping nothing
beats shipping that.
