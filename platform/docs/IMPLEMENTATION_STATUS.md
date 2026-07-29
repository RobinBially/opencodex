# OpenCodex Remote MVP 구현 인수인계

마지막 갱신: 2026-07-29

작업 브랜치: `ingw/remote-private-mvp-handoff`

기준 브랜치/커밋: `dev` / `cfc50fbb`

이 문서는 다른 컴퓨터에서 작업을 바로 이어가기 위한 현재 상태의 기준 문서다. PostgreSQL 17과 실제 Control Plane·worker·Gateway 프로세스를 사용하는 로컬 통합 검증은 완료됐다. 실제 Cloudflare 계정·VPS·Rust Agent를 모두 연결한 Phase 0 및 운영 E2E는 아직 완료되지 않았다.

## 문서와 디자인 자산

- 원 기획서: [PRODUCT_PLAN_v1.md](./PRODUCT_PLAN_v1.md)
- 확정 구현 범위: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
- Instances 승인 이미지: [instances-reference.png](./assets/instances-reference.png)
- Agent 온보딩 승인 이미지: [agent-onboarding-reference.png](./assets/agent-onboarding-reference.png)
- 아키텍처 문서: [../../structure/12_remote-platform.md](../../structure/12_remote-platform.md)
- ADR: [../../structure/adr/0012-remote-private-mesh.md](../../structure/adr/0012-remote-private-mesh.md)

## 구현 완료된 부분

여기서 “완료”는 코드가 작성되고 해당 범위의 로컬 정적 검사 또는 집중 테스트를 통과했다는 뜻이다. 실제 인프라 검증 완료를 뜻하지 않는다.

### 기존 OpenCodex 통합

- `OcxConfig.remoteAccess` 설정 타입과 Zod 검증 추가.
- `X-OpenCodex-Remote-Assertion` 관리 credential class 추가.
- Ed25519 JWT 형식 assertion 검증:
  - `kid`, issuer, audience, instance ID, user ID
  - HTTP method
  - 정규화한 path/query SHA-256
  - 최대 30초 수명, clock skew
  - bounded `jti` replay cache
- 기존 admin token과 로컬 GUI session 인증 흐름 유지.
- 정상·재사용·잘못된 method/path/instance·만료·수명 초과 집중 테스트 추가.

### 중앙 플랫폼 코드 기반

- `platform/`을 기존 npm 배포 패키지와 분리된 private package로 추가.
- Bun + Hono Control Plane, streaming Gateway, PostgreSQL worker entrypoint 추가.
- PostgreSQL 초기 migration 추가:
  - Better Auth users/sessions/accounts/verifications
  - invites, instances, slug tombstones
  - agents, pairing codes, access/authorization/session tokens
  - provisioning jobs, Cloudflare resources, health observations
  - audit logs, abuse reports
- Better Auth + GitHub provider 설정과 GitHub numeric ID 필드 추가.
- 최초 관리자 numeric ID 부트스트랩과 24시간 일회용 초대 소비 로직 추가.
- 사용자당 live instance 1개, 전체 active 사용자 50명 제한 추가.
- 인스턴스 slug 트랜잭션 예약과 provisioning job 생성 추가.
- 12자/10분/1회용 Agent pairing code 추가.
- Ed25519 challenge와 5분 Agent token, heartbeat 기록 추가.
- `ocxr_` 256-bit 데이터 토큰 발급, SHA-256 저장, 30일 만료 추가.
- 브라우저 authorization code → instance session 교환 추가.
- `FOR UPDATE SKIP LOCKED` worker와 provision/suspend/delete job 골격 추가.
- Tunnel secret AES-256-GCM envelope 저장과 audit network HMAC 추가.
- Cloudflare API adapter와 로컬 fake adapter 추가.
- Tunnel 연결 상태는 전용 `/cfd_tunnel/{id}/connections` endpoint만 사용.
- private hostname route는 `/zerotrust/routes/hostname` endpoint 사용.

### Gateway

- hostname → active instance → owner 상태를 요청마다 DB에서 확인.
- 인증 실패·정지·삭제·다른 사용자 접근은 모두 `404`로 은닉.
- instance session과 `ocxr_` 데이터 토큰을 분리.
- ChatGPT Direct용 Authorization을 보존할 수 있도록 `x-opencodex-remote-token` 보조 입력 지원.
- 30초 Ed25519 request assertion 생성.
- 사용자 Cookie, `Set-Cookie`, proxy/auth control header, Cloudflare 내부 header 제거.
- Fetch body/response streaming, request abort propagation, WebSocket relay 코드 추가.
- PostgreSQL `NOTIFY instance_state`를 통해 suspend/delete 시 진행 중 HTTP 연결 abort.
- response body가 끝나거나 취소될 때까지 HTTP 요청을 추적하고, suspend/delete 시 활성 WebSocket도 함께 종료하도록 lifecycle 보강.
- Gateway synthetic `/healthz` 경로와 health observation 기록 추가.

