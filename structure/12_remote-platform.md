# OpenCodex Remote platform boundary

OpenCodex Remote는 기존 npm 패키지에 포함되지 않는 별도 중앙 플랫폼과 Linux Agent다.

## Repository boundary

- `platform/server/` — Bun/Hono Control Plane, Auth Gateway, PostgreSQL worker.
- `platform/web/` — React/Vite private dashboard.
- `platform/server/migrations/` — Better Auth와 platform schema.
- `remote-agent/` — Rust local ingress, pairing, heartbeat, cloudflared supervisor.
- `src/server/remote-assertion.ts` — 기존 OpenCodex `/api/*`의 defense-in-depth verifier.

루트 `package.json#files`에는 `platform/`과 `remote-agent/`를 추가하지 않는다. npm으로 설치되는 일반 OpenCodex 사용자는 중앙 서비스나 Agent source를 패키지 payload로 받지 않는다.

## Trust boundaries

1. Browser/CLI는 비신뢰 입력이다.
2. Gateway는 DB ownership과 instance 상태의 authority다.
3. Cloudflare private hostname은 DB가 만든 값만 사용한다. 사용자 slug로 내부 목적지를 계산하지 않는다.
4. Rust Agent는 Gateway assertion을 검증하고 모든 proxy/control header를 정규화한다.
5. OpenCodex management API는 Agent를 신뢰해 생략하지 않고 assertion을 다시 검증한다.
6. Control Plane만 Cloudflare account token을 보유한다. Agent는 자기 Tunnel token만 받는다.

## Data flow

```text
public instance hostname
  → Gateway ownership/session/token check
  → 30-second Ed25519 request assertion
  → Mesh private hostname route
  → per-instance cloudflared
  → Agent assertion/replay/header validation
  → loopback OpenCodex
```

SSE와 HTTP response body는 buffer를 만들지 않고 전달한다. WebSocket은 Gateway와 Agent 두 hop에서 양방향으로 relay한다. 각 hop은 downstream disconnect를 upstream close/abort로 전파해야 한다.

### Streaming lifecycle invariant

Gateway의 HTTP 요청 추적 수명은 upstream `fetch()`가 헤더를 반환한 시점이 아니라 response body가 종료·오류·취소된 시점까지다. suspend/delete의 PostgreSQL 알림은 활성 HTTP controller를 abort하고 활성 WebSocket을 policy close한다. WebSocket의 key/version/upgrade header는 각 relay hop이 직접 생성하며 이전 hop의 handshake header를 재사용하지 않는다.

[Decision Log]
- 목적과 의도: suspend/delete 및 downstream disconnect가 이미 헤더를 받은 장기 SSE/HTTP/WS 연결도 즉시 종료하게 한다.
- 기존 구현 및 제약 조건: response body는 buffering 없이 전달해야 하고, `fetch()` 완료 직후 cleanup하면 실제 stream 수명보다 추적이 먼저 끝난다.
- 검토한 주요 대안: 응답 전체 buffering, 고정 timeout, fetch 완료 시 추적 해제, response stream lifecycle wrapper.
- 선택한 방식: backpressure를 유지하는 `ReadableStream` wrapper에서 종료·취소 시 cleanup하고, WebSocket은 instance별 활성 registry로 추적한다.
- 다른 대안 대신 이 방식을 선택한 이유: 본문 크기와 연결 시간에 무관하게 기존 streaming 성질을 유지하면서 취소와 중앙 정지를 정확히 전파한다.
- 장점, 단점 및 영향: 100 MiB와 장기 stream도 상수 크기 buffering으로 중계하고 즉시 폐기할 수 있다. 대신 모든 body 종료 경로와 socket close 경로가 반드시 idempotent cleanup을 호출해야 한다.

## Credential classes

- OpenCodex admin token: 기존 로컬 관리 자격증명.
- OpenCodex GUI session: 기존 exact-origin + CSRF session.
- Remote assertion: 중앙 Gateway가 발급하고 Agent와 OpenCodex가 검증하는 `/api/*` 관리 자격증명.
- `ocxr_` data token: instance-scoped `/v1/*` 입장 자격증명. OpenCodex origin에는 전달하지 않는다.
- Instance session: browser가 authorization code를 교환해 얻는 host-only cookie. 공식 세션은 origin에 전달하지 않는다.

[Decision Log]
- 목적과 의도: 개인 서버의 OpenCodex 전체 GUI/API/stream을 포트 공개 없이 안전하게 원격 제공한다.
- 기존 구현 및 제약 조건: OpenCodex는 Bun-native loopback proxy이며 admin token과 GUI session 경계를 이미 가진다.
- 검토한 주요 대안: public per-user hostname Tunnel, Cloudflare Access, Workers VPC, 자체 reverse tunnel.
- 선택한 방식: 중앙 Gateway와 Cloudflare Mesh private hostname route, instance별 Tunnel, Rust local ingress.
- 다른 대안 대신 이 방식을 선택한 이유: 사용자 origin을 공개하지 않고 중앙 ownership 정책을 모든 요청에 강제하면서 OpenCodex 기존 stream/WS surface를 보존할 수 있다.
- 장점, 단점 및 영향: 중앙 인증과 즉시 정지가 가능하지만 Mesh Beta 적합성, 두 번의 proxy hop, 운영 복잡도가 생긴다. Phase 0 실패 시 구현을 중단한다.
