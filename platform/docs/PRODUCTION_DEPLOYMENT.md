# OpenCodex Remote central VPS deployment

The first live deployment uses `opencodexpages.me` on the existing TeamWicked Oracle VPS.

Deployment date: `2026-07-30`

## Runtime map

- `opencodexpages.me` → dedicated Cloudflare Tunnel → Control Plane and built React UI on `127.0.0.1:10200`.
- `*.opencodexpages.me` → the same public Tunnel → Gateway on `127.0.0.1:10201`.
- Control Plane and worker run as the dedicated `ocxr` system user.
- PostgreSQL 17, the isolated Cloudflare Mesh network namespace, and the Gateway run in named Docker containers managed by systemd.
- Per-instance `cloudflared` connectors remain on user servers. The central Gateway is the only component enrolled in Mesh.

The Gateway shares the Mesh container network namespace. This keeps Cloudflare One routing away from the VPS host namespace, where other TeamWicked Tunnels and management services already run.

Public instance hostnames use `<slug>.opencodexpages.me`. Cloudflare Universal SSL covers this first-level wildcard, while the originally reserved `<slug>.remote.opencodexpages.me` would require an additional certificate for a nested wildcard. Private transport names stay under `*.private.remote.opencodexpages.me` because they are DNS-only RFC1918 routing labels and do not terminate public TLS.

## Bootstrap authentication

The account does not yet have a dedicated GitHub OAuth application. The apex dashboard is therefore protected by a Cloudflare Access application allowing one exact maintainer email through One-Time PIN. Behind that edge boundary, the Control Plane runs its existing non-production numeric-ID bootstrap path for the same maintainer.

This is deliberately single-user. Do not add another Access email while numeric-ID bootstrap mode is active because every allowed request would inherit the bootstrap administrator. Before a private beta, create the GitHub OAuth app, remove `PLATFORM_DEV_AUTH_GITHUB_ID`, set `NODE_ENV=production`, and remove or relax the apex Access application as intended.

The wildcard instance Gateway is not placed behind the apex Access application. It continues to require an instance session or `ocxr_` token and conceals invalid access as `404`.

## Live inventory

- Cloudflare account: `ab4c7f382f138fea000f5374481028af`
- zone: `opencodexpages.me` (`967ca131ed9157323b367e4a57ca0c03`)
- central Tunnel: `opencodex-remote-central` (`201b093f-b7e0-4967-abce-48c728f58e15`)
- Mesh node: `opencodex-remote-central-mesh` (`25adb618-d63a-4317-ad69-0093a5d4a3bc`)
- Access app: `b2c11dab-81da-4789-abf2-9a3112ca7941`
- Access policy: `281c1b8c-f71c-47c5-85c7-6aaff0f02660`
- apex DNS record: `8f6c837918e5904eac2ebc9b192d04d7`
- wildcard DNS record: `1e56251e23703d6f1a164b334490adb2`

The mutable inventory is also stored at `/etc/opencodex-remote/cloudflare-state.json` with mode `0600`. This file contains IDs, not API credentials.

## Operations

The six units are:

```text
opencodex-remote-postgres.service
opencodex-remote-control.service
opencodex-remote-worker.service
opencodex-remote-mesh.service
opencodex-remote-gateway.service
opencodex-remote-tunnel.service
```

Check them together with:

```bash
systemctl is-active opencodex-remote-{postgres,control,worker,mesh,gateway,tunnel}
curl -fsS http://127.0.0.1:10200/healthz
docker exec ocxr-mesh warp-cli --accept-tos status
```

Restart Mesh and Gateway as a pair because the Gateway joins the Mesh container network namespace:

```bash
sudo systemctl restart opencodex-remote-mesh.service
sudo systemctl restart opencodex-remote-gateway.service
```

Only `127.0.0.1:10200`, `127.0.0.1:10201`, and `127.0.0.1:15444` are published on the host. Public traffic must enter through the central Tunnel.

## Validation and cleanup

The live worker created a disposable instance Tunnel, DNS-only RFC1918 record, `/32` CIDR activation route, and private hostname route. The delete saga marked the instance deleted and removed all four Cloudflare resources. A temporary Access service token used to validate public health/UI/assets was deleted after the test. No validation token or disposable `ocxr-` Tunnel remains.

An awaiting-Agent private hostname does not synthesize through Gateway until its dedicated Tunnel connector is online. This is expected; the Agent obtains its Tunnel token through the public Control Plane and connects before private Gateway traffic is sent.

## Secret boundary

Secrets live under root-owned `/etc/opencodex-remote/credentials`. Native services receive individual files with systemd `LoadCredential=`. Containers receive read-only credential mounts. No credential is committed to the repository or written into the Cloudflare state documentation.

[Decision Log]
- 목적과 의도: 기존 Oracle VPS를 중앙 서버로 사용하면서 다른 TeamWicked Tunnels와 host routing을 훼손하지 않는다.
- 기존 구현 및 제약 조건: Cloudflare Mesh는 host kernel routing을 바꾸며, 현재 VPS에는 여러 public Tunnel과 관리 서비스가 함께 실행 중이다. 전용 GitHub OAuth app도 아직 없다.
- 검토한 주요 대안: host-native WARP, 별도 VPS, 공개 development auth, isolated Mesh namespace와 apex Access bootstrap.
- 선택한 방식: Mesh와 Gateway만 전용 Docker network namespace에 두고, apex는 exact-email OTP Access로 닫은 single-user bootstrap으로 배포한다.
- 다른 대안 대신 이 방식을 선택한 이유: 현재 VPS의 management traffic을 건드리지 않으며 OAuth app 없이도 무인증 개발 모드를 공개하지 않는다.
- 장점, 단점 및 영향: 즉시 실제 도메인에서 검증할 수 있지만 OAuth 전환 전까지 한 명만 사용할 수 있고, 운영 topology가 완전한 Docker-free 초안과 달라진다.
