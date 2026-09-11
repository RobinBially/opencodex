# wp3 — is the fresh `conversationId` chat-completions-specific

Decides C2. Independent of wp2.

## What was seen, and what it does not yet prove

Two sequential `/v1/chat/completions` turns produced two different `conversationId`
values and `checkpointInvalidationReason: missing_ref` on both. That endpoint carries
no Responses state, so a fresh identity per turn may be correct there rather than a
defect.

`src/adapters/cursor.ts` reads the prior identity from
`_parsed._providerContinuation?.cursor?.checkpointRef` and `_parsed._cursorConversationId`,
and the builder comment says it "may derive a stable provider id from the client thread
when Responses state is unavailable". Whether that derivation actually holds across
turns is the open question.

Codex uses `/v1/responses`. If identity is stable there, C2 is not user-facing and the
honest outcome is to record that and close the half.

## Procedure

1. `ocx debug provider on`; record the baseline line count.
2. Turn 1: `POST /v1/responses`, `store: true`, model `cursor/auto-intelligence`,
   trivial prompt. Capture the response `id`.
3. Turn 2: `POST /v1/responses` with `previous_response_id` set to that `id`.
4. Compare the two `[ocx:cursor:run-request]` lines on `conversationId`,
   `checkpointPresent`, `checkpointInvalidationReason`, `continuationMode`.
5. `ocx debug provider off`.

## Decision rule

- **STABLE** — same `conversationId` on both turns and `checkpointPresent: true` on
  turn 2. C2 is an artifact of the stateless endpoint. Record and close.
- **UNSTABLE-IDENTITY** — `conversationId` differs between the two turns. That is C2
  on the path users take. Go to `030` branch B.
- **STABLE-IDENTITY-STORE-MISS** — `conversationId` matches but `checkpointPresent`
  is false with `missing_ref`. Folded from the wp1 audit (medium): the original rule
  ORed these two, but `request-builder.ts:454` returns `missing_ref` whenever no
  thread or ref is resolved, which is reachable with a perfectly stable id. This is a
  different defect — the checkpoint store, not identity — and needs its own doc before
  any patch. Do not route it to branch B.
- **BLOCKED** — the proxy rejects the Responses shape for this provider. Record what it
  rejected; do not infer the answer from the chat-completions result.
