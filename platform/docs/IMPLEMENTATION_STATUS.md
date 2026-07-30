# OpenCodex Remote MVP 구현 인수인계

마지막 갱신: 2026-07-30

작업 브랜치: `ingw/remote-private-mvp-handoff`

기준 브랜치/커밋: `dev` / `67c731e6`

이 문서는 다른 컴퓨터에서 작업을 바로 이어가기 위한 현재 상태의 기준 문서다. PostgreSQL 17과 실제 Control Plane·worker·Gateway 프로세스를 사용하는 로컬 통합 검증은 완료됐다. 실제 Cloudflare account의 Linux Mesh/private-hostname transport와 Rust Agent 포함 30분 stream은 통과했고, 실제 OpenCodex process 및 public ingress를 포함한 운영 E2E는 아직 완료되지 않았다.

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
- API token과 Global API Key(`X-Auth-Email` + `X-Auth-Key`) 인증을 모두 지원.
- Tunnel 연결 상태는 전용 `/cfd_tunnel/{id}/connections` endpoint만 사용.
- private hostname route는 `/zerotrust/routes/hostname` endpoint 사용.
- Tunnel token 조회는 현재 API의 `GET /cfd_tunnel/{id}/token`을 사용.
- `*.private.remote.opencodexpages.me` DNS-only A record, 고유 RFC1918 `/32`, narrow CIDR activation route를 hostname route보다 먼저 생성.
- suspend/delete 시 hostname route → CIDR route → DNS record → Tunnel 순서로 제거.

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
- Control Plane이 배정한 `10.192.0.0/10` `/32`만 허용. privileged `prepare-network`가 `ip address replace ... dev lo`를 수행하고 비특권 `run`은 `<assigned-ip>:10101` local ingress를 실행.
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

### 실제 Cloudflare Phase 0 transport

- `opencodexpages.me` active zone과 실제 Zero Trust account API shape 검증.
- DNS-only RFC1918 A record → `/32` CIDR activation route → hostname route → dedicated Tunnel 순서 검증.
- Linux Cloudflare Mesh node `warp-cli 2026.6.880.0`에서 private hostname이 `100.80.0.0/16` synthetic IP로 해석되고 Tunnel origin까지 HTTP 200 확인.
- `cloudflared 2026.3.0`, QUIC 4 connections, 수동 `max-active-flows` override 없이 통과.
- 10회 HTTP 19.37–23.68 ms, 100 MiB download 1.500초, 100 MiB upload 정확한 byte count, SSE smoke, WebSocket echo 통과.
- Tunnel restart 시 active SSE는 약 17.05초에 종료됐고 신규 HTTP data plane은 39.632초에 복구. 최소 60초 health grace 필요.
- 실제 Control Plane/worker가 live Cloudflare 리소스 4개를 만들고 Rust Agent pair, 전용 `/32` loopback bind, 4 Tunnel connections, heartbeat를 확인.
- 실제 Mesh Gateway의 `ocxr_` 요청이 Rust Agent assertion 검증을 거쳐 origin 200을 반환했고 무자격 요청은 404로 은닉.
- Rust Agent 포함 100 MiB download 1.707초, upload 정확한 byte count, SSE smoke, WebSocket echo 통과.
- transport-only 30분 SSE는 rc 0, 1,801초, 정확히 1,800 events로 통과.
- 실제 Rust Agent 포함 30분 SSE도 rc 0, 1,800초, 정확히 1,800 events로 통과.
- 재현 절차와 실패 원인은 [CLOUDFLARE_PHASE0_2026-07-30.md](./CLOUDFLARE_PHASE0_2026-07-30.md)에 기록.

## 구현 중인 부분

- 실제 Rust Agent와 OpenCodex를 포함한 Gateway WebSocket/client disconnect E2E.
- 실제 OpenCodex process를 포함한 E2E와 Gateway 프로세스 재시작 측정. Mesh transport/Rust Agent 30분과 Tunnel 재시작은 완료.
- suspend/delete saga의 Cloudflare 부분 실패 재시도와 orphan reconciliation.
- Agent 설치·OpenCodex 설정 반영을 한 번에 수행하는 서명 검증 installer.
- 네이티브 systemd 서비스와 `LoadCredential=` 배포 파일.
- UI의 실제 브라우저 시각 QA. 현재 상태는 루트 [design-qa.md](../../design-qa.md)에 기록했다.

