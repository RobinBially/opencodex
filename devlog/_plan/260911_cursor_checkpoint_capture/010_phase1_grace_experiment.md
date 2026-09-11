# wp2 — does `conversationCheckpointUpdate` arrive late, or never

Decides C1. Written at wp1; re-verify against the tree before executing.

## The lever, and why no build is needed

`src/adapters/cursor/live-transport.ts:114`:

```ts
const CLIENT_TOOL_FINALIZE_GRACE_MS = 50;
```

Fifty milliseconds. The probe that produced `capturedBytes: 0` sent one tool and no
`parallel_tool_calls`, so it took the base path and the stream was cancelled 50 ms
after the turn drained.

`clientToolFinalizeGraceMsForRequest` (same file, line 416) already raises that window
from the request alone:

```ts
if (request.parallelToolCalls === true && (request.tools?.length ?? 0) > 1) {
  const advertised = request.tools?.length ?? 0;
  return Math.max(baseGraceMs, Math.min(1_800, Math.max(750, advertised * 125)));
}
```

A request with `parallel_tool_calls: true` and 12 advertised tools therefore gets
`min(1800, max(750, 1500)) = 1500 ms` instead of 50 ms — on the shipped binary, with
no patch, no second proxy and no credential copy. That is the experiment.

This deliberately replaces the instrumented build the roadmap first imagined. It is
strictly better: it exercises production code rather than a local mutant, and it
touches nothing on the operator machine.

## Procedure

1. `ocx debug provider on` on macbookpro-2; record the log line count as a baseline.
2. Request A (control): 1 tool, no `parallel_tool_calls`, `tool_choice: required`,
   model `cursor/auto-intelligence`. Expect the 50 ms path.
3. Request B (treatment): 12 tools, `parallel_tool_calls: true`, `tool_choice: required`,
   same model. Expect the 1500 ms path.
4. Capture per request: `client-tool-suspend.elapsedMs`, whether any
   `conversationCheckpointUpdate` frame appears, and
   `checkpoint-commit-refused.capturedBytes`.
5. `ocx debug provider off`.

## Decision rule

- **LATE** — B shows `capturedBytes > 0`, or a `conversationCheckpointUpdate` frame
  that A lacked. The 50 ms base grace is the defect. Go to `030` branch A.
- **NEVER** — B still shows `capturedBytes: 0` and no such frame, *and* B's
  `elapsedMs` is clearly larger than A's, proving the longer window was actually
  taken. Upstream does not serialize state for a suspended turn; no adapter-local fix.
- **INCONCLUSIVE** — B's `elapsedMs` is not larger than A's, so the branch was not
  taken. Fix the request shape and rerun; do not read the result.

That third case is the one worth guarding. Without comparing `elapsedMs` the
experiment can measure the same 50 ms twice and look like a clean NEVER.
