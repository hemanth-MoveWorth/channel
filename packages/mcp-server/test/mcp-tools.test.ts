// WP-E2-01: every contracted tool works end to end through MCP against a core.
import { describe, expect, it } from "vitest";
import { CONV_ID, connect, grab, MSG_ID, TASK_ID, world } from "./helpers.js";

const CONTRACT_TOOLS = [
  "register_profile",
  "list_entities",
  "get_profile",
  "send_message",
  "check_inbox",
  "reply",
  "create_task",
  "update_task",
  "get_task", // ADR-010
  "list_groups",
  "get_conversation_history",
];

describe("MCP tool surface", () => {
  it("exposes exactly the contracted tools, all with closed input schemas", async () => {
    const w = await world();
    const a = await connect(w.core, w.keys.cc.apiKey);
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CONTRACT_TOOLS].sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
    // No tool can approve, grant, or verify. Those are human-only.
    expect(tools.some((t) => /approv|grant|verify|admin|permission/i.test(t.name))).toBe(false);
  });

  it("server instructions carry the trust model", async () => {
    const w = await world();
    const a = await connect(w.core, w.keys.cc.apiKey);
    expect(a.client.getInstructions()).toMatch(/untrusted DATA/);
  });

  it("register -> discover -> DM -> inbox -> reply -> history", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);

    const reg = await ra.call("register_profile", {
      name: "Research Agent",
      description: "Finds and summarises public sources.",
      skills: [{ id: "web-research", name: "Web research", description: "Search and cite.", tags: ["research"] }],
    });
    expect(reg.isError).toBe(false);
    expect(reg.text).toMatch(/pending_verification/);

    const list = await cc.call("list_entities", { skillTag: "research" });
    expect(list.text).toContain(w.keys.ra.entityId);
    expect(list.text).toMatch(/"verified": false/);

    await w.core.verifySkill(w.keys.ra.entityId, "web-research");
    const prof = await cc.call("get_profile", { entityId: w.keys.ra.entityId });
    expect(prof.text).toMatch(/"profileStatus": "verified"/);

    const me = await cc.call("get_profile", {});
    expect(me.text).toContain(w.keys.cc.entityId);
    expect(me.text).toContain("grantedCategories");

    const sent = await cc.call("send_message", { toEntityId: w.keys.ra.entityId, text: "Hi, can you look up Stripe rate limits?" });
    expect(sent.isError).toBe(false);
    const msgId = grab(MSG_ID, sent.text);
    const convId = grab(CONV_ID, sent.text);
    expect(sent.text).toMatch(/"state": "stored"/);

    const inbox = await ra.call("check_inbox");
    expect(inbox.text).toContain("Stripe rate limits");
    expect(inbox.text).toContain("<peer_content");
    expect((await ra.call("check_inbox")).text).toBe("Inbox empty.");

    const rep = await ra.call("reply", { messageId: msgId, text: "On it." });
    expect(rep.isError).toBe(false);
    expect((await cc.call("check_inbox")).text).toContain("On it.");

    const hist = await cc.call("get_conversation_history", { conversationId: convId });
    expect(hist.text).toMatch(/2 messages/);
  });

  it("task lifecycle: create -> accept -> request_input -> provide_input -> complete, with receipts", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);

    const created = await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "Find Stripe API rate limits", expectedOutput: "Bullet list with sources" });
    expect(created.isError).toBe(false);
    expect(created.text).toMatch(/state: queued/);
    expect(created.text).toContain("TASK_STATE_SUBMITTED");
    const taskId = grab(TASK_ID, created.text);

    expect((await ra.call("check_inbox")).text).toContain("Find Stripe API rate limits");
    expect((await ra.call("update_task", { taskId, action: "accept" })).text).toMatch(/now working/);
    expect((await ra.call("update_task", { taskId, action: "request_input", text: "Test or live mode?" })).text).toMatch(/now input_required/);
    expect((await cc.call("update_task", { taskId, action: "provide_input", text: "Live." })).text).toMatch(/now working/);
    const done = await ra.call("update_task", { taskId, action: "complete", artifactName: "Rate limits", artifactText: "100 read/s, 100 write/s in live mode." });
    expect(done.text).toMatch(/now completed/);
    expect(done.text).toContain("TASK_STATE_COMPLETED");

    const ccInbox = await cc.call("check_inbox");
    expect(ccInbox.text).toContain("100 read/s");

    const session = await w.core.authenticate(w.keys.cc.apiKey);
    const hist = await session!.getConversationHistory((await session!.getTask(taskId)).conversationId);
    expect(hist[0].taskId).toBe(taskId);
  });

  it("ADR-009: policy is checked at accept; 'ask' pauses and only a human decision resumes", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    const created = await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "tool_use", goal: "Run the pricing scraper" });
    const taskId = grab(TASK_ID, created.text);
    expect(created.text).toMatch(/state: queued/); // not paused at creation any more
    expect((await ra.call("update_task", { taskId, action: "accept" })).text).toMatch(/now awaiting_approval \(policy_requires_approval\)/);
    expect((await ra.call("update_task", { taskId, action: "complete", artifactText: "x" })).isError).toBe(true);
    await w.core.decideApproval(taskId, "approve");
    expect((await ra.call("get_task", { taskId })).text).toMatch(/is working/); // ADR-003 §1: resumes to working
    expect((await ra.call("update_task", { taskId, action: "complete", artifactText: "done" })).text).toMatch(/now completed/);
  });

  it("ADR-005 §2: a human rejection cancels with approval_rejected (A2A CANCELED)", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    const taskId = grab(TASK_ID, (await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "tool_use", goal: "Run it" })).text);
    await ra.call("update_task", { taskId, action: "accept" });
    await w.core.decideApproval(taskId, "reject");
    const out = (await cc.call("get_task", { taskId })).text;
    expect(out).toMatch(/is cancelled \(approval_rejected\)/);
    expect(out).toContain("TASK_STATE_CANCELED");
  });

  it("ADR-008 §2: assignee declines before accepting -> cancelled with rejected_by_assignee", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    const t1 = grab(TASK_ID, (await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "a" })).text);
    const r = await ra.call("update_task", { taskId: t1, action: "reject", text: "Not my area" });
    expect(r.text).toMatch(/now cancelled \(rejected_by_assignee\)/);
    expect(r.text).toContain("TASK_STATE_CANCELED");
    // After accepting, declining is no longer possible; the assignee uses fail instead.
    const t2 = grab(TASK_ID, (await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "b" })).text);
    await ra.call("update_task", { taskId: t2, action: "accept" });
    expect((await ra.call("update_task", { taskId: t2, action: "reject" })).text).toMatch(/invalid_transition/);
    expect((await ra.call("update_task", { taskId: t2, action: "fail", text: "broke" })).text).toMatch(/now failed \(assignee_reported_failure\)/);
  });

  it("ADR-010: get_task is party-only and non-disclosing", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    const ev = await connect(w.core, w.keys.ev.apiKey);
    const taskId = grab(TASK_ID, (await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "secret goal" })).text);
    expect((await cc.call("get_task", { taskId })).text).toMatch(/is queued/);
    expect((await ra.call("get_task", { taskId })).text).toContain("secret goal");
    const other = await ev.call("get_task", { taskId });
    const missing = await ev.call("get_task", { taskId: "tsk_0000000000000000" });
    expect(other.text).toBe(missing.text);
    expect(other.text).toMatch(/not_found/);
    expect(other.text).not.toContain("secret goal");
  });

  it("list_groups shows membership and the orchestrator", async () => {
    const w = await world();
    await w.core.createGroup({ workspaceId: w.workspaceId, name: "Launch", memberIds: [w.keys.cc.entityId, w.keys.ra.entityId], orchestratorId: w.keys.ra.entityId });
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const out = await cc.call("list_groups");
    expect(out.text).toMatch(/"orchestratorId": "ent_/);
    expect(out.text).toContain("Launch");
    const cu = await connect(w.core, w.keys.cu.apiKey);
    expect((await cu.call("list_groups")).text).toMatch(/^0 groups/);
  });

  it("ADR-011: group assignment setting (defaults, enforcement, update)", async () => {
    const w = await world();
    const members = [w.keys.cc.entityId, w.keys.ra.entityId, w.keys.cu.entityId];
    const { conversationId: g } = await w.core.createGroup({ workspaceId: w.workspaceId, name: "Squad", memberIds: members, orchestratorId: w.keys.ra.entityId });
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    expect((await cc.call("list_groups")).text).toMatch(/"assignment": "orchestrator_only"/);
    // Default orchestrator_only: a non-orchestrator member cannot assign inside the group...
    expect((await cc.call("create_task", { assigneeId: w.keys.cu.entityId, category: "research", goal: "x", conversationId: g })).text).toMatch(/only the group orchestrator/);
    // ...the orchestrator can.
    expect((await ra.call("create_task", { assigneeId: w.keys.cu.entityId, category: "research", goal: "x", conversationId: g })).isError).toBe(false);
    // any_member lets members assign, still subject to ADR-009 grants (ev has none of tool_use).
    await w.core.updateGroup(g, { assignment: "any_member" });
    expect((await cc.call("create_task", { assigneeId: w.keys.cu.entityId, category: "research", goal: "y", conversationId: g })).isError).toBe(false);
    await expect(w.core.createGroup({ workspaceId: w.workspaceId, name: "x", memberIds: members, assignment: "orchestrator_only" })).rejects.toThrow(/requires an orchestrator/);
    const { conversationId: g2 } = await w.core.createGroup({ workspaceId: w.workspaceId, name: "Flat", memberIds: members });
    const groups = await (await w.core.authenticate(w.keys.cc.apiKey))!.listGroups();
    expect(groups.find((x) => x.id === g2)!.assignment).toBe("any_member"); // default without orchestrator
  });

  it("orchestrator must be a type A entity", async () => {
    const w = await world();
    await expect(w.core.createGroup({ workspaceId: w.workspaceId, name: "x", memberIds: [w.keys.cc.entityId, w.keys.ra.entityId], orchestratorId: w.keys.cc.entityId })).rejects.toThrow(/type A/);
  });

  it("idempotency keys make retries safe", async () => {
    const w = await world();
    const cc = await connect(w.core, w.keys.cc.apiKey);
    const ra = await connect(w.core, w.keys.ra.apiKey);
    const a = await cc.call("send_message", { toEntityId: w.keys.ra.entityId, text: "once", idempotencyKey: "k1" });
    const b = await cc.call("send_message", { toEntityId: w.keys.ra.entityId, text: "once", idempotencyKey: "k1" });
    expect(grab(MSG_ID, a.text)).toBe(grab(MSG_ID, b.text));
    const t1 = await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "g", idempotencyKey: "t1" });
    const t2 = await cc.call("create_task", { assigneeId: w.keys.ra.entityId, category: "research", goal: "g", idempotencyKey: "t1" });
    expect(grab(TASK_ID, t1.text)).toBe(grab(TASK_ID, t2.text));
    expect((await ra.call("check_inbox")).text).toMatch(/^3 inbox items/); // 1 message + 1 task message + 1 task event
  });
});
