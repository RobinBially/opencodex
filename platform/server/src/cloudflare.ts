import type { PlatformConfig } from "./config";

export interface TunnelResource {
  id: string;
  token: string;
}

export interface CloudflareProvider {
  createTunnel(name: string): Promise<TunnelResource>;
  createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string>;
  listActiveConnections(tunnelId: string): Promise<number>;
  rotateTunnelToken(tunnelId: string): Promise<string>;
  disablePrivateHostnameRoute(routeId: string): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export class CloudflareApi implements CloudflareProvider {
  constructor(private readonly config: PlatformConfig) {
    if (!config.cloudflareApiToken || !config.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error("Cloudflare API token and account id are required");
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.CLOUDFLARE_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.cloudflareApiToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.json() as CloudflareEnvelope<T>;
    if (!response.ok || !body.success) {
      throw new Error(`Cloudflare API ${response.status}: ${body.errors?.map(error => error.message).join(", ") || "request failed"}`);
    }
    return body.result;
  }

  createTunnel(name: string): Promise<TunnelResource> {
    return this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name, config_src: "cloudflare" }),
    });
  }

  async createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string> {
    const route = await this.request<{ id: string }>(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/zerotrust/routes/hostname`,
      { method: "POST", body: JSON.stringify({ hostname, tunnel_id: tunnelId, comment: "OpenCodex Remote private instance" }) },
    );
    return route.id;
  }

  async listActiveConnections(tunnelId: string): Promise<number> {
    const clients = await this.request<Array<{ conns?: Array<{ is_pending_reconnect?: boolean }> }>>(
      `/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`,
    );
    return clients.flatMap(client => client.conns ?? []).filter(connection => !connection.is_pending_reconnect).length;
  }

  rotateTunnelToken(tunnelId: string): Promise<string> {
    return this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`, { method: "POST" });
  }

  async disablePrivateHostnameRoute(routeId: string): Promise<void> {
    await this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/zerotrust/routes/hostname/${routeId}`, { method: "DELETE" });
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request(`/accounts/${this.config.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
  }
}

/** Deterministic provider for unit tests and local UI development only. */
export class FakeCloudflareProvider implements CloudflareProvider {
  readonly tunnels = new Map<string, { token: string; connections: number }>();
  readonly routes = new Map<string, { tunnelId: string; hostname: string }>();

  async createTunnel(): Promise<TunnelResource> {
    const id = crypto.randomUUID();
    const token = `fake.${crypto.randomUUID()}`;
    this.tunnels.set(id, { token, connections: 0 });
    return { id, token };
  }
  async createPrivateHostnameRoute(tunnelId: string, hostname: string): Promise<string> {
    const id = crypto.randomUUID();
    this.routes.set(id, { tunnelId, hostname });
    return id;
  }
  async listActiveConnections(tunnelId: string): Promise<number> {
    return this.tunnels.get(tunnelId)?.connections ?? 0;
  }
  async rotateTunnelToken(tunnelId: string): Promise<string> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) throw new Error("tunnel not found");
    tunnel.token = `fake.${crypto.randomUUID()}`;
    return tunnel.token;
  }
  async disablePrivateHostnameRoute(routeId: string): Promise<void> { this.routes.delete(routeId); }
  async deleteTunnel(tunnelId: string): Promise<void> { this.tunnels.delete(tunnelId); }
}
