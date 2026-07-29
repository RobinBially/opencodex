import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { verifyRemoteManagementAssertion } from "../../../src/server/remote-assertion";
import { createPlatformAuth } from "../src/auth";
import { loadPlatformConfig } from "../src/config";
import { Database } from "../src/db";
import { PlatformStore } from "../src/store";

const adminDatabaseUrl = process.env.PLATFORM_TEST_DATABASE_URL;
const postgresTest = adminDatabaseUrl ? test : test.skip;

async function reservePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate a test port");
  return port;
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`integration wait timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function stopProcess(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await Promise.race([process.exited, Bun.sleep(2_000)]);
  if (process.exitCode === null) process.kill(9);
}

function fixedSizeBody(size: number): ReadableStream<Uint8Array> {
  const chunkSize = 1024 * 1024;
  let remaining = size;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, remaining);
      remaining -= length;
      controller.enqueue(new Uint8Array(length).fill(0x61));
    },
  });
}

async function readSize(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return size;
    size += chunk.value.byteLength;
  }
}

postgresTest("PostgreSQL 17 auth, lifecycle, isolation, and streaming stay compatible", async () => {
  const databaseName = `ocxr_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const quotedDatabaseName = `"${databaseName}"`;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  const databaseUrl = new URL(adminDatabaseUrl!);
  databaseUrl.pathname = `/${databaseName}`;

  const processes: Array<ReturnType<typeof Bun.spawn>> = [];
  let database: Database | null = null;
  let fakeAgent: ReturnType<typeof Bun.serve> | null = null;

  try {
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseName}`);
    const migration = readFileSync(join(import.meta.dir, "..", "migrations", "0001_remote_platform.sql"), "utf8");
    const migrationPool = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
    try {
      await migrationPool.query(migration);
    } finally {
      await migrationPool.end();
    }

    const controlPort = await reservePort();
    const gatewayPort = await reservePort();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const environment = {
      ...process.env,
      NODE_ENV: "test",
      PLATFORM_DATABASE_URL: databaseUrl.toString(),
      PLATFORM_BASE_URL: `http://127.0.0.1:${controlPort}`,
      PLATFORM_INSTANCE_DOMAIN: "instances.example.test",
      PLATFORM_BOOTSTRAP_GITHUB_ID: "999999",
      PLATFORM_DEV_AUTH_GITHUB_ID: "111111",
      PLATFORM_GATEWAY_ISSUER: "ocxr-integration",
      PLATFORM_GATEWAY_KID: "integration-key",
      PLATFORM_GATEWAY_PRIVATE_KEY: privateKeyPem,
      PLATFORM_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      PLATFORM_AUDIT_HMAC_KEY: randomBytes(32).toString("base64url"),
      PLATFORM_SYNTHETIC_HEALTH_TOKEN: randomBytes(32).toString("base64url"),
      PLATFORM_CONTROL_PORT: String(controlPort),
      PLATFORM_GATEWAY_PORT: String(gatewayPort),
      CLOUDFLARE_MESH_ENABLED: "false",
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      GITHUB_CLIENT_ID: "integration-client",
      GITHUB_CLIENT_SECRET: "integration-secret",
    } satisfies NodeJS.ProcessEnv;
    const config = loadPlatformConfig(environment);
    database = new Database(databaseUrl.toString());
    const auth = createPlatformAuth(config, database);
    const adapter = (await auth.$context).internalAdapter;

    const firstUserInput = {
      name: "First User",
      email: "FIRST@EXAMPLE.TEST",
      emailVerified: true,
      image: null,
      githubNumericId: "111111",
    } as Parameters<typeof adapter.createOAuthUser>[0] & { githubNumericId: string };
    const secondUserInput = {
      name: "Second User",
      email: "second@example.test",
      emailVerified: true,
      image: null,
      githubNumericId: "222222",
    } as Parameters<typeof adapter.createOAuthUser>[0] & { githubNumericId: string };
    const first = await adapter.createOAuthUser(
      firstUserInput,
      {
        accountId: "111111",
        providerId: "github",
        accessToken: "fake-first-access-token",
        scope: "read:user user:email",
      },
    );
    const second = await adapter.createOAuthUser(
      secondUserInput,
      {
        accountId: "222222",
        providerId: "github",
        accessToken: "fake-second-access-token",
        scope: "read:user user:email",
      },
    );
    expect(first.user.email).toBe("first@example.test");
    const persistedFirstUser = await database.query<{
      githubNumericId: string;
      role: string;
      status: string;
    }>(
      "SELECT github_numeric_id AS \"githubNumericId\",role::text,status::text FROM users WHERE id=$1",
      [first.user.id],
    );
    expect(persistedFirstUser.rows[0]).toEqual({
      githubNumericId: "111111",
      role: "user",
      status: "pending_invite",
    });

    const session = await adapter.createSession(first.user.id, false, {
      ipAddress: "127.0.0.1",
      userAgent: "ocxr-postgres-integration",
    });
    expect((await adapter.findSession(session.token))?.user.id).toBe(first.user.id);
    await adapter.createVerificationValue({
      identifier: "postgres-integration",
      value: "opaque-verification-value",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await adapter.findVerificationValue("postgres-integration"))?.value).toBe("opaque-verification-value");
    expect((await adapter.findAccountByProviderId("111111", "github"))?.userId).toBe(first.user.id);

    await database.query("UPDATE users SET status='active' WHERE id IN ($1,$2)", [first.user.id, second.user.id]);
    const store = new PlatformStore(database, config);
    const secondActor = await store.authorizeUser({
      id: second.user.id,
      name: second.user.name,
      email: second.user.email,
      githubNumericId: "222222",
    });
    if (!secondActor) throw new Error("second actor was not authorized");

    let firstInstanceId: string | null = null;
    let upstreamStreamCancelled = false;
    fakeAgent = Bun.serve({
      hostname: "127.0.0.1",
      port: 10101,
      async fetch(request, server) {
        const assertionValid = firstInstanceId !== null && verifyRemoteManagementAssertion(
          new Request(request.url, { method: request.method, headers: request.headers }),
          {
            remoteAccess: {
              enabled: true,
              instanceId: firstInstanceId,
              issuer: environment.PLATFORM_GATEWAY_ISSUER,
              publicKeys: [{ kid: environment.PLATFORM_GATEWAY_KID, publicKeyPem }],
            },
          } as never,
        );
        const url = new URL(request.url);
        if (!assertionValid) return new Response("Not found", { status: 404 });
        if (url.pathname === "/v1/socket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upgraded = server.upgrade(request, {
            data: {
              assertionValid,
              authorization: request.headers.get("authorization"),
              cookie: request.headers.get("cookie"),
              forwardedFor: request.headers.get("x-forwarded-for"),
              host: request.headers.get("host"),
              origin: request.headers.get("origin"),
            },
          });
          return upgraded ? undefined : new Response("upgrade failed", { status: 502 });
        }
        if (url.pathname === "/v1/sse") {
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              setTimeout(() => {
                controller.enqueue(encoder.encode("data: second\n\n"));
                controller.close();
              }, 30);
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname === "/v1/stream-until-abort") {
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("ready\n"));
            },
            cancel() {
              upstreamStreamCancelled = true;
            },
          }), { headers: { "content-type": "application/octet-stream" } });
        }
        if (url.pathname === "/v1/echo-bytes") {
          return Response.json({ bytes: await readSize(request.body) });
        }
        if (url.pathname === "/v1/large-response") {
          return new Response(fixedSizeBody(100 * 1024 * 1024), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({
          assertionValid,
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          forwardedFor: request.headers.get("x-forwarded-for"),
          host: request.headers.get("host"),
          origin: request.headers.get("origin"),
          targetPath: request.headers.get("x-ocxr-target-path"),
        }, {
          headers: {
            "cf-ray": "must-not-leak",
            location: "http://127.0.0.1:10100/redirect",
            "set-cookie": "upstream=must-not-leak",
            "x-ocxr-private": "must-not-leak",
          },
        });
      },
      websocket: {
        open(socket) {
          socket.send(JSON.stringify(socket.data));
        },
        message(socket, message) {
          socket.send(message);
        },
      },
    });

    const platformRoot = join(import.meta.dir, "..", "..");
    const spawnService = (entrypoint: string) => {
      const child = Bun.spawn([process.execPath, entrypoint], {
        cwd: platformRoot,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.push(child);
      return child;
    };
    const control = spawnService("server/src/control-plane.ts");
    let gateway = spawnService("server/src/gateway.ts");
    const worker = spawnService("server/src/worker.ts");

    await waitFor(async () => {
      if (control.exitCode !== null || gateway.exitCode !== null || worker.exitCode !== null) {
        throw new Error("a platform process exited during startup");
      }
      const response = await fetch(`http://127.0.0.1:${controlPort}/healthz`);
      return response.ok ? true : null;
    });
    const spa = await fetch(`http://127.0.0.1:${controlPort}/instances/first`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
    expect(await spa.text()).toContain("<title>OpenCodex Remote</title>");
    const missingApi = await fetch(`http://127.0.0.1:${controlPort}/api/v1/not-a-route`);
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/json");

    const createResponse = await fetch(`http://127.0.0.1:${controlPort}/api/v1/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "First Instance", slug: "first" }),
    });
    expect(createResponse.status).toBe(202);
    const createdFirst = await createResponse.json() as { instance: { id: string } };
    firstInstanceId = createdFirst.instance.id;
    const createdSecond = await store.createInstance(secondActor, { name: "Second Instance", slug: "second" });

    await waitFor(async () => {
      const state = await database!.query<{ id: string; status: string }>(
        "SELECT id,status::text FROM instances WHERE id IN ($1,$2) ORDER BY id",
        [firstInstanceId, createdSecond.id],
      );
      const resources = await database!.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM cloudflare_resources WHERE instance_id IN ($1,$2)",
        [firstInstanceId, createdSecond.id],
      );
      return state.rows.length === 2
        && state.rows.every(row => row.status === "awaiting_agent")
        && resources.rows[0]?.count === 4
        ? true
        : null;
    });
    await stopProcess(worker);

    const invisible = await fetch(`http://127.0.0.1:${controlPort}/api/v1/instances/${createdSecond.id}`);
    expect(invisible.status).toBe(404);

    const tokenResponse = await fetch(
      `http://127.0.0.1:${controlPort}/api/v1/instances/${firstInstanceId}/tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "integration" }),
      },
    );
    expect(tokenResponse.status).toBe(201);
    const firstToken = (await tokenResponse.json() as { token: string }).token;
    const secondToken = (await store.issueDataToken(secondActor, createdSecond.id, "integration")).token;
    await database.query(
      `UPDATE instances SET private_hostname=CASE id WHEN $1 THEN '127.0.0.1' ELSE 'localhost' END,
       status='online',updated_at=now() WHERE id IN ($1,$2)`,
      [firstInstanceId, createdSecond.id],
    );

    const gatewayRequest = (host: string, token?: string) => fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models?z=2&a=1`,
      {
        headers: {
          host,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          cookie: "official-session=must-not-leak",
          "x-forwarded-for": "203.0.113.10",
          "x-opencodex-api-key": "must-not-leak",
        },
        redirect: "manual",
      },
    );
    const allowed = await gatewayRequest("first.instances.example.test", firstToken);
    expect(allowed.status).toBe(200);
    const upstream = await allowed.json() as Record<string, string | boolean | null>;
    expect(upstream.assertionValid).toBe(true);
    expect(upstream.authorization).toBeNull();
    expect(upstream.cookie).toBeNull();
    expect(upstream.forwardedFor).toBeNull();
    expect(upstream.host).toBe("127.0.0.1:10100");
    expect(upstream.origin).toBe("http://127.0.0.1:10100");
    expect(upstream.targetPath).toBe("/v1/models?z=2&a=1");
    expect(allowed.headers.get("set-cookie")).toBeNull();
    expect(allowed.headers.get("cf-ray")).toBeNull();
    expect(allowed.headers.get("x-ocxr-private")).toBeNull();
    expect(allowed.headers.get("location")).toBe("https://first.instances.example.test/redirect");

    expect((await gatewayRequest("first.instances.example.test", secondToken)).status).toBe(404);
    expect((await gatewayRequest("second.instances.example.test", firstToken)).status).toBe(404);
    expect((await gatewayRequest("first.instances.example.test")).status).toBe(404);
    expect((await gatewayRequest("second.instances.example.test", secondToken)).status).toBe(404);

    const firstAuthorization = await fetch(
      `http://127.0.0.1:${controlPort}/api/v1/instances/${firstInstanceId}/authorize`,
      { method: "POST" },
    );
    expect(firstAuthorization.status).toBe(201);
    const firstAuthorizationUrl = new URL((await firstAuthorization.json() as { url: string }).url);
    const firstExchange = await fetch(
      `http://127.0.0.1:${gatewayPort}${firstAuthorizationUrl.pathname}${firstAuthorizationUrl.search}`,
      { headers: { host: "first.instances.example.test" }, redirect: "manual" },
    );
    expect(firstExchange.status).toBe(302);
    const firstSessionCookie = firstExchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(firstSessionCookie).toStartWith("__Host-ocxr_instance=");
    const secondAuthorizationUrl = new URL(await store.issueInstanceAuthorization(secondActor, createdSecond.id));
    const secondExchange = await fetch(
      `http://127.0.0.1:${gatewayPort}${secondAuthorizationUrl.pathname}${secondAuthorizationUrl.search}`,
      { headers: { host: "second.instances.example.test" }, redirect: "manual" },
    );
    expect(secondExchange.status).toBe(302);
    const secondSessionCookie = secondExchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(secondSessionCookie).toStartWith("__Host-ocxr_instance=");
    const browserRequest = (host: string, cookie: string | undefined) => fetch(
      `http://127.0.0.1:${gatewayPort}/api/config`,
      { headers: { host, ...(cookie ? { cookie } : {}) } },
    );
    expect((await browserRequest("first.instances.example.test", firstSessionCookie)).status).toBe(200);
    expect((await browserRequest("second.instances.example.test", firstSessionCookie)).status).toBe(404);
    expect((await browserRequest("first.instances.example.test", secondSessionCookie)).status).toBe(404);

    const sse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/sse`, {
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    expect(await sse.text()).toBe("data: first\n\ndata: second\n\n");

    const hundredMiB = 100 * 1024 * 1024;
    const upload = await fetch(`http://127.0.0.1:${gatewayPort}/v1/echo-bytes`, {
      method: "POST",
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
      body: fixedSizeBody(hundredMiB),
      duplex: "half",
    } as RequestInit);
    expect(upload.status).toBe(200);
    expect((await upload.json() as { bytes: number }).bytes).toBe(hundredMiB);
    const download = await fetch(`http://127.0.0.1:${gatewayPort}/v1/large-response`, {
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
    });
    expect(download.status).toBe(200);
    expect(await readSize(download.body)).toBe(hundredMiB);

    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/socket`, {
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
    } as never);
    const socketMessages: string[] = [];
    socket.addEventListener("message", event => socketMessages.push(String(event.data)));
    await waitFor(async () => socketMessages.length ? true : null);
    const socketHeaders = JSON.parse(socketMessages[0]) as Record<string, string | boolean | null>;
    expect(socketHeaders.assertionValid).toBe(true);
    expect(socketHeaders.authorization).toBeNull();
    expect(socketHeaders.cookie).toBeNull();
    expect(socketHeaders.forwardedFor).toBeNull();
    expect(socketHeaders.host).toBe("127.0.0.1:10100");
    expect(socketHeaders.origin).toBe("http://127.0.0.1:10100");
    socket.send("socket-round-trip");
    await waitFor(async () => socketMessages.includes("socket-round-trip") ? true : null);
    socket.close();

    await stopProcess(gateway);
    gateway = spawnService("server/src/gateway.ts");
    await waitFor(async () => {
      if (gateway.exitCode !== null) throw new Error("gateway exited during restart");
      const response = await gatewayRequest("first.instances.example.test", firstToken);
      return response.status === 200 ? true : null;
    });

    const revokedSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/socket`, {
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
    } as never);
    let revokedSocketOpened = false;
    let revokedSocketClose: { code: number; reason: string } | null = null;
    revokedSocket.addEventListener("message", () => { revokedSocketOpened = true; });
    revokedSocket.addEventListener("close", event => {
      revokedSocketClose = { code: event.code, reason: event.reason };
    });
    await waitFor(async () => revokedSocketOpened ? true : null);

    const longStream = await fetch(`http://127.0.0.1:${gatewayPort}/v1/stream-until-abort`, {
      headers: { host: "first.instances.example.test", authorization: `Bearer ${firstToken}` },
    });
    expect(longStream.status).toBe(200);
    const longReader = longStream.body!.getReader();
    expect(new TextDecoder().decode((await longReader.read()).value)).toBe("ready\n");

    const suspend = await fetch(
      `http://127.0.0.1:${controlPort}/api/v1/instances/${firstInstanceId}/suspend`,
      { method: "POST" },
    );
    expect(suspend.status).toBe(202);
    const streamClosed = await Promise.race([
      longReader.read().then(result => result.done).catch(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    expect(streamClosed).toBe(true);
    await waitFor(async () => upstreamStreamCancelled ? true : null, 5_000);
    await waitFor(async () => revokedSocketClose ? true : null, 5_000);
    const observedSocketClose = revokedSocketClose as unknown as { code: number; reason: string };
    expect(observedSocketClose).toEqual({ code: 1008, reason: "instance disabled" });
    expect((await gatewayRequest("first.instances.example.test", firstToken)).status).toBe(404);

    await adapter.deleteVerificationByIdentifier("postgres-integration");
  } finally {
    await Promise.all(processes.map(stopProcess));
    if (fakeAgent) await fakeAgent.stop(true);
    if (database) await database.close();
    await adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
    await adminPool.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName}`);
    await adminPool.end();
  }
}, 60_000);
