// Streamable HTTP transport (remote MCP clients) + dev-only core RPC and admin endpoints.
//
// Security properties (SECURITY.md §3):
// - Every MCP request carries `Authorization: Bearer <entity key>`; there is no anonymous access.
// - An MCP session is bound to the entity that created it. Presenting a session id with a different
//   (or missing) key is rejected, so a leaked session id alone is useless.
// - Host and Origin headers are allow-listed (DNS-rebinding protection). Binds to 127.0.0.1 by default.
// - Request bodies are size-capped. Errors never echo secrets.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AdminApi, CoreApi } from "./core/api.js";
import { SESSION_METHODS, type SessionMethod } from "./core/remote.js";
import { CoreError } from "./core/types.js";
import { createSignalDeskServer } from "./server.js";
import { digestsEqual, hashApiKey, parseBearer, redactSecrets } from "./security/keys.js";
import { LIMITS } from "./security/limits.js";
import { RateLimiter } from "./security/rate-limit.js";

export interface HubOptions {
  core: CoreApi;
  /** Dev only. When set, /admin/call is enabled and guarded by this token. */
  admin?: { api: AdminApi; token: string };
  /** Dev only. Exposes /core/rpc so local stdio servers can share this core. */
  exposeCoreRpc?: boolean;
  host?: string;
  port: number;
  /** Extra Host header values allowed (e.g. a tunnel hostname). */
  extraAllowedHosts?: string[];
  maxBodyBytes?: number;
  log?: (l: string) => void;
}

const ADMIN_METHODS = [
  "createWorkspace",
  "createEntity",
  "revokeKey",
  "verifySkill",
  "grantCategories",
  "setApprovalMode",
  "createGroup",
  "decideApproval",
  "stopTask",
  "auditLog",
] as const satisfies readonly (keyof AdminApi)[];

interface Bound {
  transport: StreamableHTTPServerTransport;
  entityId: string;
}

export function createHub(opts: HubOptions): { server: Server; url: string; close: () => Promise<void> } {
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`, ...(opts.extraAllowedHosts ?? [])]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`).concat((opts.extraAllowedHosts ?? []).map((h) => `https://${h}`)));
  const hubUrl = `http://${host}:${opts.port}/mcp`;
  const rateLimiter = new RateLimiter(LIMITS.rateLimitPerMinute);
  const sessions = new Map<string, Bound>();
  const adminDigest = opts.admin ? hashApiKey(opts.admin.token) : undefined;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const rpcError = (res: ServerResponse, status: number, code: string, message: string, id: unknown = null) =>
    send(res, status, { jsonrpc: "2.0", error: { code: -32000, message: `${code}: ${message}` }, id });

  async function readBody(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBody) throw new CoreError("limit_exceeded", "request body too large");
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new CoreError("invalid_input", "body is not valid JSON");
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const key = parseBearer(req.headers.authorization);
    const session = key ? await opts.core.authenticate(key) : null;
    if (!session) {
      res.setHeader("www-authenticate", 'Bearer realm="signaldesk"');
      return rpcError(res, 401, "unauthenticated", "missing or invalid API key");
    }
    const sid = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readBody(req) : undefined;

    if (typeof sid === "string") {
      const bound = sessions.get(sid);
      if (!bound) return rpcError(res, 404, "not_found", "unknown session");
      if (bound.entityId !== session.entityId) {
        log(`[signaldesk] session ${sid} presented by a different entity; rejected`);
        return rpcError(res, 403, "forbidden", "session belongs to a different entity");
      }
      return bound.transport.handleRequest(req, res, body);
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "invalid_input", "no session: send an initialize request first");

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, entityId: session.entityId });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const mcp = createSignalDeskServer(session, { hubUrl, rateLimiter, log });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleCoreRpc(req: IncomingMessage, res: ServerResponse) {
    const key = parseBearer(req.headers.authorization);
    const session = key ? await opts.core.authenticate(key) : null;
    if (!session) return send(res, 401, { error: { code: "unauthenticated", message: "missing or invalid API key" } });
    if (!rateLimiter.take(session.entityId)) return send(res, 429, { error: { code: "limit_exceeded", message: "rate limit reached" } });
    const body = (await readBody(req)) as { method?: string; args?: unknown[] } | undefined;
    if (!body || !SESSION_METHODS.includes(body.method as SessionMethod) || !Array.isArray(body.args)) {
      return send(res, 400, { error: { code: "invalid_input", message: "unknown method" } });
    }
    const fn = session[body.method as SessionMethod] as (...a: unknown[]) => Promise<unknown>;
    const result = await fn.apply(session, body.args);
    send(res, 200, { result });
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse) {
    const token = parseBearer(req.headers.authorization);
    if (!opts.admin || !token || !digestsEqual(hashApiKey(token), adminDigest!)) return send(res, 401, { error: { code: "unauthenticated", message: "admin token required" } });
    const body = (await readBody(req)) as { method?: string; args?: unknown[] } | undefined;
    if (!body || !ADMIN_METHODS.includes(body.method as (typeof ADMIN_METHODS)[number]) || !Array.isArray(body.args)) {
      return send(res, 400, { error: { code: "invalid_input", message: "unknown admin method" } });
    }
    const api = opts.admin.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    send(res, 200, { result: await api[body.method!].apply(opts.admin.api, body.args) });
  }

  const server = createServer(async (req, res) => {
    try {
      const h = req.headers.host ?? "";
      if (!allowedHosts.has(h)) return send(res, 403, { error: { code: "forbidden", message: "host not allowed" } });
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: { code: "forbidden", message: "origin not allowed" } });
      const path = new URL(req.url ?? "/", "http://x").pathname;

      if (path === "/mcp") return await handleMcp(req, res);
      if (path === "/core/rpc" && opts.exposeCoreRpc && req.method === "POST") return await handleCoreRpc(req, res);
      if (path === "/admin/call" && opts.admin && req.method === "POST") return await handleAdmin(req, res);
      if (path === "/healthz") return send(res, 200, { ok: true });
      send(res, 404, { error: { code: "not_found", message: "not found" } });
    } catch (e) {
      if (e instanceof CoreError) {
        const status = e.code === "limit_exceeded" ? 413 : e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : 400;
        return send(res, status, { error: { code: e.code, message: redactSecrets(e.message) } });
      }
      log(`[signaldesk] http error: ${redactSecrets(String((e as Error)?.stack ?? e))}`);
      send(res, 500, { error: { code: "internal_error", message: "internal error" } });
    }
  });

  return {
    server,
    url: `http://${host}:${opts.port}`,
    close: async () => {
      for (const b of sessions.values()) await b.transport.close().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
