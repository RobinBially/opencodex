import { timingSafeEqual } from "node:crypto";
import { loadPlatformConfig } from "./config";
import { Database } from "./db";
import { GATEWAY_ASSERTION_HEADER, signGatewayAssertion } from "./security";
import { PlatformStore, type InstanceRecord } from "./store";

const config = loadPlatformConfig();
const database = new Database(config.PLATFORM_DATABASE_URL);
const store = new PlatformStore(database, config);

const INSTANCE_COOKIE = "__Host-ocxr_instance";
const REQUEST_HEADER_DENY = new Set([
  "connection", "cookie", "host", "proxy-authorization", "proxy-authenticate",
  "upgrade",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "x-opencodex-api-key", GATEWAY_ASSERTION_HEADER, "x-ocxr-synthetic",
  "x-opencodex-remote-token",
]);
const RESPONSE_HEADER_DENY = new Set([
  "connection", "set-cookie", "set-cookie2", "proxy-authenticate", "proxy-authorization",
  GATEWAY_ASSERTION_HEADER,
]);

function cookieValue(req: Request, name: string): string | null {
  for (const segment of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = segment.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function safeEqual(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function remoteCredential(req: Request): string | null {
  const explicit = req.headers.get("x-opencodex-remote-token")?.trim();
  if (explicit) return `Bearer ${explicit}`;
  const authorization = req.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  return token?.startsWith("ocxr_") ? authorization : null;
}

function browserAccessRedirect(req: Request): Response | null {
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() === "websocket") return null;
  const acceptsHtml = req.headers.get("sec-fetch-dest") === "document"
    || (req.headers.get("accept") ?? "").includes("text/html");
  if (!acceptsHtml) return null;
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) return null;
  return new Response(null, {
    status: 302,
    headers: {
      location: `${config.PLATFORM_BASE_URL.replace(/\/$/, "")}/access/${encodeURIComponent(slug)}`,
      "cache-control": "no-store",
    },
  });
}

function sanitizeRequestHeaders(req: Request, target: URL, assertion: string): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (
      REQUEST_HEADER_DENY.has(lower)
      || lower.startsWith("cf-")
      || lower.startsWith("sec-websocket-")
      || lower.startsWith("x-ocxr-")
    ) continue;
    if (lower === "authorization" && value.replace(/^Bearer\s+/i, "").startsWith("ocxr_")) continue;
    headers.append(name, value);
  }
  headers.set("host", "127.0.0.1:10100");
  headers.set("origin", "http://127.0.0.1:10100");
  headers.set(GATEWAY_ASSERTION_HEADER, assertion);
  headers.set("x-ocxr-target-path", `${target.pathname}${target.search}`);
  return headers;
}

function sanitizeResponseHeaders(response: Response, publicHost: string): Headers {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (RESPONSE_HEADER_DENY.has(lower) || lower.startsWith("cf-") || lower.startsWith("x-ocxr-")) continue;
    if (lower === "location") {
      headers.set(name, value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):10100/i, `https://${publicHost}`));
    } else {
      headers.append(name, value);
    }
  }
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function privateUrl(instance: InstanceRecord, requestUrl: URL): URL {
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://${instance.privateHostname}:10101`);
}

const activeRequests = new Map<string, Set<AbortController>>();
const activeSockets = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>();
function track(instanceId: string, controller: AbortController): () => void {
  const set = activeRequests.get(instanceId) ?? new Set<AbortController>();
  set.add(controller);
  activeRequests.set(instanceId, set);
  return () => {
    set.delete(controller);
    if (!set.size) activeRequests.delete(instanceId);
  };
}

function trackSocket(socket: Bun.ServerWebSocket<SocketData>): void {
  const instanceId = socket.data.instance.id;
  const sockets = activeSockets.get(instanceId) ?? new Set<Bun.ServerWebSocket<SocketData>>();
  sockets.add(socket);
  activeSockets.set(instanceId, sockets);
}

function untrackSocket(socket: Bun.ServerWebSocket<SocketData>): void {
  const instanceId = socket.data.instance.id;
  const sockets = activeSockets.get(instanceId);
  sockets?.delete(socket);
  if (!sockets?.size) activeSockets.delete(instanceId);
}