### Rust Agent

- `remote-agent/` Rust 2024 package와 lockfile 추가.
- Ed25519 키 생성·pairing·challenge 응답·heartbeat 구현.
- Agent config와 Tunnel token을 `0600`으로 원자 저장.
- `127.0.0.1:10101` local ingress 구현.
- assertion signature/scope/method/path/time/replay 검증 구현.
- 사용자 control header 제거, Host·Origin loopback 정규화.
- streaming HTTP body와 WebSocket 양방향 relay 구현.
- `cloudflared tunnel --no-autoupdate run --token-file` 자식 감독과 backoff 재시작 구현.
- OpenCodex에 넣을 `remoteAccess` JSON 출력 명령 추가.
- WebSocket handshake key/version/upgrade header를 hop마다 새로 생성하도록 중복 전달 차단.

### Web UI

- React 19 + Vite 기반 `platform/web` 추가.
- 기존 OpenCodex logo와 dark 운영 콘솔 토큰을 재사용.
- 승인 이미지 기반 Instances 목록·상세, 상태 노드, action UI 구현.
- 3단계 instance 생성·Agent pairing·verify 화면 구현.
- Activity, Security, 로그인, 초대 소비, loading/error/empty/mobile 상태 구현.
- New instance, pairing code, open, token 발급, suspend, delete API 연결.
- 개발 demo data mode: `VITE_REMOTE_DEMO=true`.
- production SPA fallback과 미등록 `/api/*`, `/agent/*` JSON 404 경계 검증.

### PostgreSQL 17 로컬 통합 검증

- migration 17개 테이블 생성과 Better Auth users/sessions/accounts/verifications CRUD 확인.
- 실제 Control Plane·worker·Gateway 자식 프로세스와 fake Cloudflare provider 동시 실행.
- 두 사용자·두 인스턴스 provision, token/session/hostname 격리, Agent assertion scope 오류가 전부 `404`인지 확인.
- HTTP/SSE, WebSocket 양방향 relay, 100 MiB upload/download streaming 확인.
- Gateway 재시작 후 재연결과 suspend `NOTIFY`에 의한 진행 중 stream 취소 확인.
- 중첩 SPA 경로는 production HTML, 미등록 API 경로는 JSON `404`인지 확인.

## 구현 중인 부분

- 실제 Rust Agent와 OpenCodex를 포함한 Gateway WebSocket/client disconnect E2E.
- 실제 Cloudflare Mesh에서 30분 stream, reconnect, Tunnel/Gateway 재시작 측정.
- suspend/delete saga의 Cloudflare 부분 실패 재시도와 orphan reconciliation.
- Agent 설치·OpenCodex 설정 반영을 한 번에 수행하는 서명 검증 installer.
- 네이티브 systemd 서비스와 `LoadCredential=` 배포 파일.
- UI의 실제 브라우저 시각 QA. 현재 상태는 루트 [design-qa.md](../../design-qa.md)에 기록했다.

## 남은 부분

### P0 — 다음 컴퓨터에서 가장 먼저

- [x] `platform` typecheck/build, root 전체 테스트, Rust fmt/clippy/test 재실행.
- [x] PostgreSQL 17 migration과 Better Auth schema/CRUD 호환 검증.
- [x] 실제 Control Plane·worker·Gateway를 동시에 띄우는 로컬 통합 테스트.
- [ ] 실제 Cloudflare Mesh 계정 Phase 0. 현재 작업 환경에는 Account ID/API token이 없다.
- [ ] 실제 Mesh/Rust Agent에서 30분 stream과 Tunnel 재시작 측정. 로컬 Gateway 기준 HTTP/SSE/WS, cancel/reconnect, 100 MiB body, Gateway 재시작은 통과했다.
- [x] 두 사용자·두 인스턴스 교차 hostname/token/session/assertion 접근 `404` 검증.

### P1 — 운영 기능

