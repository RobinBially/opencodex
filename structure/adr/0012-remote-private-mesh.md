# ADR 0012: Remote access through a central Gateway and private Mesh routes

- Status: proposed, blocked on Phase 0
- Date: 2026-07-29

## Context

OpenCodex Remote must expose a user's loopback OpenCodex GUI, management API, data API, SSE, and WebSocket without publishing the user's Tunnel hostname. User-controlled origins and Agents are untrusted. The public hostname must not reveal whether another user's instance exists.

## Decision

All instance wildcard DNS enters a central VPS Gateway. The Gateway resolves hostname ownership and lifecycle state from PostgreSQL, authenticates an instance session or `ocxr_` token, signs a 30-second Ed25519 assertion, and routes only to a random private hostname through a Linux Cloudflare Mesh node. Each user server runs one Cloudflare Tunnel into a Rust local ingress. The Agent and OpenCodex management API verify the assertion independently.

Cloudflare Access Applications are not used. No public hostname is attached to a user Tunnel. Mesh failure does not authorize a weaker automatic fallback.

## Consequences

- Positive: one policy enforcement point, hidden instance existence, immediate DB-first suspension, no inbound user-server port.
- Positive: browser, `/api/*`, `/v1/*`, SSE, and WebSocket retain one public instance origin.
- Negative: Mesh/private hostname routing is Beta and must pass Phase 0 before MVP approval.
- Negative: Gateway and Agent must implement careful streaming, cancellation, replay, and header normalization.
- Negative: operating the service requires PostgreSQL, three Bun services, central ingress, Mesh, and instance Tunnel lifecycle reconciliation.

[Decision Log]
- 목적과 의도: 사용자 Tunnel을 공개하지 않고 중앙 인증 정책을 강제한다.
- 기존 구현 및 제약 조건: OpenCodex GUI와 API는 동일 origin과 장시간 stream/WS를 사용한다.
- 검토한 주요 대안: 공개 Tunnel hostname, Cloudflare Access, Workers VPC, 자체 reverse tunnel.
- 선택한 방식: central Gateway + Cloudflare Mesh private hostname + per-instance Tunnel.
- 다른 대안 대신 이 방식을 선택한 이유: 확정된 private-only 경계와 전체 protocol surface를 동시에 만족하는 후보이기 때문이다.
- 장점, 단점 및 영향: 격리와 정지는 강해지지만 Beta dependency가 생긴다. PoC 불통과 시 ADR을 accepted로 바꾸지 않는다.
