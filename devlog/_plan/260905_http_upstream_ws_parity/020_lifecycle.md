# Bounded canonical upstream connection reuse

Depends on: protocol cycle and its verified request/metadata owner. P must re-read this document and current source after that PR lands.

## File-change map

| Operation | Path | Exact change |
| --- | --- | --- |
| NEW | `src/server/responses/codex-ws-session.ts` | Own one WS connection, exclusive in-flight exchange, per-exchange listeners, bounded queue, and terminal/cancel cleanup. Extract the existing one-shot state machine rather than duplicating it. |
| NEW | `src/server/responses/codex-ws-pool.ts` | Own bounded idle sessions, canonical eligibility/keying, idle/max-age expiry, admission fallback and shutdown registration. No configuration/auth-store imports. |
| MODIFY | `src/server/responses/codex-ws-request.ts` | Project genuine turn-state/turn-metadata headers into absent per-frame metadata slots before final serialization and byte-cap checks; identity consumes that exact prepared frame. |
| MODIFY | `src/server/responses/ws-upstream.ts` | Keep the existing public entrypoint as compatibility facade; acquire an eligible idle canonical session or use the existing one-shot behavior, then send the prepared full frame. |
| MODIFY | `src/server/responses/fetch-helpers.ts` | Supply the final request and explicit context needed for pool ownership without changing provider pacing or HTTP-version/redirect fallback. |
| MODIFY | `src/server/index.ts` / existing shutdown composition if needed | Register/dispose the pool through the existing core-owned shutdown seam; no suspended startup or Lab import. |
| MODIFY | transport, auth-metadata, shutdown and boundary tests | Add lifecycle contract fixtures; retain all original one-shot/fallback tests. Register newly necessary test files in both test-layout manifests. |
| MODIFY | transport SoT and English reference | State eligibility, caps, fallback, and full-history HTTP behavior. No new home-config key is required. |

## Session API and state machine

`CodexWsSession` owns its socket and exposes a small exchange/dispose interface. State is `connecting -> idle -> active -> idle` on success, and `* -> closed` on abort/error/expiry/shutdown. Exactly one active exchange may own a socket. Global WS event listeners route only to that active owner; late frames cannot enter a successor exchange before terminal settlement.

Before/after behavior:

```ts
// before: every request constructs WebSocket, every terminal closes it
new WebSocket(wsUrl, { headers });
// after: canonical eligible request borrows a matching idle session
const identity = codexWsReuseIdentity(url, prepared.headers, prepared.frameText);
const lease = identity ? pool.acquire(identity) : null;
return lease
  ? lease.exchange(prepared, init.signal, metadataOwner)
  : oneShotExchange(prepared, init.signal, metadataOwner);
```

Keep the actual declaration shaped to existing Bun/Web types; no dependency or framework is added. The pool/session pair is internal functional coupling, not a new public package API.

## Identity and eligibility contract

Reuse is canonical-URL-only and requires usable selected outbound auth/account identity plus explicit thread and turn identities. Missing either identity stays one-shot, so unrelated native turns cannot share a session. A mere model slug or account log label is not a reuse key.

Compute an in-memory nonlogged digest of the selected credential/account, conversation/turn scope, actual model/tier, and immutable handshake policy. No raw credential, account id or prompt is emitted in logs, receipt data, exported diagnostics, or persisted cache. Different credentials, account, model/tier, originator/beta/attestation policy, or incompatible handshake headers must never reuse a socket.

Request-scoped fields that can vary on a reused socket are carried in their documented per-frame metadata slots. Do not ignore a changed handshake-only field just to improve the hit rate: reconnect instead. An unknown/custom canonical handshake header participates in identity unless its per-request mapping is proven. Account refresh/replacement therefore invalidates reuse naturally; old idle entries are evicted rather than used under the new token.

### Identity production and consumers