- native systemd unit 3개와 중앙 `cloudflared`, Linux Mesh node unit 작성.
- Agent `amd64`/`arm64` musl release workflow.
- Agent binary와 installer의 SHA-256 + Ed25519 detached signature 검증.
- suspend 시 Tunnel token rotation과 Connector 종료를 Cloudflare 현재 API 기준으로 확정.
- resume 흐름 추가. 현재 suspend worker는 연결 종료를 확실히 하기 위해 Tunnel을 삭제하며 resume은 미구현이다.
- delete saga 단계별 idempotency와 orphan resource reconciler 추가.
- Gateway rate limit, 동시 연결/본문 크기 정책, abuse report/admin UI 추가.
- audit 조회·90일 retention job, 일일 암호화 backup, 7일/4주 retention, restore drill 추가.
- gateway signing key rotation과 Agent key rotation 구현.
- 실제 인스턴스 domain과 official domain 설정 후 쿠키/OAuth callback 검증.

### P2 — 제품 마감

- 승인 이미지와 같은 1488×1058 viewport에서 Instances/Onboarding 시각 비교.
- keyboard, focus, reduced motion, zoom, tablet/mobile QA.
- UI에서 실시간 health signal 세부값과 retry 상태 연결.
- 온보딩 설치 명령을 실제 서명 검증 installer URL로 교체. 현재 `install.ocx.run`은 디자인용 placeholder다.
- 사용자/인스턴스 관리자 정지 화면과 Audit Log/Activity 실제 API 연결.
- CI에 platform typecheck/test/build, Rust fmt/clippy/test와 musl build 추가.
- Cloudflare 다중 사용자 서비스 허용 범위 서면 확인.

## 알려진 차이와 위험

- 원 기획서의 Workers VPC/fallback보다 이후 확정안인 Cloudflare Mesh private hostname route가 우선한다. Mesh 실패 시 자동 fallback하지 않는다.
- 실제 private hostname이 Agent 서버에서 `127.0.0.1:10101`로 resolve되도록 installer가 hosts/resolver를 구성해야 한다. 아직 자동화되지 않았다.
- Cloudflare adapter의 route create/delete 응답 shape는 live account로 검증하지 않았다.
- Gateway synthetic token은 별도 systemd credential로 설계했지만 배포 파일은 아직 없다.
- Better Auth의 OAuth account에는 GitHub access token이 저장될 수 있다. 운영 전 DB encryption/토큰 최소 보존 정책을 확정해야 한다.
- Gateway는 로컬 100 MiB 양방향 streaming과 취소를 통과했지만, Rust Agent를 포함한 부하·backpressure·30분 stream은 아직 측정하지 않았다.
- 실제 DNS, TLS, 두 registrable domain, Cloudflare public ingress는 구성하지 않았다.

## 현재까지 확인된 검증

```text
PASS  bun run typecheck                         (root)
PASS  bun test tests/server-management-auth.test.ts
      16 tests / 56 expects
PASS  bun test --isolate tests
      5961 pass / 1 skip / 0 fail / 30318 expects
PASS  bun run privacy:scan
PASS  cd platform && bun run typecheck
PASS  cd platform && VITE_REMOTE_DEMO=true bun run build:web
PASS  cd platform && PLATFORM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
      bun test server/tests/postgres-integration.test.ts
      1 test / 56 expects, PostgreSQL 17.10
PASS  cd remote-agent && cargo fmt --check
PASS  cd remote-agent && cargo check
PASS  cd remote-agent && cargo clippy --all-targets --all-features -- -D warnings
PASS  cd remote-agent && cargo test
      2 Rust unit tests
```

아직 통과로 간주하면 안 되는 항목:

- 실제 Cloudflare Mesh Phase 0
- 실제 Rust Agent/OpenCodex를 포함한 HTTP/SSE/WebSocket E2E와 30분 stream/Tunnel 재시작
- 시각 QA와 접근성 브라우저 QA
- systemd/VPS/backup restore 검증

## 다른 컴퓨터에서 재개

```bash
git fetch origin
git switch ingw/remote-private-mvp-handoff

bun install --frozen-lockfile
bun run typecheck
bun test tests/server-management-auth.test.ts

cd gui
bun install --frozen-lockfile
cd ..
bun test --isolate tests

cd platform
bun install --frozen-lockfile
bun run typecheck
VITE_REMOTE_DEMO=true bun run build:web

docker run --name ocx-remote-pg17 -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 -d postgres:17-alpine
PLATFORM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
  bun test server/tests/postgres-integration.test.ts

cd ../remote-agent
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

UI demo는 `http://127.0.0.1:4173`에서 확인한다. production 실행에는 PostgreSQL URL, GitHub OAuth, Better Auth secret, Gateway Ed25519 key, AES key, audit HMAC key, synthetic health token이 필요하다. 환경 변수와 credential 이름은 `platform/server/src/config.ts`가 현재 기준이다.