function streamWithLifecycle(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  return new ReadableStream({
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          output.close();
        } else {
          output.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        output.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

async function listenForRevocations(): Promise<void> {
  const client = await database.pool.connect();
  client.on("notification", message => {
    if (message.channel !== "instance_state" || !message.payload) return;
    try {
      const { instanceId } = JSON.parse(message.payload) as { instanceId: string };
      for (const controller of activeRequests.get(instanceId) ?? []) controller.abort("instance disabled");
      for (const socket of activeSockets.get(instanceId) ?? []) socket.close(1008, "instance disabled");
      activeRequests.delete(instanceId);
      activeSockets.delete(instanceId);
    } catch { /* malformed NOTIFY payload is ignored */ }
  });
  client.on("error", error => console.error("gateway PostgreSQL listener failed", error.message));
  await client.query("LISTEN instance_state");
}

interface SocketData {
  instance: InstanceRecord;
  userId: string;
  url: URL;
  headers: Headers;
  queued: Array<string | Buffer>;
  upstream?: WebSocket;
}

let gatewayServer: Bun.Server<SocketData>;

async function authenticate(req: Request): Promise<{ instance: InstanceRecord; userId: string } | null> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? "";
  if (url.pathname === "/healthz" && safeEqual(req.headers.get("x-ocxr-synthetic"), config.syntheticHealthToken)) {
    const result = await store.resolveGatewayRequest(host, null, null, "/_synthetic");
    if (result) return { ...result, userId: "synthetic-health" };
    // Synthetic health still needs to resolve an active instance, but has no
    // user session. Resolve it through a constrained direct query.
    const slug = host.toLowerCase().replace(/:\d+$/, "").replace(`.${config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`, "");
    const found = await database.query<{
      id: string; owner_id: string; name: string; slug: string; private_hostname: string;
      status: InstanceRecord["status"]; created_at: Date; updated_at: Date;
    }>(`SELECT i.* FROM instances i JOIN users u ON u.id=i.owner_id
        WHERE i.slug=$1 AND i.status IN ('connecting','online','degraded','offline') AND i.deleted_at IS NULL AND u.status='active'`, [slug]);
    const row = found.rows[0];
    return row ? { userId: "synthetic-health", instance: {
      id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug,
      privateHostname: row.private_hostname, status: row.status,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    } } : null;
  }
  return store.resolveGatewayRequest(
    host,
    remoteCredential(req),
    cookieValue(req, INSTANCE_COOKIE),
    url.pathname,
  );
}

gatewayServer = Bun.serve<SocketData>({
  port: config.PLATFORM_GATEWAY_PORT,
  hostname: config.PLATFORM_GATEWAY_HOST,
  async fetch(req, server) {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (url.pathname === "/_ocxr/exchange" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const exchanged = code ? await store.exchangeInstanceAuthorization(host, code) : null;
      if (!exchanged) return new Response("Not found", { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${INSTANCE_COOKIE}=${encodeURIComponent(exchanged.token)}; Path=/; Expires=${exchanged.expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }

    const auth = await authenticate(req);
    if (!auth) {
      return browserAccessRedirect(req)
        ?? new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const target = privateUrl(auth.instance, url);
    const assertion = signGatewayAssertion(config, {
      instanceId: auth.instance.id,
      userId: auth.userId,
      method: req.method,
      url,
    });
    const headers = sanitizeRequestHeaders(req, target, assertion);

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const wsTarget = new URL(target);
      wsTarget.protocol = "ws:";
      const upgraded = server.upgrade(req, {
        data: { instance: auth.instance, userId: auth.userId, url: wsTarget, headers, queued: [] },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 502 });
    }

    const controller = new AbortController();
    const untrack = track(auth.instance.id, controller);
    const abort = () => controller.abort(req.signal.reason);
    const cleanup = () => {
      req.signal.removeEventListener("abort", abort);
      untrack();
    };
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        signal: controller.signal,
        // Required by Bun for streaming request bodies.
        duplex: req.body ? "half" : undefined,
      } as RequestInit);
      if (url.pathname === "/healthz") await store.recordHealth(auth.instance.id, "gateway", response.ok);
      const body = response.body
        ? streamWithLifecycle(response.body, controller, cleanup)
        : null;
      if (!body) cleanup();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response, host),
      });
    } catch {
      cleanup();
      if (url.pathname === "/healthz") await store.recordHealth(auth.instance.id, "gateway", false);
      return new Response("Upstream unavailable", { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      trackSocket(ws);
      const upstream = new WebSocket(ws.data.url, { headers: Object.fromEntries(ws.data.headers) } as never);
      ws.data.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.addEventListener("open", () => {
        for (const message of ws.data.queued.splice(0)) upstream.send(message);
      });
      upstream.addEventListener("message", event => {
        if (typeof event.data === "string") ws.send(event.data);
        else if (event.data instanceof ArrayBuffer) ws.send(event.data);
      });
      upstream.addEventListener("close", event => ws.close(event.code, event.reason));
      upstream.addEventListener("error", () => ws.close(1011, "upstream error"));
    },
    message(ws, message) {
      if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      else ws.data.queued.push(typeof message === "string" ? message : Buffer.from(message));
    },
    close(ws, code, reason) {
      untrackSocket(ws);
      if (ws.data.upstream && ws.data.upstream.readyState < WebSocket.CLOSING) ws.data.upstream.close(code, reason);
    },
  },
});

void listenForRevocations();
console.log(`OpenCodex Remote gateway listening on ${config.PLATFORM_GATEWAY_HOST}:${config.PLATFORM_GATEWAY_PORT}`);
