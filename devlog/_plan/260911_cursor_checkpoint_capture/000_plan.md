# Cursor checkpoint capture — why #4245 full-replays

Unit opened 2026-09-11. Tracks issue #4245 (Cursor adapter always full-replays,
`cached_tokens=0`, while direct `cursor-agent` cache-hits on the same account).

## Why this unit exists

A first triage pass concluded the cause was `isCursorExternalWireModel` excluding
native router models from the tool-suspended checkpoint commit, and proposed
relaxing that gate. A live probe disproved it. The gate is not reached: every
model class dies one condition later, on `capturedBytes === 0`.

That matters beyond this issue. The proposed patch would have shipped a behaviour
change to a replay path, passed review on plausibility, and fixed nothing — the
refusal it removed is not the refusal that fires.

## Evidence already captured

macOS, opencodex 2.50.0, real Cursor OAuth account, `ocx debug provider on`,
requests to the local proxy. Nothing patched.

Same forced-tool-call request, three model classes:

```
cursor/auto-intelligence  (native router)
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}

cursor/claude-4.5-sonnet  (external)
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":true,"storeCheckpoints":true,"capturedBytes":0}

cursor/composer-2.5-fast  (native composer)
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
```

A turn with no client tool commits normally:

```
[ocx:cursor:checkpoint-continuation] {"mode":"full-replay","checkpointRefHash":"c5609327a9ac1ec4","checkpointBytes":492,"wireModel":"default"}
[ocx:cursor:checkpoint-continuation] {"mode":"full-replay","checkpointRefHash":"bdd0d48f85f7ebee","checkpointBytes":553,"wireModel":"default"}
```

Two sequential chat-completions turns, same content:

```
[ocx:cursor:run-request] {"conversationId":"cursor_f3e3e375188f41b9af0669d7090eb962","continuationMode":"full-replay","checkpointPresent":false,"checkpointInvalidationReason":"missing_ref"}
[ocx:cursor:run-request] {"conversationId":"cursor_24bbb91416874b53b9a87f97530cfa14","continuationMode":"full-replay","checkpointPresent":false,"checkpointInvalidationReason":"missing_ref"}
```

And the suspend/cancel sequence on a tool turn, with no
`conversationCheckpointUpdate` among the 33 frames:

```
[ocx:cursor:client-tool-suspend] {"reason":"Responses bridge owns client tools; ending turn without fake mcpResult","framesReceived":33,"elapsedMs":2886}
[ocx:cursor:stream-cancel-expected] {"code":"ERR_HTTP2_STREAM_ERROR","message":"Cursor stream suspended: Stream closed with error code NGHTTP2_CANCEL"}
```

## Cause map

**C1 — no capture on a client-tool turn.** `capturedCheckpointBytes` is set only by
the `conversationCheckpointUpdate` frame in `CursorLiveTransport.handleServerMessage`
(`src/adapters/cursor/live-transport.ts`). On a client-tool turn the finalize-grace
timer fires, logs `client-tool-suspend`, and calls `cancelCursorRun()`. The frame has
not arrived by then. Affects every model class equally.

**C2 — unstable conversation identity.** Each chat-completions turn derives a new
`conversationId`, so a checkpoint committed on turn N is unreachable on turn N+1
(`checkpointInvalidationReason: missing_ref`). Observed only on the stateless path so
far; the `/v1/responses` path is untested and is what Codex users actually take.

**Not a cause:** the native/external model split. Recorded so the next reader does
not retry it.

## Constraints

- No change to `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.
- No change to the checkpoint design or its safety contract: a checkpoint that claims
  coverage it does not have would send wrong context upstream. Slower and correct
  beats faster and wrong.
- Every behavioural claim needs a diagnostic captured in the same session it is
  claimed in.

## Work-phase map (dependency ordered)

| Phase | Doc | Decides |
|---|---|---|
| wp1 | this file + 010/020/030 | roadmap locked, docs only |
| wp2 | `010_phase1_grace_experiment.md` | C1: does the frame arrive late, or never |
| wp3 | `020_phase2_responses_identity.md` | C2: is it chat-completions-specific |
| wp4 | `030_phase3_landing.md` | land the proven fix, or record the verdict |

wp2 and wp3 are independent of each other and both depend only on wp1. wp4 depends on
wp2; if wp3 finishes first its outcome folds into wp4 as an additional branch.

## Decision tree

- **wp2 = LATE** (frame arrives when the grace is extended): C1 is a grace-computation
  bug. Land branch A in `030`.
- **wp2 = NEVER**: upstream does not serialize state for a suspended turn. C1 is not
  fixable inside this adapter; record the verdict and the evidence.
- **wp3 = STABLE on /v1/responses**: C2 is an artifact of the stateless path and is not
  a user-facing defect for Codex. Record and close that half.
- **wp3 = UNSTABLE on /v1/responses**: C2 is real and general. Land branch B in `030`.

Either NEVER or STABLE is a legitimate terminal outcome for its half. A recorded
negative with captured evidence is the deliverable when no safe change exists.
