// CoreApi over HTTP. Used by the stdio server so that several local MCP clients share one core.
// Today it talks to the dev hub's /core/rpc stand-in; when WP-E1 ships, only the URL changes
// (or this file is swapped for a client of Entity 1's REST API with the same CoreApi shape).

import type { CoreApi, CoreSession } from "./api.js";
import { CoreError, type CoreErrorCode } from "./types.js";

export const SESSION_METHODS = [
  "whoami",
  "proposeProfile",
  "listEntities",
  "getEntity",
  "sendMessage",
  "checkInbox",
  "createTask",
  "updateTask",
  "getTask",
  "listGroups",
  "getConversationHistory",
] as const satisfies readonly (keyof CoreSession)[];
export type SessionMethod = (typeof SESSION_METHODS)[number];

export class RemoteCore implements CoreApi {
  constructor(private readonly rpcUrl: string) {}

  async authenticate(apiKey: string): Promise<CoreSession | null> {
    try {
      const me = (await call(this.rpcUrl, apiKey, "whoami", [])) as { id: string };
      return makeSession(this.rpcUrl, apiKey, me.id);
    } catch (e) {
      if (e instanceof CoreError && e.code === "unauthenticated") return null;
      throw e;
    }
  }
}

function makeSession(url: string, apiKey: string, entityId: string): CoreSession {
  const s: Record<string, unknown> = { entityId };
  for (const m of SESSION_METHODS) s[m] = (...args: unknown[]) => call(url, apiKey, m, args);
  return s as unknown as CoreSession;
}

async function call(url: string, apiKey: string, method: SessionMethod, args: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ method, args }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { code: CoreErrorCode; message: string } };
  if (body.error) throw new CoreError(body.error.code, body.error.message);
  if (!res.ok) throw new Error(`core rpc failed with HTTP ${res.status}`);
  return body.result;
}
