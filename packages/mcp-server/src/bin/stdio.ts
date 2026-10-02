// stdio transport for local MCP clients (Claude Code, Cursor, Claude Desktop).
// stdout is the MCP channel: nothing else may be written to it. Diagnostics go to stderr.
//
// Env:
//   SIGNALDESK_API_KEY   this entity's key (required; one key per entity, never shared)
//   SIGNALDESK_CORE_URL  core API endpoint (default: dev hub http://127.0.0.1:8787/core/rpc)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RemoteCore } from "../core/remote.js";
import { createSignalDeskServer } from "../server.js";
import { LIMITS } from "../security/limits.js";
import { RateLimiter } from "../security/rate-limit.js";

const key = process.env.SIGNALDESK_API_KEY;
const coreUrl = process.env.SIGNALDESK_CORE_URL ?? "http://127.0.0.1:8787/core/rpc";

if (!key) {
  process.stderr.write("signaldesk: SIGNALDESK_API_KEY is not set\n");
  process.exit(1);
}

const session = await new RemoteCore(coreUrl).authenticate(key).catch((e) => {
  process.stderr.write(`signaldesk: cannot reach core at ${coreUrl}: ${(e as Error).message}\n`);
  process.exit(1);
});
if (!session) {
  process.stderr.write("signaldesk: API key rejected by core\n");
  process.exit(1);
}

const server = createSignalDeskServer(session, {
  hubUrl: coreUrl.replace(/\/core\/rpc$/, "/mcp"),
  rateLimiter: new RateLimiter(LIMITS.rateLimitPerMinute),
});
await server.connect(new StdioServerTransport());
process.stderr.write(`signaldesk: stdio MCP server ready for entity ${session.entityId}\n`);
