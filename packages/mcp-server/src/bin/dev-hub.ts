// Local dev hub: reference core + streamable HTTP MCP + dev core RPC + dev admin endpoint.
// NOT for deployment. Binds to 127.0.0.1. Writes generated keys to .signaldesk-dev/ (git-ignored).
//
//   npm run hub
//
// Env: SIGNALDESK_PORT (default 8787), SIGNALDESK_EXTRA_HOSTS (comma list, e.g. a tunnel host).

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReferenceCore } from "../core/reference-core.js";
import { createHub } from "../http.js";

const port = Number(process.env.SIGNALDESK_PORT ?? 8787);
const core = new ReferenceCore();
const adminToken = "adm_" + randomBytes(24).toString("base64url");

const { workspaceId } = await core.createWorkspace("Local dev");
const mk = async (name: string, connectionType: "A" | "B" | "C") => ({ name, ...(await core.createEntity({ workspaceId, name, connectionType })) });
const claudeCode = await mk("Claude Code", "B");
const cursor = await mk("Cursor", "B");
const research = await mk("Research Agent", "A");

// Sensible dev defaults; change them through /admin/call.
await core.grantCategories(claudeCode.entityId, ["research", "read_context", "tool_use"]);
await core.grantCategories(cursor.entityId, ["research", "read_context", "tool_use"]);
await core.grantCategories(research.entityId, ["research"]);
await core.setApprovalMode(research.entityId, { kind: "standing_rules", rules: { research: "allow", read_context: "ask", tool_use: "ask", write: "deny", send_external: "deny", publish: "deny" } });
const { conversationId } = await core.createGroup({ workspaceId, name: "Launch squad", memberIds: [claudeCode.entityId, cursor.entityId, research.entityId], orchestratorId: research.entityId });

const hub = createHub({ core, admin: { api: core, token: adminToken }, exposeCoreRpc: true, port, extraAllowedHosts: process.env.SIGNALDESK_EXTRA_HOSTS?.split(",").filter(Boolean) });
hub.server.listen(port, "127.0.0.1", () => {
  const dir = join(process.cwd(), ".signaldesk-dev");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "keys.json");
  writeFileSync(
    file,
    JSON.stringify({ hub: hub.url, mcp: `${hub.url}/mcp`, coreRpc: `${hub.url}/core/rpc`, adminToken, workspaceId, groupId: conversationId, entities: [claudeCode, cursor, research] }, null, 2),
    { mode: 0o600 },
  );
  process.stderr.write(`SignalDesk dev hub on ${hub.url} (reference core, in-memory). Keys written to ${file}\n`);
});
