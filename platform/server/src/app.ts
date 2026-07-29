import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import type { PlatformConfig } from "./config";
import type { PlatformAuth } from "./auth";
import type { Actor, PlatformStore } from "./store";
import { gatewayPublicKeyPem } from "./security";

interface AppVariables {
  actor: Actor | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

async function requireActor(c: Context<{ Variables: AppVariables }>): Promise<Actor | Response> {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "not found" }, 404);
  if (actor.status === "suspended") return c.json({ error: "not found" }, 404);
  return actor;
}

export function createControlPlaneApp(config: PlatformConfig, auth: PlatformAuth, store: PlatformStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", secureHeaders({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }));
  app.use("/api/v1/*", async (c, next) => {
    let actor: Actor | null = null;
    if (config.NODE_ENV !== "production" && config.PLATFORM_DEV_AUTH_GITHUB_ID) {
      const result = await store.db.query<{ id: string; name: string; email: string; github_numeric_id: string }>(
        "SELECT id,name,email,github_numeric_id FROM users WHERE github_numeric_id=$1",
        [config.PLATFORM_DEV_AUTH_GITHUB_ID],
      );
      const user = result.rows[0];
      if (user) actor = await store.authorizeUser({ id: user.id, name: user.name, email: user.email, githubNumericId: user.github_numeric_id });
    } else {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const user = session.user as typeof session.user & { githubNumericId?: string | null };
        actor = await store.authorizeUser({
          id: user.id,
          name: user.name,
          email: user.email,
          githubNumericId: user.githubNumericId,
        });
      }
    }
    c.set("actor", actor);
    await next();
  });

  app.on(["GET", "POST"], "/api/auth/*", c => auth.handler(c.req.raw));
  app.get("/healthz", c => c.json({ ok: true, service: "control-plane" }));

  app.get("/api/v1/me", async c => {
    const actor = await requireActor(c);
    return actor instanceof Response ? actor : c.json({ user: actor });
  });

  app.post("/api/v1/invites/redeem", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const body = z.object({ token: z.string().min(32).max(128) }).parse(await c.req.json());
    return await store.redeemInvite(actor, body.token)
      ? c.json({ ok: true })
      : c.json({ error: "invalid or expired invite" }, 400);
  });

  app.post("/api/v1/admin/invites", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ githubNumericId: z.string().regex(/^\d+$/).optional() }).parse(await c.req.json());
      return c.json(await store.createInvite(actor, body.githubNumericId), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/v1/instances", async c => {
    const actor = await requireActor(c);
    return actor instanceof Response ? actor : c.json({ instances: await store.listInstances(actor) });
  });

  app.post("/api/v1/instances", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ name: z.string(), slug: z.string() }).parse(await c.req.json());
      return c.json({ instance: await store.createInstance(actor, body) }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/v1/instances/:id", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const instance = await store.getOwnedInstance(actor, c.req.param("id"));
    return instance ? c.json({ instance }) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/v1/instances/:id/pairing-code", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json(await store.createPairingCode(actor, c.req.param("id")), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/instances/:id/tokens", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ name: z.string().max(80).default("CLI token") }).parse(await c.req.json());
      return c.json(await store.issueDataToken(actor, c.req.param("id"), body.name), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/instances/:id/authorize", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ url: await store.issueInstanceAuthorization(actor, c.req.param("id")) }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/v1/instances/:id/suspend", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      await store.suspendInstance(actor, c.req.param("id"));
      return c.json({ ok: true }, 202);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.delete("/api/v1/instances/:id", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      await store.deleteInstance(actor, c.req.param("id"));
      return c.json({ ok: true }, 202);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/agent/pair", async c => {
    try {
      const body = z.object({
        code: z.string().length(12),
        publicKey: z.string().min(40).max(512),
        version: z.string().min(1).max(64),
      }).parse(await c.req.json());
      const paired = await store.consumePairingCode({
        code: body.code,
        publicKeyDer: Buffer.from(body.publicKey, "base64url"),
        version: body.version,
      });
      return c.json({
        ...paired,
        gateway: {
          issuer: config.PLATFORM_GATEWAY_ISSUER,
          keys: [{ kid: config.PLATFORM_GATEWAY_KID, publicKeyPem: gatewayPublicKeyPem(config) }],
        },
      }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/agent/challenge", async c => {
    try {
      const body = z.object({ agentId: z.string().uuid(), clientNonce: z.string() }).parse(await c.req.json());
      return c.json({ challenge: await store.createAgentChallenge(body.agentId, body.clientNonce) });
    } catch {
      return c.json({ error: "agent not found" }, 404);
    }
  });

  app.post("/agent/token", async c => {
    try {
      const body = z.object({ agentId: z.string().uuid(), challenge: z.string(), signature: z.string() }).parse(await c.req.json());
      return c.json(await store.exchangeAgentChallenge(
        body.agentId,
        body.challenge,
        Buffer.from(body.signature, "base64url"),
      ));
    } catch {
      return c.json({ error: "challenge rejected" }, 401);
    }
  });

  app.post("/agent/heartbeat", async c => {
    try {
      const body = z.object({ opencodexHealthy: z.boolean(), version: z.string().max(64) }).parse(await c.req.json());
      return c.json(await store.heartbeat(bearer(c.req.raw), body));
    } catch {
      return c.json({ error: "agent authentication required" }, 401);
    }
  });

  app.get("*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
  app.notFound(c => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "invalid request", issues: error.issues }, 400);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