## 남은 부분

### P0 — 다음 컴퓨터에서 가장 먼저

- [x] `platform` typecheck/build, root 전체 테스트, Rust fmt/clippy/test 재실행.
- [x] PostgreSQL 17 migration과 Better Auth schema/CRUD 호환 검증.
- [x] 실제 Control Plane·worker·Gateway를 동시에 띄우는 로컬 통합 테스트.
- [x] 실제 Cloudflare Mesh account Phase 0 core transport. DNS, CIDR activation, hostname route, Tunnel, Linux Mesh HTTP/SSE/WS/100 MiB를 확인했다.
- [x] 실제 Mesh/Rust Agent에서 30분 stream. transport와 Agent 경로 모두 1,800 events로 통과했고 Tunnel 재시작은 신규 요청 39.632초 복구로 확인했다.
- [x] 두 사용자·두 인스턴스 교차 hostname/token/session/assertion 접근 `404` 검증.

### P1 — 운영 기능

- native systemd unit 3개와 중앙 `cloudflared`, Linux Mesh node unit 작성.
- Agent `amd64`/`arm64` musl release workflow.
- Agent binary와 installer의 SHA-256 + Ed25519 detached signature 검증.
- suspend 시 hostname/CIDR/DNS를 먼저 제거하고 Cloudflare connector-cleanup API로 모든 연결을 끊은 뒤 Tunnel을 삭제하는 흐름을 실제 활성 Agent에서 확인했다.
- resume 흐름 추가. 현재 suspend worker는 연결 종료를 확실히 하기 위해 Tunnel과 token을 폐기하며 resume은 미구현이다.
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
- private hostname은 `127.0.0.1` hosts가 아니라 DNS-only RFC1918 A record를 사용한다. Agent `prepare-network`는 구현했지만 installer/systemd의 privileged `ExecStartPre`와 비특권 runtime unit은 아직 미구현이다.
- Cloudflare Tunnel, DNS, CIDR route, hostname route create/delete와 token GET 응답 shape를 live account로 검증했다.
- Gateway synthetic token은 별도 systemd credential로 설계했지만 배포 파일은 아직 없다.
- Better Auth의 OAuth account에는 GitHub access token이 저장될 수 있다. 운영 전 DB encryption/토큰 최소 보존 정책을 확정해야 한다.
- Gateway와 Rust Agent는 100 MiB 양방향 streaming, SSE/WS, 30분 stream을 통과했다. 실제 OpenCodex process와 public ingress를 포함한 부하·backpressure는 아직 측정하지 않았다.
- private `opencodexpages.me` DNS record는 Phase 0에서 검증했다. public wildcard ingress, TLS, official `opencodex.me`와 instance `opencodexpages.me` 쿠키/OAuth 분리는 아직 구성하지 않았다.

## 현재까지 확인된 검증

```text
PASS  bun run typecheck                         (root)
PASS  bun test tests/server-management-auth.test.ts
      16 tests / 56 expects
PASS  bun test --isolate tests
      6030 pass / 2 skip / 0 fail / 30540 expects
PASS  bun run privacy:scan
PASS  cd platform && bun run typecheck
PASS  cd platform && bun test server/tests/cloudflare.test.ts
      5 tests / 22 expects
PASS  cd platform && CLOUDFLARE_LIVE_TESTS=true ... \
      bun test server/tests/cloudflare-live.test.ts
      1 test / 7 expects, live create/delete cleanup
PASS  cd platform && VITE_REMOTE_DEMO=true bun run build:web
PASS  cd platform && PLATFORM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
      bun test server/tests/postgres-integration.test.ts
      1 test / 56 expects, PostgreSQL 17.10
PASS  cd remote-agent && cargo fmt --check
PASS  cd remote-agent && cargo check
PASS  cd remote-agent && cargo clippy --all-targets --all-features -- -D warnings
PASS  cd remote-agent && cargo test
      3 Rust unit tests
```

아직 통과로 간주하면 안 되는 항목:

- 실제 Gateway 프로세스 재시작 측정
- 실제 OpenCodex process와 public ingress를 포함한 HTTP/SSE/WebSocket 운영 E2E
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
