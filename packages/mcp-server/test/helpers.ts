import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReferenceCore } from "../src/core/reference-core.js";
import { createSignalDeskServer } from "../src/server.js";
import { RateLimiter } from "../src/security/rate-limit.js";

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface Agent {
  id: string;
  key: string;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
}

/** Connect an MCP client to a fresh server instance bound to `key`, over an in-memory transport. */
export async function connect(core: ReferenceCore, key: string, rateLimiter = new RateLimiter(100_000)): Promise<Agent> {
  const session = await core.authenticate(key);
  if (!session) throw new Error("auth failed in test setup");
  const server = createSignalDeskServer(session, { hubUrl: "http://127.0.0.1:8787/mcp", rateLimiter, log: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(ct);
  return {
    id: session.entityId,
    key,
    client,
    call: async (name, args = {}) => {
      try {
        const r = await client.callTool({ name, arguments: args });
        const content = r.content as { type: string; text: string }[];
        return { isError: !!r.isError, text: content.map((c) => c.text).join("\n") };
      } catch (e) {
        return { isError: true, text: String((e as Error).message) };
      }
    },
  };
}

/**
 * A workspace with three entities and one outsider in another workspace.
 *  - cc  "Claude Code"    type B, may request research/read_context/tool_use
 *  - ra  "Research Agent" type A, accepts research automatically, asks for read_context/tool_use, denies publish
 *  - cu  "Cursor"         type B, ask-every-time
 *  - ev  "Evil Agent"     type B, only research grant (the attacker in adversarial tests)
 *  - ox  "Outsider"       another workspace
 */
export async function world() {
  let t = Date.parse("2026-10-01T09:00:00Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const core = new ReferenceCore({ now: clock.now });
  const { workspaceId } = await core.createWorkspace("Acme");
  const { workspaceId: otherWs } = await core.createWorkspace("Other");
  const cc = await core.createEntity({ workspaceId, name: "Claude Code", connectionType: "B" });
  const ra = await core.createEntity({ workspaceId, name: "Research Agent", connectionType: "A" });
  const cu = await core.createEntity({ workspaceId, name: "Cursor", connectionType: "B" });
  const ev = await core.createEntity({ workspaceId, name: "Evil Agent", connectionType: "B" });
  const ox = await core.createEntity({ workspaceId: otherWs, name: "Outsider", connectionType: "A" });
  await core.grantCategories(cc.entityId, ["research", "read_context", "tool_use"]);
  await core.grantCategories(ra.entityId, ["research"]);
  await core.grantCategories(cu.entityId, ["research"]);
  await core.grantCategories(ev.entityId, ["research"]);
  await core.setApprovalMode(ra.entityId, { kind: "standing_rules", rules: { research: "allow", read_context: "ask", tool_use: "ask", publish: "deny" } });
  await core.setApprovalMode(cu.entityId, { kind: "full_access_workspace" });
  await core.setApprovalMode(cc.entityId, { kind: "full_access_workspace" });
  return { core, clock, workspaceId, otherWs, keys: { cc, ra, cu, ev, ox } };
}

export const grab = (re: RegExp, s: string): string => {
  const m = re.exec(s);
  if (!m) throw new Error(`pattern ${re} not found in:\n${s}`);
  return m[1];
};
export const TASK_ID = /Task (tsk_[a-f0-9]+)/;
export const MSG_ID = /(?:Message|Reply) (msg_[a-f0-9]+)/;
export const CONV_ID = /conversation (conv_[a-f0-9]+)/;
