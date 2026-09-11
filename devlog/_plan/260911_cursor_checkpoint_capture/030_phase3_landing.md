# wp4 — land what the probes proved, or record the verdict

One branch per wp2/wp3 outcome. Only the branch the evidence selects gets built.

## Branch A — wp2 = LATE

The 50 ms base grace cancels the stream before upstream serializes conversation
state. Two edits, and the second is only safe *because* of the first.

**A1. MODIFY `src/adapters/cursor/live-transport.ts`**, the client-tool finalize
timer (currently lines 1006-1018):

```diff
     this.pendingFinalize = setTimeout(() => {
       this.pendingFinalize = undefined;
       if (this.expectedClose) return;
       const terminal = finalizeAfterDrain(state);
       if (terminal.length === 0) return;
       for (const event of terminal) push(event);
+      // A suspended tool turn is exactly the turn whose state we most want to
+      // resume from, and it is the one turn we used to cancel before upstream
+      // could send it. Give the checkpoint frame one bounded extension rather
+      // than a larger blanket grace: the common case stays fast, and a stream
+      // that never sends one is still cancelled at a known deadline (#4245).
+      if (this.wantsCheckpointCapture && !this.capturedCheckpointBytes && !this.checkpointGraceExtended) {
+        this.checkpointGraceExtended = true;
+        this.scheduleClientToolFinalize(state, push, CHECKPOINT_CAPTURE_GRACE_MS);
+        return;
+      }
       debugProviderDiagnostic("cursor", "client-tool-suspend", { ... });
       this.cancelCursorRun();
     }, this.activeClientToolFinalizeGraceMs);
```

New constant beside the others at line 114-117, sized from the measured B-arm
latency, not guessed. New fields `checkpointGraceExtended` and
`wantsCheckpointCapture` (set from `contextUsageStoreCheckpoints !== false`).

**A2. MODIFY `src/adapters/cursor.ts`** `commitCapturedCheckpoint`:

```diff
           const toolSuspendedCommit =
             emittedClientTool
             && capturedAfterClientTool
-            && isCursorExternalWireModel(activeRequest.modelId);
+            // Once A1 makes the frame actually arrive, capturedAfterClientTool is a
+            // real ordering proof for every model, so the wire-model test stops being
+            // the thing standing in for it. Keep the proof; drop the proxy for it.
+            ;
```

A2 without A1 is the patch this unit exists to reject: with `capturedBytes: 0` it
changes nothing, and with a checkpoint captured *before* the tool call it would claim
coverage the bytes do not have. A1 is what makes `capturedAfterClientTool` mean
something.

`checkpointUsable` stays `!toolSuspendedCommit`, so a tool-suspended checkpoint is
still only usable by the immediate trailing-toolResult continuation. This branch does
not widen what a checkpoint claims.

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