The lifecycle cycle adds the pure `CodexWsReuseIdentity = { key: string; scope: string }` value in `codex-ws-pool.ts`; it is NOT supplied by the protocol cycle's `PreparedCodexWsRequest`. `codexWsReuseIdentity(url, headers, frameText)` is invoked after final request preparation at the existing transport entrypoint, so every retry automatically uses the new selected auth headers. No call-site may inject a synthetic identity. Creation is this helper; serialization/persistence is N/A (process-local digest only); deserialization is the final outgoing JSON record; consumers are pool acquire/release/evict only.

Eligibility requires the exact canonical URL, nonempty Authorization and ChatGPT-Account-Id, a nonempty `client_metadata.thread_id` or `thread-id`, AND nonempty `client_metadata.turn_id`. If both thread values exist they must agree. `session_id`/`session-id` alone or parent-thread-only are insufficient because they may be shared by siblings. The required turn id limits initial reuse to one native turn; invalid/nonstring/control-bearing/over-4096-byte identity fields disable reuse. Body and header thread conflicts disable reuse rather than choose one. Selected auth header values, not inbound headers or `ProviderFetchOptions`, supply the credential identity. Thus native passthrough calls with usable identity may reuse; sidecars/helper calls without it and all noncanonical calls remain one-shot.

`scope` is a process-local HMAC of canonical URL + account + thread + required turn; `key` includes that scope plus the selected bearer, model/tier and sorted immutable handshake header name/value pairs. One random process key prevents durable identifier correlation; it is never logged. A changed key in the same scope evicts an old idle connection. In-flight old-scope connections finish/cancel under their original request owner and are not transferred.

Only `x-codex-turn-state` and `x-codex-turn-metadata` are removed from immutable-header comparison after their genuine value is copied into the documented same-name WS `client_metadata` slot when the body does not already contain that slot. The lifecycle amendment performs this inside `prepareCodexWsRequest` BEFORE final serialization and final-frame byte measurement; the identity helper consumes that exact prepared frame. Existing fuller body metadata wins those projections. Tests include a changing header-only turn-state and a metadata projection that moves the final frame from below to above the ceiling. Lite is already normalized per frame by phase 010 and remains in the handshake key conservatively; a Lite mode change may redial. All other headers, including originator, beta, selected account/bearer, attestation, x-client-request-id, session/thread/installation/window values and unknown custom headers, participate in the key. This intentionally sacrifices reuse on varying unknown headers rather than infer safety.

The initial implementation sends each complete HTTP request as a complete `response.create`. It does not trim input, retain prompt histories, forge previous ids, or attempt semantic equality of tool/output items. Existing HTTP continuation expansion remains the owner of that behavior.

## Bounds and lifecycle

- Hard cap: 32 retained canonical sessions; at most one active exchange per retained session. On a busy key, use a separately owned one-shot connection, not an unbounded waiter queue or concurrent send on that socket. Global turn admission remains authoritative.
- Idle TTL: 30 seconds. Maximum connection age: 5 minutes. Named constants live in the pool owner; fake-clock tests cross exact boundaries.
- No timer before first activation. Expiry uses bounded owned timers with `unref` where available; every timer/listener is cleared on disposal. Register one shutdown hook on activation and detach when the pool is fully disposed.
- Evict oldest idle entries before retaining a new one. Never evict/steal a live exchange merely to make room; use the existing one-shot bounded path.
- Successful terminal closes the exchange stream and releases a reusable socket only after its bounded terminal frame is enqueued. Failed/incomplete/error outcomes are conservatively disposed, not reused.
- Request abort removes that exchange's listener, errors its body exactly once, closes its socket, and releases its ownership. A completed request's later abort must not close a session leased to a successor request.
- Closing/error sockets are removed immediately. Reconnect/retry is allowed only before a frame was accepted for send; once inference may have started, do not fall back to HTTP and double-generate. Keep existing send-throw/upgrade failure semantics only when the no-send condition is proven.
- Per-frame and per-exchange queue limits remain the existing limits. Connection reuse does not retain completed queues or prior output.
- Shutdown closes idle and active pool-owned sockets, settles all requests, and unregisters timers. It cannot import Lab, block synchronous startup, or make unrelated providers start a timer.

