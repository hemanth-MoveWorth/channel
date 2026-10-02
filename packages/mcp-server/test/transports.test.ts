// WP-E2-01 transports + WP-E2-03 transport security.
// - streamable HTTP: auth, session binding, DNS-rebinding guards, body caps, admin isolation
// - stdio: spawns the real stdio entrypoint as a child process (what Claude Code / Cursor do)

import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHub } from "../src/http.js";
import { world } from "./helpers.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const rawPost = (port: number, path: string, headers: Record<string, string>, body: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });

let w: Awaited<ReturnType<typeof world>>;
let hub: ReturnType<typeof createHub>;
let port: number;
const ADMIN = "adm_test_token_value_123456";

async function httpClient(key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  const client = new Client({ name: "http-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

beforeAll(async () => {
  w = await world();
  port = await freePort();
  hub = createHub({ core: w.core, admin: { api: w.core, token: ADMIN }, exposeCoreRpc: true, port, log: () => {} });
  await new Promise<void>((r) => hub.server.listen(port, "127.0.0.1", () => r()));
});
afterAll(async () => {
  await hub.close();
});

describe("streamable HTTP transport", () => {
  it("serves the tools to an authenticated client", async () => {
    const { client, transport } = await httpClient(w.keys.cc.apiKey);
    expect((await client.listTools()).tools.length).toBe(11);
    const r = await client.callTool({ name: "list_entities", arguments: {} });
    expect(textOf(r)).toContain(w.keys.ra.entityId);
    await transport.close();
  });

  it("ADV-26 rejects missing or invalid keys with 401", async () => {
    expect((await rawPost(port, "/mcp", {}, INIT)).status).toBe(401);
    expect((await rawPost(port, "/mcp", { authorization: "Bearer sdk_nope" }, INIT)).status).toBe(401);
  });

  it("ADV-27 a session id is bound to its entity: another key, or no key, cannot ride it", async () => {
    const { client, transport } = await httpClient(w.keys.cc.apiKey);
    await client.listTools();
    const sid = transport.sessionId!;
    expect(sid).toBeTruthy();
    const call = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "check_inbox", arguments: {} } });
    const hijack = await rawPost(port, "/mcp", { authorization: `Bearer ${w.keys.ev.apiKey}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, call);
    expect(hijack.status).toBe(403);
    const anon = await rawPost(port, "/mcp", { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, call);
    expect(anon.status).toBe(401);
    await transport.close();
  });

  it("ADV-28 DNS-rebinding guards: foreign Host or Origin is refused", async () => {
    expect((await rawPost(port, "/mcp", { host: "evil.example", authorization: `Bearer ${w.keys.cc.apiKey}` }, INIT)).status).toBe(403);
    expect((await rawPost(port, "/mcp", { origin: "https://evil.example", authorization: `Bearer ${w.keys.cc.apiKey}` }, INIT)).status).toBe(403);
  });

  it("ADV-29 request bodies are size-capped", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(1_100_000) } });
    expect((await rawPost(port, "/mcp", { authorization: `Bearer ${w.keys.cc.apiKey}` }, big)).status).toBe(413);
  });

  it("ADV-30 entity keys cannot reach admin operations; admin needs its own token", async () => {
    const body = JSON.stringify({ method: "decideApproval", args: ["tsk_x", "approve"] });
    expect((await rawPost(port, "/admin/call", { authorization: `Bearer ${w.keys.cc.apiKey}` }, body)).status).toBe(401);
    expect((await rawPost(port, "/admin/call", {}, body)).status).toBe(401);
    const ok = await rawPost(port, "/admin/call", { authorization: `Bearer ${ADMIN}` }, JSON.stringify({ method: "auditLog", args: [] }));
    expect(ok.status).toBe(200);
  });

  it("ADV-31 core RPC only exposes session methods, bound to the caller's key", async () => {
    const bad = await rawPost(port, "/core/rpc", { authorization: `Bearer ${w.keys.ev.apiKey}` }, JSON.stringify({ method: "decideApproval", args: [] }));
    expect(bad.status).toBe(400);
    const proto = await rawPost(port, "/core/rpc", { authorization: `Bearer ${w.keys.ev.apiKey}` }, JSON.stringify({ method: "constructor", args: [] }));
    expect(proto.status).toBe(400);
    expect((await rawPost(port, "/core/rpc", {}, JSON.stringify({ method: "whoami", args: [] }))).status).toBe(401);
  });
});

describe("stdio transport (real child process, as Claude Code / Cursor launch it)", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const spawnClient = async (key: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/bin/stdio.ts"],
      cwd,
      env: { ...(process.env as Record<string, string>), SIGNALDESK_API_KEY: key, SIGNALDESK_CORE_URL: `http://127.0.0.1:${port}/core/rpc` },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    return { client, transport };
  };

  it("connects, registers a profile, sends a message, and checks its inbox against a running core", async () => {
    const { client, transport } = await spawnClient(w.keys.cu.apiKey);
    const reg = await client.callTool({ name: "register_profile", arguments: { name: "Cursor", description: "Code editor agent", skills: [{ id: "edit-code", name: "Edit code", description: "Edits repo files", tags: ["code"] }] } });
    expect(reg.isError).toBeFalsy();
    expect(textOf(reg)).toMatch(/Profile saved/);

    const sent = await client.callTool({ name: "send_message", arguments: { toEntityId: w.keys.ra.entityId, text: "hello from stdio" } });
    expect(textOf(sent)).toMatch(/Message msg_/);

    // The other side (over HTTP) sees it and replies; the stdio client then sees the reply.
    const { client: ra, transport: rt } = await httpClient(w.keys.ra.apiKey);
    const inbox = textOf(await ra.callTool({ name: "check_inbox", arguments: {} }));
    expect(inbox).toContain("hello from stdio");
    const msgId = /"id": "(msg_[a-f0-9]+)"/.exec(inbox)![1];
    await ra.callTool({ name: "reply", arguments: { messageId: msgId, text: "hello back" } });
    expect(textOf(await client.callTool({ name: "check_inbox", arguments: {} }))).toContain("hello back");

    await rt.close();
    await transport.close();
  }, 30_000);

  it("refuses to start with a bad key", async () => {
    await expect(spawnClient("sdk_" + "B".repeat(43))).rejects.toThrow();
  }, 30_000);
});
