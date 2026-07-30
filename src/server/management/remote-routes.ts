import {
  activateRemoteInstance,
  cancelRemoteLink,
  createRemotePairingCode,
  disconnectRemoteDevice,
  getRemoteStatus,
  setRemotePassword,
  startRemoteLink,
} from "../../remote/client";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "remote request failed";
}

export async function handleRemoteRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/remote/status" && req.method === "GET") {
    return jsonResponse(await getRemoteStatus(), 200, req, config);
  }
  if (url.pathname === "/api/remote/link" && req.method === "POST") {
    try {
      return jsonResponse(await startRemoteLink(), 201, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/link/cancel" && req.method === "POST") {
    return jsonResponse(await cancelRemoteLink(), 200, req, config);
  }
  if (url.pathname === "/api/remote/password" && req.method === "PUT") {
    try {
      const body = await req.json() as { password?: unknown };
      if (typeof body.password !== "string") throw new Error("remote password is required");
      return jsonResponse(await setRemotePassword(body.password), 200, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/activate" && req.method === "POST") {
    try {
      const body = await req.json() as { name?: unknown; slug?: unknown };
      if (typeof body.name !== "string" || typeof body.slug !== "string") {
        throw new Error("remote name and domain are required");
      }
      return jsonResponse(await activateRemoteInstance(body.name, body.slug), 202, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/pairing-code" && req.method === "POST") {
    try {
      return jsonResponse(await createRemotePairingCode(), 201, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 409, req, config);
    }
  }
  if (url.pathname === "/api/remote/device" && req.method === "DELETE") {
    try {
      return jsonResponse(await disconnectRemoteDevice(), 200, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 502, req, config);
    }
  }
  return null;
}