### Frame attribution and terminal ordering

Reuse relies on the native Responses WS protocol's sequential exchange ordering: one submitted create finishes before the next create is sent. This is the same upstream assumption used by the Rust serial consumer; it does not prove arbitrary post-terminal untagged frames belong to a successor. While idle, ANY unsolicited non-close frame immediately disposes the socket and cannot be stored as the next request's prelude.

After successor acquisition, Responses data cannot flow until its own `response.created` identifies its response id (a standalone error remains legal). Track current response id and the set of item ids declared by `response.output_item.added`; explicit mismatching response ids or deltas for unknown items fail closed and dispose the session rather than exposing stale output. A server that omits the identifiers needed for that correlation may be served one-shot but its connection is not retained for reuse. Record deterministic A-terminal -> idle-late-frame and A-terminal -> B-created -> A-item-delta tests.

Untagged quota events are account/connection snapshots, NOT response usage or turn billing. They may update only the unchanged selected account, in arrival order; they are never attributed as B's tokens/cost. Untagged response metadata follows the native ordered-exchange protocol: after B is sent, its prelude is preserved exactly as phase 010, including on a reused session. Do not reject or drop a legitimate native prelude merely because the native protocol lacks an id on that control frame. Same account, credential, thread and turn are mandatory; different turn id reconnects. Explicitly tagged old-response frames are rejected, and any idle unsolicited frame disposes the session. The server-ordering assumption is not promoted into an ability to identify arbitrary malicious untagged replay.

This is an explicitly scoped compatibility guarantee, not enforcement against a malicious server replaying an indistinguishable valid frame. Tier E7 evidence is the reference serial protocol plus deterministic fixtures; residual untagged-provider-ordering risk is documented, and the final layer is none beyond protocol compliance. The trusted canonical upstream is already authoritative for all content/metadata within that exact account/thread/turn; reuse does not cross that authority. Creating a production failure for every normal untagged native prelude would be test-induced defense against an indistinguishable hypothetical violation and would break the requested compatibility. No monetary correctness claim follows from reuse.

## Acceptance matrix

| Trigger | Required observation |
| --- | --- |
| Same eligible identity, sequential successful requests | one WS handshake, two separate frames/bodies and metadata owners |
| Different account or token generation, same client thread | distinct sockets; no event/metadata crosses owners |
| Different thread/turn/model/tier/handshake policy | no reuse |
| Missing identity or noncanonical opt-in provider | existing one-shot path and no native pool entry |
| Concurrent requests with same key | no interleaved frames; bounded one-shot or explicit existing admission outcome |
| Old request signal aborts after its success and successor acquisition | successor remains alive |
| Active request aborts, closes, or overflows | one error terminal, socket disposed, no fallback resend |
| Initial upgrade fails before send | existing HTTP fallback once, with correct final request headers/body |
| Idle TTL/max age/cap crossed | expired/evicted idle socket closes and next request redials |
| Shutdown while idle and while active | all sockets/timers/listeners released; no hanging request |
| Changed provider pacing or explicit HTTP version | original pacing count and fallback protocol pin preserved |
| Full HTTP ingress -> canonical fake WS -> client stream | headers, Lite metadata, usage, tool continuation and cancellation observed end-to-end |

Security analysis and negative-case reasoning are maintained in ignored scratch. The independent reviewer must inspect the identity-key construction and the stale-abort race before approval. No test expectation is computed by the same identity/mapping helper it verifies.

## Delivery

Run the focused transport and integration suite, typecheck, privacy/secret checks, docs build, independent adversarial review, and the coordinator-approved full check. The PR remains pending until exact-head required checks and required review are satisfied. Land after protocol, prove ancestry, then close the unit and final goal. No production service restart or link occurs.
