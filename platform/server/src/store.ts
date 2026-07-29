import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "./db";
import type { PlatformConfig } from "./config";
import {
  decryptSecret,
  encryptSecret,
  issueOpaqueToken,
  issueShortCode,
  networkSignalHmac,
  sha256,
} from "./security";

export type InstanceStatus =
  | "pending" | "provisioning" | "awaiting_agent" | "connecting" | "online"
  | "degraded" | "offline" | "suspending" | "suspended" | "deleting"
  | "delete_failed" | "deleted";

export interface Actor {
  id: string;
  githubNumericId: string;
  role: "user" | "admin";
  status: "active" | "pending_invite" | "suspended";
  name: string;
  email: string;
}

export interface InstanceRecord {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  privateHostname: string;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}

interface InstanceRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  private_hostname: string;
  status: InstanceStatus;
  created_at: Date;
  updated_at: Date;
}

function instanceFromRow(row: InstanceRow): InstanceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    privateHostname: row.private_hostname,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function duplicateConstraint(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23505";
}

export class PlatformStore {
  constructor(readonly db: Database, readonly config: PlatformConfig) {}

  async authorizeUser(user: { id: string; name: string; email: string; githubNumericId?: string | null }): Promise<Actor | null> {
    if (!user.githubNumericId) return null;
    if (user.githubNumericId === this.config.PLATFORM_BOOTSTRAP_GITHUB_ID) {
      await this.db.query(
        "UPDATE users SET role='admin', status='active', updated_at=now() WHERE id=$1 AND github_numeric_id=$2",
        [user.id, user.githubNumericId],
      );
    }
    const result = await this.db.query<{
      id: string; name: string; email: string; github_numeric_id: string;
      role: "user" | "admin"; status: Actor["status"];
    }>("SELECT id,name,email,github_numeric_id,role,status FROM users WHERE id=$1", [user.id]);
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, email: row.email, githubNumericId: row.github_numeric_id, role: row.role, status: row.status } : null;
  }

  async redeemInvite(actor: Actor, token: string): Promise<boolean> {
    const result = await this.db.transaction(async client => {
      const invite = await client.query<{ id: string; expected_github_numeric_id: string | null }>(
        `SELECT id,expected_github_numeric_id FROM invites
         WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [sha256(token)],
      );
      const row = invite.rows[0];
      if (!row || (row.expected_github_numeric_id && row.expected_github_numeric_id !== actor.githubNumericId)) return false;
      await client.query("UPDATE invites SET consumed_at=now(),consumed_by=$2 WHERE id=$1", [row.id, actor.id]);
      await client.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1", [actor.id]);
      return true;
    });
    return result;
  }

  async createInvite(actor: Actor, expectedGithubNumericId?: string): Promise<{ token: string; expiresAt: string }> {
    if (actor.role !== "admin" || actor.status !== "active") throw new Error("forbidden");
    const count = await this.db.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE status='active'");
    if (Number(count.rows[0]?.count ?? "0") >= 50) throw new Error("private beta user limit reached");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    await this.db.query(
      "INSERT INTO invites(token_hash,created_by,expected_github_numeric_id,expires_at) VALUES($1,$2,$3,$4)",
      [sha256(token), actor.id, expectedGithubNumericId ?? null, expiresAt],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async listInstances(actor: Actor): Promise<InstanceRecord[]> {
    const result = actor.role === "admin"
      ? await this.db.query<InstanceRow>("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY created_at DESC")
      : await this.db.query<InstanceRow>("SELECT * FROM instances WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC", [actor.id]);
    return result.rows.map(instanceFromRow);
  }

  async getOwnedInstance(actor: Actor, id: string): Promise<InstanceRecord | null> {
    const result = await this.db.query<InstanceRow>(
      `SELECT * FROM instances WHERE id=$1 AND deleted_at IS NULL AND (owner_id=$2 OR $3='admin')`,
      [id, actor.id, actor.role],
    );
    return result.rows[0] ? instanceFromRow(result.rows[0]) : null;
  }

  async createInstance(actor: Actor, input: { name: string; slug: string }): Promise<InstanceRecord> {
    if (actor.status !== "active") throw new Error("invite required");
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();
    if (name.length < 1 || name.length > 80) throw new Error("name must be 1-80 characters");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new Error("invalid slug");
    const privateHostname = `${randomBytes(20).toString("hex")}.ocxr.internal`;
    try {
      return await this.db.transaction(async client => {
        const tombstone = await client.query("SELECT 1 FROM slug_tombstones WHERE slug=$1 AND expires_at>now()", [slug]);
        if (tombstone.rowCount) throw new Error("slug is temporarily reserved");
        const result = await client.query<InstanceRow>(
          `INSERT INTO instances(owner_id,name,slug,private_hostname)
           VALUES($1,$2,$3,$4) RETURNING *`,
          [actor.id, name, slug, privateHostname],
        );
        await client.query(
          `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
           VALUES($1,'provision',$2)`,
          [result.rows[0].id, `provision:${result.rows[0].id}:v1`],
        );
        await this.audit(client, actor.id, "instance.create", result.rows[0].id, "accepted");
        return instanceFromRow(result.rows[0]);
      });
    } catch (error) {
      if (duplicateConstraint(error)) throw new Error("slug is unavailable or instance limit reached");
      throw error;
    }
  }

  async createPairingCode(actor: Actor, instanceId: string): Promise<{ code: string; expiresAt: string }> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance || !["awaiting_agent", "connecting", "offline"].includes(instance.status)) throw new Error("instance is not ready for pairing");
    const code = issueShortCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.db.transaction(async client => {
      await client.query("UPDATE pairing_codes SET consumed_at=now() WHERE instance_id=$1 AND consumed_at IS NULL", [instanceId]);
      await client.query("INSERT INTO pairing_codes(instance_id,code_hash,expires_at) VALUES($1,$2,$3)", [instanceId, sha256(code), expiresAt]);
      await this.audit(client, actor.id, "pairing_code.create", instanceId, "success");
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async consumePairingCode(input: { code: string; publicKeyDer: Buffer; version: string }): Promise<{
    agentId: string; instanceId: string; tunnelToken: string;
  }> {
    if (input.publicKeyDer.length < 32 || input.publicKeyDer.length > 256) throw new Error("invalid Ed25519 public key");
    return this.db.transaction(async client => {
      const pairing = await client.query<{ id: string; instance_id: string }>(
        `SELECT id,instance_id FROM pairing_codes
         WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [sha256(input.code.trim().toUpperCase())],
      );
      const row = pairing.rows[0];
      if (!row) throw new Error("invalid or expired pairing code");
      const agent = await client.query<{ id: string }>(
        `INSERT INTO agents(instance_id,public_key,version)
         VALUES($1,$2,$3)
         ON CONFLICT(instance_id) DO UPDATE SET public_key=excluded.public_key,version=excluded.version,
           status='paired',revoked_at=NULL,auth_token_hash=NULL,auth_token_expires_at=NULL
         RETURNING id`,
        [row.instance_id, input.publicKeyDer, input.version],
      );
      const resource = await client.query<{ encrypted_secret: Buffer }>(
        "SELECT encrypted_secret FROM cloudflare_resources WHERE instance_id=$1 AND resource_type='tunnel' AND deleted_at IS NULL",
        [row.instance_id],
      );
      if (!resource.rows[0]?.encrypted_secret) throw new Error("tunnel token is not provisioned");
      await client.query("UPDATE pairing_codes SET consumed_at=now() WHERE id=$1", [row.id]);
      await client.query("UPDATE instances SET status='connecting',updated_at=now() WHERE id=$1", [row.instance_id]);
      return {
        agentId: agent.rows[0].id,
        instanceId: row.instance_id,
        tunnelToken: decryptSecret(resource.rows[0].encrypted_secret, this.config.encryptionKey),
      };
    });
  }

  async createAgentChallenge(agentId: string, clientNonce: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientNonce)) throw new Error("invalid client nonce");
    const challenge = `${agentId}.${clientNonce}.${randomBytes(32).toString("base64url")}`;
    const result = await this.db.query(
      `UPDATE agents SET challenge_hash=$2,challenge_expires_at=now()+interval '60 seconds'
       WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
      [agentId, sha256(challenge)],
    );
    if (!result.rowCount) throw new Error("agent not found");
    return challenge;
  }

  async exchangeAgentChallenge(agentId: string, challenge: string, signature: Buffer): Promise<{ token: string; expiresAt: string }> {
    return this.db.transaction(async client => {
      const result = await client.query<{ public_key: Buffer; challenge_hash: Buffer }>(
        `SELECT public_key,challenge_hash FROM agents
         WHERE id=$1 AND revoked_at IS NULL AND challenge_expires_at>now() FOR UPDATE`,
        [agentId],
      );
      const agent = result.rows[0];
      if (!agent || !agent.challenge_hash.equals(sha256(challenge))) throw new Error("challenge expired");
      const publicKey = createPublicKey({ key: agent.public_key, format: "der", type: "spki" });
      if (!verify(null, Buffer.from(challenge), publicKey, signature)) throw new Error("invalid challenge signature");
      const token = issueOpaqueToken("ocxr_agent_");
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await client.query(
        `UPDATE agents SET auth_token_hash=$2,auth_token_expires_at=$3,challenge_hash=NULL,challenge_expires_at=NULL
         WHERE id=$1`,
        [agentId, sha256(token), expiresAt],
      );
      return { token, expiresAt: expiresAt.toISOString() };
    });
  }

  async heartbeat(token: string, input: { opencodexHealthy: boolean; version: string }): Promise<{ instanceId: string }> {
    const result = await this.db.query<{ instance_id: string }>(
      `UPDATE agents SET last_heartbeat_at=now(),version=$2
       WHERE auth_token_hash=$1 AND auth_token_expires_at>now() AND revoked_at IS NULL
       RETURNING instance_id`,
      [sha256(token), input.version],
    );
    const row = result.rows[0];
    if (!row) throw new Error("agent token expired");
    await this.recordHealth(row.instance_id, "agent", input.opencodexHealthy);
    return { instanceId: row.instance_id };
  }

  async issueDataToken(actor: Actor, instanceId: string, name: string): Promise<{ token: string; expiresAt: string }> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance || ["suspended", "deleting", "deleted"].includes(instance.status)) throw new Error("instance not found");
    const token = issueOpaqueToken("ocxr_");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await this.db.query(
      `INSERT INTO access_tokens(instance_id,user_id,name,token_hash,token_hint,expires_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [instanceId, actor.id, name.trim().slice(0, 80) || "CLI token", sha256(token), token.slice(-6), expiresAt],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async issueInstanceAuthorization(actor: Actor, instanceId: string): Promise<string> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance || !["online", "degraded"].includes(instance.status)) throw new Error("instance is unavailable");
    const code = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO instance_authorization_codes(instance_id,user_id,code_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '60 seconds')`,
      [instanceId, actor.id, sha256(code)],
    );
    return `https://${instance.slug}.${this.config.PLATFORM_INSTANCE_DOMAIN}/_ocxr/exchange?code=${encodeURIComponent(code)}`;
  }

  async exchangeInstanceAuthorization(host: string, code: string): Promise<{ token: string; expiresAt: Date } | null> {
    return this.db.transaction(async client => {
      const authorization = await client.query<{ id: string; instance_id: string; user_id: string }>(
        `SELECT c.id,c.instance_id,c.user_id FROM instance_authorization_codes c
         JOIN instances i ON i.id=c.instance_id
         JOIN users u ON u.id=c.user_id
         WHERE c.code_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now()
           AND i.slug=$2 AND i.status IN ('online','degraded') AND u.status='active'
         FOR UPDATE OF c`,
        [sha256(code), this.slugFromHost(host)],
      );
      const row = authorization.rows[0];
      if (!row) return null;
      const token = issueOpaqueToken("ocxr_session_");
      const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
      await client.query("UPDATE instance_authorization_codes SET consumed_at=now() WHERE id=$1", [row.id]);
      await client.query(
        "INSERT INTO instance_sessions(instance_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
        [row.instance_id, row.user_id, sha256(token), expiresAt],
      );
      return { token, expiresAt };
    });
  }

  async resolveGatewayRequest(host: string, authorization: string | null, sessionToken: string | null, path: string): Promise<{
    instance: InstanceRecord; userId: string;
  } | null> {
    const slug = this.slugFromHost(host);
    if (!slug) return null;
    const instanceResult = await this.db.query<InstanceRow>(
      `SELECT i.* FROM instances i JOIN users u ON u.id=i.owner_id
       WHERE i.slug=$1 AND i.status IN ('online','degraded') AND i.deleted_at IS NULL AND u.status='active'`,
      [slug],
    );
    const row = instanceResult.rows[0];
    if (!row) return null;
    if (path.startsWith("/v1/")) {
      const token = authorization?.replace(/^Bearer\s+/i, "").trim();
      if (token?.startsWith("ocxr_") && !token.startsWith("ocxr_session_") && !token.startsWith("ocxr_agent_")) {
        const access = await this.db.query<{ user_id: string }>(
          `UPDATE access_tokens SET last_used_at=now()
           WHERE instance_id=$1 AND token_hash=$2 AND expires_at>now() AND revoked_at IS NULL
           RETURNING user_id`,
          [row.id, sha256(token)],
        );
        return access.rows[0] ? { instance: instanceFromRow(row), userId: access.rows[0].user_id } : null;
      }
      // Browser-driven `/v1/*` calls are bound to the same instance session as
      // the GUI. A separate remote token can ride in x-opencodex-remote-token
      // when Authorization must be preserved for ChatGPT Direct.
      if (!sessionToken) return null;
    }
    if (!sessionToken) return null;
    const session = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM instance_sessions
       WHERE instance_id=$1 AND token_hash=$2 AND expires_at>now() AND revoked_at IS NULL`,
      [row.id, sha256(sessionToken)],
    );
    return session.rows[0] ? { instance: instanceFromRow(row), userId: session.rows[0].user_id } : null;
  }

  async suspendInstance(actor: Actor, instanceId: string): Promise<void> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance) throw new Error("instance not found");
    await this.db.transaction(async client => {
      await client.query("UPDATE instances SET status='suspending',suspended_at=now(),updated_at=now() WHERE id=$1", [instanceId]);
      await client.query("UPDATE agents SET revoked_at=now(),auth_token_hash=NULL WHERE instance_id=$1", [instanceId]);
      await client.query("UPDATE access_tokens SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query("UPDATE instance_sessions SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query(
        `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
         VALUES($1,'suspend',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
        [instanceId, `suspend:${instanceId}:${Date.now()}`],
      );
      await client.query("SELECT pg_notify('instance_state',$1)", [JSON.stringify({ instanceId, status: "suspending" })]);
      await this.audit(client, actor.id, "instance.suspend", instanceId, "accepted");
    });
  }

  async deleteInstance(actor: Actor, instanceId: string): Promise<void> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance) throw new Error("instance not found");
    await this.db.transaction(async client => {
      await client.query("UPDATE instances SET status='deleting',updated_at=now() WHERE id=$1", [instanceId]);
      await client.query("UPDATE agents SET revoked_at=now(),auth_token_hash=NULL WHERE instance_id=$1", [instanceId]);
      await client.query("UPDATE access_tokens SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query("UPDATE instance_sessions SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query(
        `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
         VALUES($1,'delete',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
        [instanceId, `delete:${instanceId}:v1`],
      );
      await client.query("SELECT pg_notify('instance_state',$1)", [JSON.stringify({ instanceId, status: "deleting" })]);
      await this.audit(client, actor.id, "instance.delete", instanceId, "accepted");
    });
  }

  async recordHealth(instanceId: string, signal: "agent" | "tunnel" | "gateway", healthy: boolean): Promise<void> {
    await this.db.query(
      "INSERT INTO health_observations(instance_id,signal,healthy) VALUES($1,$2,$3)",
      [instanceId, signal, healthy],
    );
  }

  async refreshComputedHealth(instanceId: string): Promise<InstanceStatus> {
    const result = await this.db.query<{ signal: string; healthy: boolean; observed_at: Date }>(
      `SELECT DISTINCT ON(signal) signal,healthy,observed_at FROM health_observations
       WHERE instance_id=$1 ORDER BY signal,observed_at DESC`,
      [instanceId],
    );
    const fresh = new Map(result.rows.filter(row => Date.now() - row.observed_at.getTime() <= 90_000).map(row => [row.signal, row.healthy]));
    const values = ["agent", "tunnel", "gateway"].map(signal => fresh.get(signal));
    const status: InstanceStatus = values.every(value => value === true) ? "online"
      : values.every(value => value === undefined) ? "offline" : "degraded";
    await this.db.query(
      `UPDATE instances SET status=$2,updated_at=now()
       WHERE id=$1 AND status NOT IN ('suspending','suspended','deleting','delete_failed','deleted')`,
      [instanceId, status],
    );
    return status;
  }

  async saveCloudflareResource(instanceId: string, resourceType: "tunnel" | "hostname_route", externalId: string, secret?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO cloudflare_resources(instance_id,resource_type,external_id,encrypted_secret)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(instance_id,resource_type) DO UPDATE SET external_id=excluded.external_id,
         encrypted_secret=excluded.encrypted_secret,disabled_at=NULL,deleted_at=NULL`,
      [instanceId, resourceType, externalId, secret ? encryptSecret(secret, this.config.encryptionKey) : null],
    );
  }

  private slugFromHost(host: string): string | null {
    const hostname = host.toLowerCase().replace(/:\d+$/, "");
    const suffix = `.${this.config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`;
    if (!hostname.endsWith(suffix)) return null;
    const slug = hostname.slice(0, -suffix.length);
    return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
  }

  private audit(client: PoolClient, actorId: string | null, action: string, instanceId: string | null, result: string): Promise<unknown> {
    const requestId = randomUUID();
    return client.query(
      `INSERT INTO audit_logs(actor_id,action,instance_id,result,request_id,network_hmac)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [actorId, action, instanceId, result, requestId, networkSignalHmac(requestId, this.config.auditHmacKey)],
    );
  }
}
