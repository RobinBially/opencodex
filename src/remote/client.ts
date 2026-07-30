import { generateKeyPairSync } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  atomicWriteFile,
  backupInvalidConfig,
  getConfigDir,
  hardenConfigDir,
  hardenExistingSecret,
} from "../config";

const DEFAULT_CONTROL_PLANE_URL = "https://opencodexpages.me";
const REMOTE_STATE_VERSION = 1;
const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REMOTE_RESPONSE_BYTES = 256 * 1024;

const remoteInstanceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum([
    "pending", "provisioning", "awaiting_agent", "connecting", "online", "degraded", "offline",
    "suspending", "suspended", "deleting", "delete_failed", "deleted",
  ]),
  publicUrl: z.string().url(),
});

const pendingStateSchema = z.object({
  version: z.literal(REMOTE_STATE_VERSION),
  state: z.literal("pending"),
  controlPlaneUrl: z.string().url(),
  privateKeyPem: z.string().min(1),
  linkId: z.string().uuid(),
  pollSecret: z.string().startsWith("ocxr_device_"),
  userCode: z.string().min(4).max(32),
  authorizeUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

const connectedStateSchema = z.object({
  version: z.literal(REMOTE_STATE_VERSION),
  state: z.literal("connected"),
  controlPlaneUrl: z.string().url(),
  privateKeyPem: z.string().min(1),
  deviceId: z.string().uuid(),
  deviceToken: z.string().startsWith("ocxr_device_"),
  account: z.object({
    name: z.string(),
    email: z.string().email(),
    githubNumericId: z.string().regex(/^\d+$/),
  }),
  passwordSet: z.boolean().default(false),
  canActivate: z.boolean().default(false),
  instance: remoteInstanceSchema.nullable().default(null),
});

const remoteStateSchema = z.discriminatedUnion("state", [pendingStateSchema, connectedStateSchema]);
type RemoteState = z.infer<typeof remoteStateSchema>;

export type RemoteStatus =
  | { state: "signed_out"; controlPlaneUrl: string; serviceReachable: boolean; error?: string }
  | {
    state: "pending";
    controlPlaneUrl: string;
    serviceReachable: boolean;
    authorizeUrl: string;
    userCode: string;
    expiresAt: string;
    error?: string;
  }
  | {
    state: "connected";
    controlPlaneUrl: string;
    serviceReachable: boolean;
    deviceId: string;
    account: { name: string; email: string; githubNumericId: string };
    passwordSet: boolean;
    canActivate: boolean;
    instance: z.infer<typeof remoteInstanceSchema> | null;
    error?: string;
  };

interface RemoteClientDependencies {
  fetchImpl?: typeof fetch;
  controlPlaneUrl?: string;
  deviceName?: string;
  devicePlatform?: string;
}

interface RemoteJsonRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

function remoteStatePath(): string {
  return join(getConfigDir(), "remote.json");
}

function configuredControlPlaneUrl(override?: string): string {
  const candidate = override ?? process.env.OPENCODEX_REMOTE_CONTROL_URL ?? DEFAULT_CONTROL_PLANE_URL;
  const url = new URL(candidate);
  const localDevelopment = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localDevelopment) throw new Error("remote control plane must use HTTPS");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readState(): RemoteState | null {
  const path = remoteStatePath();
  hardenConfigDir();
  if (!existsSync(path)) return null;
  try {
    hardenExistingSecret(path);
    return remoteStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    backupInvalidConfig(path);
    return null;
  }
}

function writeState(state: RemoteState): void {
  const directory = getConfigDir();
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  atomicWriteFile(remoteStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function clearState(): void {
  try { unlinkSync(remoteStatePath()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "remote service unavailable";
}

async function remoteJson<T>(
  baseUrl: string,
  path: string,
  request: RemoteJsonRequest,
  fetchImpl: typeof fetch,
): Promise<T> {
  const target = new URL(path, `${baseUrl}/`);
  if (target.origin !== new URL(baseUrl).origin) throw new Error("remote request origin mismatch");
  const response = await fetchImpl(target, {
    method: request.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...request.headers,
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_RESPONSE_BYTES) {
    throw new Error("remote response is too large");
  }
  const text = await response.text();
  if (text.length > MAX_REMOTE_RESPONSE_BYTES) throw new Error("remote response is too large");
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`remote service returned HTTP ${response.status}`); }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `remote service returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function publicStatus(state: RemoteState, serviceReachable: boolean, error?: string): RemoteStatus {
  if (state.state === "pending") {
    return {
      state: "pending",
      controlPlaneUrl: state.controlPlaneUrl,
      serviceReachable,
      authorizeUrl: state.authorizeUrl,
      userCode: state.userCode,
      expiresAt: state.expiresAt,
      ...(error ? { error } : {}),
    };
  }
  return {
    state: "connected",
    controlPlaneUrl: state.controlPlaneUrl,
    serviceReachable,
    deviceId: state.deviceId,
    account: state.account,
    passwordSet: state.passwordSet,
    canActivate: state.canActivate,
    instance: state.instance,
    ...(error ? { error } : {}),
  };
}

/**
 * [Decision Log]
 * - 목적과 의도: local dashboard가 GitHub token이나 Cloudflare account credential을 받지 않고 중앙 계정에 현재 PC만 연결한다.
 * - 기존 구현 및 제약 조건: OCX management API는 loopback GUI session 경계가 이미 있고 remote platform은 별도 Agent pairing만 제공했다.
 * - 검토한 주요 대안: localhost OAuth callback으로 GitHub token 전달, URL fragment에 장기 token 전달, one-time polling secret을 가진 device authorization.
 * - 선택한 방식: local OCX가 Ed25519 key와 polling secret을 생성·보관하고 브라우저는 중앙의 request UUID와 확인 코드만 본다.
 * - 다른 대안 대신 이 방식을 선택한 이유: 중앙 OAuth와 local management credential이 섞이지 않고 브라우저 history 및 referrer에 장기 secret이 남지 않는다.
 * - 장점, 단점 및 영향: `ocx gui`가 실제 onboarding 시작점이 되며 장치별 폐기가 가능하다. `remote.json`은 새 장기 secret 파일이므로 기존 config hardening과 atomic write를 반드시 유지한다.
 */
export async function startRemoteLink(deps: RemoteClientDependencies = {}): Promise<RemoteStatus> {
  const existing = readState();
  if (existing?.state === "connected") return publicStatus(existing, true);
  const controlPlaneUrl = configuredControlPlaneUrl(deps.controlPlaneUrl);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const response = await remoteJson<{
    id: string;
    pollSecret: string;
    userCode: string;
    authorizeUrl: string;
    expiresAt: string;
  }>(controlPlaneUrl, "/api/v1/device-links", {
    method: "POST",
    body: {
      deviceName: (deps.deviceName ?? hostname()).slice(0, 80) || "OpenCodex device",
      platform: deps.devicePlatform ?? `${platform()}-${arch()}`,
      publicKey: Buffer.from(publicKeyDer).toString("base64url"),
    },
  }, deps.fetchImpl ?? fetch);
  const authorizeUrl = new URL(response.authorizeUrl);
  if (authorizeUrl.origin !== new URL(controlPlaneUrl).origin) throw new Error("remote authorization origin mismatch");
  const state = pendingStateSchema.parse({
    version: REMOTE_STATE_VERSION,
    state: "pending",
    controlPlaneUrl,
    privateKeyPem,
    linkId: response.id,
    pollSecret: response.pollSecret,
    userCode: response.userCode,
    authorizeUrl: authorizeUrl.toString(),
    expiresAt: response.expiresAt,
  });
  writeState(state);
  return publicStatus(state, true);
}

export async function getRemoteStatus(deps: RemoteClientDependencies = {}): Promise<RemoteStatus> {
  const state = readState();
  const controlPlaneUrl = state?.controlPlaneUrl ?? configuredControlPlaneUrl(deps.controlPlaneUrl);
  if (!state) return { state: "signed_out", controlPlaneUrl, serviceReachable: true };
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (state.state === "pending") {
      if (new Date(state.expiresAt).getTime() <= Date.now()) {
        clearState();
        return { state: "signed_out", controlPlaneUrl, serviceReachable: true, error: "device authorization expired" };
      }
      const result = await remoteJson<{
        status: "pending" | "approved" | "expired" | "consumed";
        deviceId?: string;
        deviceToken?: string;
        user?: { name: string; email: string; githubNumericId: string };
      }>(controlPlaneUrl, `/api/v1/device-links/${state.linkId}`, {
        headers: { "x-ocxr-link-secret": state.pollSecret },
      }, fetchImpl);
      if (result.status === "expired" || result.status === "consumed") {
        clearState();
        return { state: "signed_out", controlPlaneUrl, serviceReachable: true, error: "device authorization expired" };
      }
      if (result.status === "approved") {
        const connected = connectedStateSchema.parse({
          version: REMOTE_STATE_VERSION,
          state: "connected",
          controlPlaneUrl,
          privateKeyPem: state.privateKeyPem,
          deviceId: result.deviceId,
          deviceToken: result.deviceToken,
          account: result.user,
          passwordSet: false,
          canActivate: false,
          instance: null,
        });
        writeState(connected);
        await remoteJson(controlPlaneUrl, `/api/v1/device-links/${state.linkId}/ack`, {
          method: "POST",
          headers: { "x-ocxr-link-secret": state.pollSecret },
        }, fetchImpl);
        return getRemoteStatus(deps);
      }
      return publicStatus(state, true);
    }

    const result = await remoteJson<{ profile: {
      passwordSet: boolean;
      canActivate: boolean;
      instance: z.infer<typeof remoteInstanceSchema> | null;
    } }>(
      controlPlaneUrl,
      "/api/v1/remote/profile",
      { headers: { authorization: `Bearer ${state.deviceToken}` } },
      fetchImpl,
    );
    const instance = result.profile.instance ? remoteInstanceSchema.parse(result.profile.instance) : null;
    if (
      state.passwordSet !== result.profile.passwordSet
      || state.canActivate !== result.profile.canActivate
      || JSON.stringify(state.instance) !== JSON.stringify(instance)
    ) {
      const refreshed = {
        ...state,
        passwordSet: result.profile.passwordSet,
        canActivate: result.profile.canActivate,
        instance,
      };
      writeState(refreshed);
      return publicStatus(refreshed, true);
    }
    return publicStatus(state, true);
  } catch (error) {
    return publicStatus(state, false, safeError(error));
  }
}

export async function cancelRemoteLink(): Promise<RemoteStatus> {
  const state = readState();
  const controlPlaneUrl = state?.controlPlaneUrl ?? configuredControlPlaneUrl();
  if (state?.state === "pending") clearState();
  return { state: "signed_out", controlPlaneUrl, serviceReachable: true };
}

export async function setRemotePassword(password: string, deps: RemoteClientDependencies = {}): Promise<RemoteStatus> {
  if (password.length < 10 || password.length > 128) throw new Error("remote password must be 10 to 128 characters");
  const state = readState();
  if (!state || state.state !== "connected") throw new Error("remote account is not connected");
  await remoteJson(state.controlPlaneUrl, "/api/v1/remote/password", {
    method: "PUT",
    headers: { authorization: `Bearer ${state.deviceToken}` },
    body: { password },
  }, deps.fetchImpl ?? fetch);
  const updated = { ...state, passwordSet: true };
  writeState(updated);
  return publicStatus(updated, true);
}

export async function activateRemoteInstance(
  name: string,
  slug: string,
  deps: RemoteClientDependencies = {},
): Promise<RemoteStatus> {
  const state = readState();
  if (!state || state.state !== "connected") throw new Error("remote account is not connected");
  const result = await remoteJson<{ profile: {
    passwordSet: boolean;
    canActivate: boolean;
    instance: z.infer<typeof remoteInstanceSchema>;
  } }>(state.controlPlaneUrl, "/api/v1/remote/activate", {
    method: "POST",
    headers: { authorization: `Bearer ${state.deviceToken}` },
    body: { name, slug },
  }, deps.fetchImpl ?? fetch);
  const updated = connectedStateSchema.parse({ ...state, ...result.profile });
  writeState(updated);
  return publicStatus(updated, true);
}

export async function createRemotePairingCode(deps: RemoteClientDependencies = {}): Promise<{
  code: string;
  expiresAt: string;
}> {
  const state = readState();
  if (!state || state.state !== "connected") throw new Error("remote account is not connected");
  return remoteJson(state.controlPlaneUrl, "/api/v1/remote/pairing-code", {
    method: "POST",
    headers: { authorization: `Bearer ${state.deviceToken}` },
    body: {},
  }, deps.fetchImpl ?? fetch);
}

export async function disconnectRemoteDevice(deps: RemoteClientDependencies = {}): Promise<RemoteStatus> {
  const state = readState();
  const controlPlaneUrl = state?.controlPlaneUrl ?? configuredControlPlaneUrl(deps.controlPlaneUrl);
  if (!state) return { state: "signed_out", controlPlaneUrl, serviceReachable: true };
  if (state.state === "connected") {
    await remoteJson(state.controlPlaneUrl, "/api/v1/devices/current", {
      method: "DELETE",
      headers: { authorization: `Bearer ${state.deviceToken}` },
    }, deps.fetchImpl ?? fetch);
  }
  clearState();
  return { state: "signed_out", controlPlaneUrl, serviceReachable: true };
}
