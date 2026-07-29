# OpenCodex Remote 비공개 MVP 확정 구현 계획

이 문서는 원 기획서 이후 확정된 구현 기준을 요약한다. 세부 제품 배경은 [PRODUCT_PLAN_v1.md](./PRODUCT_PLAN_v1.md), 현재 코드 상태는 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)를 따른다.

## 목표 구조

```text
Browser / CLI
  → Cloudflare public ingress
  → VPS Auth Gateway
  → Cloudflare Mesh private hostname route
  → per-instance Tunnel
  → Rust Agent 127.0.0.1:10101
  → OpenCodex 127.0.0.1:10100
```

- 사용자 Tunnel에는 공개 hostname을 만들지 않는다.
- `*.instance-domain`은 언제나 중앙 Gateway로 향한다.
- Gateway만 DB의 추측 불가능한 private hostname을 목적지로 사용한다.
- 중앙 시스템은 Docker 없이 Ubuntu 24.04 VPS의 native systemd로 운영한다.

## 보안 기준

- GitHub OAuth와 24시간 일회용 초대만 허용한다.
- 최초 관리자는 GitHub numeric ID로 부트스트랩한다.
- official domain과 instance domain은 registrable domain을 분리한다.
- 플랫폼과 인스턴스 쿠키는 `__Host-`, HttpOnly, Secure, SameSite=Lax다.
- Agent pairing code는 12자, 10분, 1회용이다.
- Agent는 Ed25519 challenge 후 5분 token을 사용한다.
- CLI token은 `ocxr_` 256-bit, 30일 기본 만료, SHA-256만 저장하며 `/v1/*`만 허용한다.
- Gateway assertion은 Ed25519, 30초이며 instance/user/method/path hash/iat/exp/jti/kid를 포함한다.
- Agent가 assertion과 replay를 검증하고 OpenCodex가 `/api/*`에서 다시 검증한다.
- Prompt, response, repository, provider credential, OpenCodex 설정 본문은 중앙 수집 대상이 아니다.

## 상태와 lifecycle

```text
pending → provisioning → awaiting_agent → connecting → online
                                                └────→ degraded/offline
online/degraded/offline → suspending → suspended
any live state → deleting → deleted
                         └→ delete_failed → retry
```

- online은 90초 이내 Agent OpenCodex health, dedicated Tunnel connections, Gateway synthetic health가 모두 정상일 때만 표시한다.
- 정지는 DB 차단과 active connection abort를 먼저 수행한다.
- 삭제는 재시도 가능한 saga이며 slug는 30일 tombstone으로 보존한다.
- job claim은 PostgreSQL `FOR UPDATE SKIP LOCKED`와 idempotency key를 사용한다.

## 실행 단계

1. Phase 0: 실제 Mesh/private hostname protocol, HTTP/SSE/WS/long stream/cancel/100 MiB/restart/격리 PoC.
2. Phase 1: PostgreSQL, Better Auth, invite, instance lifecycle, Gateway, tokens, suspend/delete.
3. Phase 2: Rust Agent, OpenCodex assertion 통합, signed installer와 musl artifacts.
4. Phase 3: Instances, onboarding, Activity, Security, Audit/admin UI.
5. Phase 4: live E2E, backup/restore, key rotation, abuse runbook, CI gates, 최대 50명 private beta.

Mesh PoC가 하나라도 실패하면 보안 수준을 낮추거나 Workers VPC/자체 reverse tunnel로 자동 전환하지 않고 MVP를 중단해 transport를 다시 설계한다.
