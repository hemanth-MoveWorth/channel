// In-memory REFERENCE implementation of CoreApi + AdminApi.
//
// This is a test double and executable specification for Entity 1, NOT the production core:
// no persistence, no queue, no webhooks. It exists so that (a) the MCP server can be built and
// tested before WP-E1-0x lands, and (b) the security conformance suite (test/adversarial.test.ts)
// has a known-good target. Entity 1's SQLite-backed core (ADR-002) must pass the same suite.

import { createHash, randomUUID } from "node:crypto";
import type { AdminApi, CoreApi, CoreSession, CreateTaskInput, SendMessageInput, UpdateTaskInput } from "./api.js";
import {
  ACTION_CATEGORIES,
  type ActionCategory,
  type Budget,
  categoryRisk,
  type ConnectionType,
  type ConversationView,
  CoreError,
  type EntityPublicProfile,
  type InboxItem,
  type MessageView,
  type Part,
  type ReceiptState,
  type SelfProfile,
  type SkillView,
  type SourceRef,
  type TaskReason,
  type TaskState,
  type TaskView,
  TERMINAL_STATES,
} from "./types.js";
import { validateAgentCard } from "../a2a/card.js";
import { digestsEqual, generateApiKey, hashApiKey } from "../security/keys.js";
import { LIMITS } from "../security/limits.js";
import { validateDisplayName } from "../security/untrusted.js";

type ApprovalMode =
  | { kind: "ask_every_time" }
  | { kind: "standing_rules"; rules: Partial<Record<ActionCategory, "allow" | "ask" | "deny">> }
  | { kind: "full_access_workspace" };

interface EntityRec {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  connectionType: ConnectionType;
  webhookUrl?: string;
  keyDigest: string;
  card: Record<string, unknown>;
  claimedSkills: Omit<SkillView, "verified">[];
  /** skillId -> digest of the skill definition at verification time. Editing a skill drops verification. */
  verifiedSkills: Map<string, string>;
  granted: Set<ActionCategory>;
  approvalMode: ApprovalMode;
  registered: boolean;
}

interface ConversationRec {
  id: string;
  workspaceId: string;
  kind: "dm" | "group";
  name?: string;
  members: Set<string>;
  orchestratorId?: string;
}

interface MessageRec extends MessageView {
  receipts: Map<string, ReceiptState>;
}

interface TaskRec extends Omit<TaskView, "deadline"> {
  deadlineMs: number;
  turnsWithoutProgress: number;
  /** State to return to when an approval pause is approved. */
  resumeState?: TaskState;
  originMessageId: string;
}

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export interface ReferenceCoreOptions {
  now?: () => number;
}

export class ReferenceCore implements CoreApi, AdminApi {
  private readonly now: () => number;
  private workspaces = new Map<string, { id: string; name: string }>();
  private entities = new Map<string, EntityRec>();
  private keyIndex = new Map<string, string>();
  private conversations = new Map<string, ConversationRec>();
  private dmIndex = new Map<string, string>();
  private messages = new Map<string, MessageRec>();
  private convMessages = new Map<string, string[]>();
  private tasks = new Map<string, TaskRec>();
  private taskEvents = new Map<string, { task: TaskView; event: string; at: string }[]>();
  private idempotency = new Map<string, unknown>();
  private audit: { at: string; actor: string; action: string; target?: string; decision?: string; detail?: string }[] = [];

  constructor(opts: ReferenceCoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- authentication

  async authenticate(apiKey: string): Promise<CoreSession | null> {
    if (typeof apiKey !== "string" || apiKey.length > 256) return null;
    const d = hashApiKey(apiKey);
    const entityId = this.keyIndex.get(d);
    if (!entityId) return null;
    const e = this.entities.get(entityId);
    if (!e || !digestsEqual(e.keyDigest, d)) return null;
    return new ReferenceSession(this, entityId);
  }

  // ---------------------------------------------------------------- admin (human-only)

  async createWorkspace(name: string) {
    const workspaceId = id("ws");
    this.workspaces.set(workspaceId, { id: workspaceId, name });
    return { workspaceId };
  }

  async createEntity(input: { workspaceId: string; name: string; connectionType: ConnectionType; webhookUrl?: string }) {
    if (!this.workspaces.has(input.workspaceId)) throw new CoreError("not_found", "workspace not found");
    const n = validateDisplayName(input.name);
    if (!n.ok) throw new CoreError("invalid_input", n.reason);
    this.assertUniqueName(input.workspaceId, n.name);
    const apiKey = generateApiKey();
    const entityId = id("ent");
    const keyDigest = hashApiKey(apiKey);
    this.entities.set(entityId, {
      id: entityId,
      workspaceId: input.workspaceId,
      name: n.name,
      description: "",
      connectionType: input.connectionType,
      webhookUrl: input.webhookUrl,
      keyDigest,
      card: {},
      claimedSkills: [],
      verifiedSkills: new Map(),
      granted: new Set(["research"]),
      approvalMode: { kind: "ask_every_time" },
      registered: false,
    });
    this.keyIndex.set(keyDigest, entityId);
    this.log("human", "entity.create", entityId);
    return { entityId, apiKey };
  }

  async revokeKey(entityId: string) {
    const e = this.mustEntity(entityId);
    this.keyIndex.delete(e.keyDigest);
    const apiKey = generateApiKey();
    e.keyDigest = hashApiKey(apiKey);
    this.keyIndex.set(e.keyDigest, entityId);
    this.log("human", "entity.rotate_key", entityId);
    return { apiKey };
  }

  async verifySkill(entityId: string, skillId: string) {
    const e = this.mustEntity(entityId);
    const s = e.claimedSkills.find((k) => k.id === skillId);
    if (!s) throw new CoreError("not_found", "skill not claimed by entity");
    e.verifiedSkills.set(skillId, digest(s));
    this.log("human", "skill.verify", entityId, "allow", skillId);
  }

  async grantCategories(entityId: string, categories: ActionCategory[]) {
    const e = this.mustEntity(entityId);
    e.granted = new Set(categories.filter((c) => ACTION_CATEGORIES.includes(c)));
    this.log("human", "grants.set", entityId, undefined, [...e.granted].join(","));
  }

  async setApprovalMode(entityId: string, mode: ApprovalMode) {
    this.mustEntity(entityId).approvalMode = mode;
    this.log("human", "approval_mode.set", entityId, undefined, mode.kind);
  }

  async createGroup(input: { workspaceId: string; name: string; memberIds: string[]; orchestratorId?: string }) {
    const members = new Set(input.memberIds);
    for (const m of members) if (this.mustEntity(m).workspaceId !== input.workspaceId) throw new CoreError("forbidden", "member from another workspace");
    if (input.orchestratorId) {
      if (!members.has(input.orchestratorId)) throw new CoreError("invalid_input", "orchestrator must be a member");
      if (this.mustEntity(input.orchestratorId).connectionType !== "A") throw new CoreError("invalid_input", "only type A entities can orchestrate (ARCHITECTURE §2.3)");
    }
    const conversationId = id("conv");
    this.conversations.set(conversationId, { id: conversationId, workspaceId: input.workspaceId, kind: "group", name: input.name, members, orchestratorId: input.orchestratorId });
    this.log("human", "group.create", conversationId);
    return { conversationId };
  }

  async decideApproval(taskId: string, decision: "approve" | "reject") {
    const t = this.mustTask(taskId);
    this.enforceDeadline(t);
    if (t.state !== "awaiting_approval") throw new CoreError("invalid_transition", `task is ${t.state}, not awaiting_approval`);
    if (decision === "approve") {
      t.hops = 0;
      this.transition(t, t.resumeState ?? "queued", undefined, "human", "approval.approve");
    } else {
      this.transition(t, "failed", "approval_rejected", "human", "approval.reject");
      this.cascadeCancel(t.id, "parent_cancelled");
    }
    return this.view(t);
  }

  async stopTask(taskId: string) {
    const t = this.mustTask(taskId);
    const stopped: TaskView[] = [];
    if (!TERMINAL_STATES.has(t.state)) {
      this.transition(t, "cancelled", "stopped_by_user", "human", "task.stop");
      stopped.push(this.view(t));
    }
    stopped.push(...this.cascadeCancel(t.id, "stopped_by_user"));
    return stopped;
  }

  async auditLog() {
    return [...this.audit];
  }

  // ---------------------------------------------------------------- session operations (called by ReferenceSession)

  whoami(caller: string): SelfProfile {
    const e = this.mustEntity(caller);
    return { ...this.publicProfile(e), workspaceId: e.workspaceId, grantedCategories: [...e.granted] };
  }

  proposeProfile(caller: string, card: Record<string, unknown>): SelfProfile {
    const e = this.mustEntity(caller);
    const v = validateAgentCard(card);
    if (!v.ok) {
      this.log(caller, "profile.propose", caller, "deny", v.errors.join("; "));
      throw new CoreError("invalid_input", "agent card rejected: " + v.errors.join("; "));
    }
    const name = (card.name as string).normalize("NFKC").trim();
    if (name.toLowerCase() !== e.name.toLowerCase()) this.assertUniqueName(e.workspaceId, name, e.id);
    e.name = name;
    e.description = card.description as string;
    e.card = structuredClone(card);
    e.claimedSkills = ((card.skills as SkillView[]) ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags ?? [], examples: s.examples }));
    // A changed skill definition loses its verification.
    for (const [skillId, d] of e.verifiedSkills) {
      const s = e.claimedSkills.find((k) => k.id === skillId);
      if (!s || digest(s) !== d) e.verifiedSkills.delete(skillId);
    }
    e.registered = true;
    this.log(caller, "profile.propose", caller, "allow");
    return this.whoami(caller);
  }

  listEntities(caller: string, filter?: { query?: string; skillTag?: string }): EntityPublicProfile[] {
    const me = this.mustEntity(caller);
    const q = filter?.query?.toLowerCase();
    return [...this.entities.values()]
      .filter((e) => e.workspaceId === me.workspaceId && e.id !== caller)
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
      .filter((e) => !filter?.skillTag || e.claimedSkills.some((s) => s.tags.includes(filter.skillTag!)))
      .map((e) => this.publicProfile(e));
  }

  getEntity(caller: string, entityId: string): EntityPublicProfile {
    return this.publicProfile(this.visibleEntity(caller, entityId));
  }

  sendMessage(caller: string, m: SendMessageInput): { message: MessageView; receipts: { messageId: string; recipientId: string; state: ReceiptState }[] } {
    return this.idempotent(caller, m.idempotencyKey, () => {
      checkParts(m.parts);
      let conv: ConversationRec;
      let task: TaskRec | undefined;
      // A bare reply inherits the parent's conversation and task.
      if (m.inReplyTo && !m.taskId && !m.conversationId && !m.toEntityId) {
        const parent = this.messages.get(m.inReplyTo);
        if (!parent || !this.conversations.get(parent.conversationId)?.members.has(caller)) throw new CoreError("not_found", "message not found");
        const pt = parent.taskId ? this.tasks.get(parent.taskId) : undefined;
        if (pt && !TERMINAL_STATES.has(pt.state) && (pt.requesterId === caller || pt.assigneeId === caller)) m = { ...m, taskId: pt.id };
        else m = { ...m, conversationId: parent.conversationId };
      }
      if (m.taskId) {
        task = this.taskForParty(caller, m.taskId);
        this.enforceDeadline(task);
        if (TERMINAL_STATES.has(task.state)) throw new CoreError("invalid_transition", `task is ${task.state}`);
        if (task.state === "awaiting_approval") throw new CoreError("forbidden", "task is paused awaiting human approval");
        conv = this.conversations.get(task.conversationId)!;
      } else if (m.conversationId) {
        conv = this.memberConversation(caller, m.conversationId);
      } else if (m.toEntityId) {
        const to = this.visibleEntity(caller, m.toEntityId);
        if (to.id === caller) throw new CoreError("invalid_input", "cannot message yourself");
        conv = this.dm(caller, to.id);
      } else {
        throw new CoreError("invalid_input", "one of toEntityId, conversationId, taskId is required");
      }
      if (m.inReplyTo) {
        const parent = this.messages.get(m.inReplyTo);
        if (!parent || parent.conversationId !== conv.id) throw new CoreError("not_found", "inReplyTo message not found in this conversation");
      }

      if (task) {
        task.hops++;
        task.turnsWithoutProgress++;
        if (task.hops > task.budget.maxHops) {
          this.pause(task, "hop_limit_reached", caller);
          throw new CoreError("limit_exceeded", `hop limit (${task.budget.maxHops}) reached; task paused for human review`);
        }
        if (task.turnsWithoutProgress > LIMITS.maxTurnsWithoutProgress) {
          this.pause(task, "no_progress_limit_reached", caller);
          throw new CoreError("limit_exceeded", `${LIMITS.maxTurnsWithoutProgress} messages without progress; task paused for human review`);
        }
      }

      const msg = this.storeMessage(caller, conv, m.parts, task?.id, m.inReplyTo);
      this.log(caller, "message.send", msg.id, "allow");
      return { message: this.msgView(msg), receipts: [...msg.receipts].map(([recipientId, state]) => ({ messageId: msg.id, recipientId, state })) };
    });
  }

  checkInbox(caller: string, limit: number = LIMITS.maxInboxBatch): InboxItem[] {
    const items: (InboxItem & { _at: string })[] = [];
    for (const msg of this.messages.values()) {
      if (msg.receipts.get(caller) === "stored") items.push({ kind: "message", message: this.msgView(msg), receipt: "delivered", _at: msg.createdAt });
    }
    for (const ev of this.taskEvents.get(caller) ?? []) items.push({ kind: "task_update", ...ev, _at: ev.at });
    items.sort((a, b) => a._at.localeCompare(b._at));
    const batch = items.slice(0, Math.min(limit, LIMITS.maxInboxBatch));
    for (const it of batch) {
      if (it.kind === "message") this.messages.get(it.message.id)!.receipts.set(caller, "delivered");
    }
    const deliveredEvents = new Set(batch.filter((b) => b.kind === "task_update"));
    this.taskEvents.set(caller, (this.taskEvents.get(caller) ?? []).filter((ev) => ![...deliveredEvents].some((d) => d.kind === "task_update" && d.task.id === ev.task.id && d.at === ev.at && d.event === ev.event)));
    return batch.map(({ _at, ...rest }) => rest as InboxItem);
  }

  createTask(caller: string, t: CreateTaskInput): TaskView {
    return this.idempotent(caller, t.idempotencyKey, () => {
      const me = this.mustEntity(caller);
      const assignee = this.visibleEntity(caller, t.assigneeId);
      if (assignee.id === caller) throw new CoreError("invalid_input", "cannot assign a task to yourself");
      if (!ACTION_CATEGORIES.includes(t.category)) throw new CoreError("invalid_input", "unknown category");
      if (typeof t.goal !== "string" || !t.goal.trim() || t.goal.length > LIMITS.maxGoalChars) throw new CoreError("invalid_input", "goal is required and bounded");
      if (t.input) checkParts(t.input);

      // Delegation: only the assignee of a live parent may sub-delegate it.
      let depth = 0;
      let parent: TaskRec | undefined;
      if (t.parentTaskId) {
        parent = this.taskForParty(caller, t.parentTaskId);
        this.enforceDeadline(parent);
        if (parent.assigneeId !== caller) throw new CoreError("forbidden", "only the assignee of the parent task may delegate it");
        if (parent.state !== "working") throw new CoreError("invalid_transition", `parent task is ${parent.state}, must be working`);
        depth = parent.depth + 1;
        if (depth > LIMITS.maxDelegationDepth) {
          this.log(caller, "task.create", parent.id, "deny", "delegation depth exceeded");
          throw new CoreError("limit_exceeded", `delegation depth cap (${LIMITS.maxDelegationDepth}) reached`);
        }
        if (this.ancestorParties(parent).has(assignee.id)) throw new CoreError("forbidden", "delegation cycle: assignee already participates in the parent chain");
      }

      const budget = this.resolveBudget(t.budget, parent);

      // Anti confused-deputy: the requester must itself be cleared for every reference it attaches.
      const refs = t.sourceRefs ?? [];
      if (refs.length > LIMITS.maxSourceRefs) throw new CoreError("limit_exceeded", "too many source refs");
      for (const r of refs) {
        if (!this.canAccessRef(caller, r)) {
          this.log(caller, "task.create", `${r.kind}:${r.id}`, "deny", "source ref not accessible to requester");
          throw new CoreError("forbidden", `source ref ${r.kind}:${r.id} is not accessible to you`);
        }
      }

      // Permission engine (minimal; WP-E1-03 owns the real one). Requester grant AND assignee policy.
      if (!me.granted.has(t.category)) {
        this.log(caller, "task.create", assignee.id, "deny", `requester lacks grant '${t.category}'`);
        throw new CoreError("forbidden", `you are not permitted to request '${t.category}' work`);
      }
      const decision = this.policyFor(assignee, t.category);
      if (decision === "deny") {
        this.log(caller, "task.create", assignee.id, "deny", `assignee policy denies '${t.category}'`);
        throw new CoreError("forbidden", `'${t.category}' requests to this entity are denied by its owner`);
      }

      const conv = t.conversationId ? this.memberConversation(caller, t.conversationId) : this.dm(caller, assignee.id);
      if (!conv.members.has(assignee.id)) throw new CoreError("forbidden", "assignee is not a member of that conversation");

      const nowIso = new Date(this.now()).toISOString();
      const taskId = id("tsk");
      const origin = this.storeMessage(caller, conv, [{ text: `[task ${taskId} · ${t.category}] ${t.goal}` }, ...(t.input ?? [])], taskId);
      const rec: TaskRec = {
        id: taskId,
        conversationId: conv.id,
        parentTaskId: parent?.id,
        depth,
        requesterId: caller,
        assigneeId: assignee.id,
        category: t.category,
        goal: t.goal,
        expectedOutput: t.expectedOutput,
        constraints: t.constraints,
        sourceRefs: refs,
        state: "submitted",
        hops: 0,
        budget,
        deadlineMs: this.now() + budget.maxRuntimeSec * 1000,
        artifacts: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        turnsWithoutProgress: 0,
        originMessageId: origin.id,
      };
      this.tasks.set(taskId, rec);
      this.log(caller, "task.create", taskId, "allow", t.category);
      if (decision === "ask") {
        rec.resumeState = "queued";
        this.transition(rec, "awaiting_approval", "policy_requires_approval", "system", "task.policy_ask");
      } else {
        this.transition(rec, "queued", undefined, "system", "task.policy_allow");
      }
      return this.view(rec);
    });
  }

  updateTask(caller: string, u: UpdateTaskInput): TaskView {
    const t = this.taskForParty(caller, u.taskId);
    this.enforceDeadline(t);
    if (TERMINAL_STATES.has(t.state)) throw new CoreError("invalid_transition", `task is already ${t.state}`);
    const isAssignee = t.assigneeId === caller;
    const isRequester = t.requesterId === caller;
    const need = (cond: boolean, who: string) => {
      if (!cond) {
        this.log(caller, `task.${u.action}`, t.id, "deny", `only the ${who} may ${u.action}`);
        throw new CoreError("forbidden", `only the ${who} may ${u.action} this task`);
      }
    };
    const from = (...states: TaskState[]) => {
      if (!states.includes(t.state)) throw new CoreError("invalid_transition", `cannot ${u.action} a task that is ${t.state}`);
    };
    const conv = this.conversations.get(t.conversationId)!;

    switch (u.action) {
      case "accept": {
        need(isAssignee, "assignee");
        from("queued");
        this.messages.get(t.originMessageId)?.receipts.set(caller, "accepted_for_execution");
        this.transition(t, "working", undefined, caller, "task.accept");
        break;
      }
      case "request_input":
        need(isAssignee, "assignee");
        from("working");
        checkParts(u.parts);
        this.storeMessage(caller, conv, u.parts, t.id);
        this.transition(t, "input_required", undefined, caller, "task.request_input");
        break;
      case "provide_input":
        need(isRequester, "requester");
        from("input_required");
        checkParts(u.parts);
        this.storeMessage(caller, conv, u.parts, t.id);
        this.transition(t, "working", undefined, caller, "task.provide_input");
        break;
      case "complete":
        need(isAssignee, "assignee");
        from("working");
        if (!Array.isArray(u.artifacts) || u.artifacts.length === 0) throw new CoreError("invalid_input", "complete requires at least one artifact");
        for (const a of u.artifacts) checkParts(a.parts);
        t.artifacts = u.artifacts.map((a) => ({ artifactId: id("art"), name: a.name, parts: a.parts }));
        this.transition(t, "completed", undefined, caller, "task.complete");
        break;
      case "fail":
        need(isAssignee, "assignee");
        from("working", "input_required");
        if (u.parts) this.storeMessage(caller, conv, u.parts, t.id);
        this.transition(t, "failed", "assignee_reported_failure", caller, "task.fail");
        this.cascadeCancel(t.id, "parent_cancelled");
        break;
      case "reject":
        need(isAssignee, "assignee");
        from("queued", "working");
        if (u.parts) this.storeMessage(caller, conv, u.parts, t.id);
        this.transition(t, "failed", "rejected_by_assignee", caller, "task.reject");
        this.cascadeCancel(t.id, "parent_cancelled");
        break;
      case "cancel":
        need(isRequester, "requester");
        this.transition(t, "cancelled", undefined, caller, "task.cancel");
        this.cascadeCancel(t.id, "parent_cancelled");
        break;
      case "reclassify": {
        need(isAssignee, "assignee");
        from("queued", "working", "input_required");
        if (!ACTION_CATEGORIES.includes(u.category)) throw new CoreError("invalid_input", "unknown category");
        if (categoryRisk(u.category) <= categoryRisk(t.category)) throw new CoreError("invalid_input", "reclassify may only raise the risk category");
        t.category = u.category;
        const requester = this.mustEntity(t.requesterId);
        const assignee = this.mustEntity(t.assigneeId);
        const policy = this.policyFor(assignee, u.category);
        if (!requester.granted.has(u.category) || policy === "deny") {
          this.transition(t, "failed", "permission_denied", caller, "task.reclassify");
          this.cascadeCancel(t.id, "parent_cancelled");
        } else if (policy === "ask") {
          t.resumeState = t.state;
          this.transition(t, "awaiting_approval", "reclassified_needs_approval", caller, "task.reclassify");
        } else {
          this.log(caller, "task.reclassify", t.id, "allow", u.category);
        }
        break;
      }
      default:
        throw new CoreError("invalid_input", "unknown action");
    }
    return this.view(t);
  }

  getTask(caller: string, taskId: string): TaskView {
    const t = this.taskForParty(caller, taskId);
    this.enforceDeadline(t);
    return this.view(t);
  }

  listGroups(caller: string): ConversationView[] {
    return [...this.conversations.values()].filter((c) => c.kind === "group" && c.members.has(caller)).map((c) => this.convView(c));
  }

  getConversationHistory(caller: string, convId: string, opts?: { limit?: number; before?: string }): MessageView[] {
    const conv = this.memberConversation(caller, convId);
    let ids = this.convMessages.get(conv.id) ?? [];
    if (opts?.before) {
      const i = ids.indexOf(opts.before);
      if (i >= 0) ids = ids.slice(0, i);
    }
    const limit = Math.min(opts?.limit ?? 50, LIMITS.maxHistoryBatch);
    return ids.slice(-limit).map((i) => this.msgView(this.messages.get(i)!));
  }

  // ---------------------------------------------------------------- internals

  /** Test hook: dump raw state to assert that no plaintext secret is stored. */
  _debugDump(): string {
    return JSON.stringify({ entities: [...this.entities.values()].map((e) => ({ ...e, verifiedSkills: [...e.verifiedSkills], granted: [...e.granted] })) });
  }

  private log(actor: string, action: string, target?: string, decision?: string, detail?: string) {
    this.audit.push({ at: new Date(this.now()).toISOString(), actor, action, target, decision, detail });
  }

  private mustEntity(entityId: string): EntityRec {
    const e = this.entities.get(entityId);
    if (!e) throw new CoreError("not_found", "entity not found");
    return e;
  }

  private mustTask(taskId: string): TaskRec {
    const t = this.tasks.get(taskId);
    if (!t) throw new CoreError("not_found", "task not found");
    return t;
  }

  /** Cross-workspace entities are indistinguishable from nonexistent ones. */
  private visibleEntity(caller: string, entityId: string): EntityRec {
    const me = this.mustEntity(caller);
    const e = this.entities.get(entityId);
    if (!e || e.workspaceId !== me.workspaceId) throw new CoreError("not_found", "entity not found");
    return e;
  }

  private memberConversation(caller: string, convId: string): ConversationRec {
    const c = this.conversations.get(convId);
    if (!c || !c.members.has(caller)) {
      this.log(caller, "conversation.access", convId, "deny");
      throw new CoreError("not_found", "conversation not found");
    }
    return c;
  }

  private taskForParty(caller: string, taskId: string): TaskRec {
    const t = this.tasks.get(taskId);
    if (!t || (t.requesterId !== caller && t.assigneeId !== caller)) {
      this.log(caller, "task.access", taskId, "deny");
      throw new CoreError("not_found", "task not found");
    }
    return t;
  }

  private canAccessRef(caller: string, r: SourceRef): boolean {
    if (r.kind === "conversation") return !!this.conversations.get(r.id)?.members.has(caller);
    if (r.kind === "message") {
      const m = this.messages.get(r.id);
      return !!m && !!this.conversations.get(m.conversationId)?.members.has(caller);
    }
    if (r.kind === "task") {
      const t = this.tasks.get(r.id);
      return !!t && (t.requesterId === caller || t.assigneeId === caller);
    }
    return false;
  }

  private assertUniqueName(workspaceId: string, name: string, exceptId?: string) {
    const lower = name.toLowerCase();
    for (const e of this.entities.values()) {
      if (e.workspaceId === workspaceId && e.id !== exceptId && e.name.toLowerCase() === lower) throw new CoreError("conflict", "an entity with that name already exists in this workspace");
    }
  }

  private dm(a: string, b: string): ConversationRec {
    const key = [a, b].sort().join("|");
    const existing = this.dmIndex.get(key);
    if (existing) return this.conversations.get(existing)!;
    const conv: ConversationRec = { id: id("conv"), workspaceId: this.mustEntity(a).workspaceId, kind: "dm", members: new Set([a, b]) };
    this.conversations.set(conv.id, conv);
    this.dmIndex.set(key, conv.id);
    return conv;
  }

  private storeMessage(caller: string, conv: ConversationRec, parts: Part[], taskId?: string, inReplyTo?: string): MessageRec {
    const sender = this.mustEntity(caller);
    const msg: MessageRec = {
      id: id("msg"),
      conversationId: conv.id,
      taskId,
      inReplyTo,
      from: { id: caller, name: sender.name },
      parts: structuredClone(parts),
      createdAt: new Date(this.now()).toISOString(),
      receipts: new Map([...conv.members].filter((m) => m !== caller).map((m) => [m, "stored" as ReceiptState])),
    };
    this.messages.set(msg.id, msg);
    this.convMessages.set(conv.id, [...(this.convMessages.get(conv.id) ?? []), msg.id]);
    return msg;
  }

  private policyFor(assignee: EntityRec, category: ActionCategory): "allow" | "ask" | "deny" {
    const m = assignee.approvalMode;
    if (m.kind === "full_access_workspace") return "allow";
    if (m.kind === "ask_every_time") return "ask";
    return m.rules[category] ?? "ask";
  }

  private resolveBudget(req: Partial<Budget> | undefined, parent?: TaskRec): Budget {
    const runtime = req?.maxRuntimeSec ?? LIMITS.defaultMaxRuntimeSec;
    const hops = req?.maxHops ?? LIMITS.defaultMaxHops;
    if (!Number.isInteger(runtime) || runtime < 1 || runtime > LIMITS.ceilingMaxRuntimeSec) throw new CoreError("limit_exceeded", `maxRuntimeSec must be 1..${LIMITS.ceilingMaxRuntimeSec}`);
    if (!Number.isInteger(hops) || hops < 1 || hops > LIMITS.ceilingMaxHops) throw new CoreError("limit_exceeded", `maxHops must be 1..${LIMITS.ceilingMaxHops}`);
    if (req?.maxCostUsd !== undefined && (req.maxCostUsd < 0 || req.maxCostUsd > LIMITS.ceilingMaxCostUsd)) throw new CoreError("limit_exceeded", `maxCostUsd must be 0..${LIMITS.ceilingMaxCostUsd}`);
    let maxRuntimeSec = runtime;
    if (parent) {
      const remaining = Math.floor((parent.deadlineMs - this.now()) / 1000);
      if (remaining < 1) throw new CoreError("limit_exceeded", "parent task has no runtime budget left");
      maxRuntimeSec = Math.min(runtime, remaining); // a child can never outlive its parent
    }
    return { maxRuntimeSec, maxHops: hops, ...(req?.maxCostUsd !== undefined ? { maxCostUsd: req.maxCostUsd } : {}) };
  }

  private enforceDeadline(t: TaskRec) {
    if (!TERMINAL_STATES.has(t.state) && this.now() > t.deadlineMs) {
      this.transition(t, "failed", "budget_runtime_exceeded", "system", "task.budget_exceeded");
      this.cascadeCancel(t.id, "parent_cancelled");
    }
  }

  private pause(t: TaskRec, reason: TaskReason, actor: string) {
    t.resumeState = t.state;
    this.transition(t, "awaiting_approval", reason, actor, "task.pause");
  }

  private transition(t: TaskRec, to: TaskState, reason: TaskReason | undefined, actor: string, action: string) {
    const fromState = t.state;
    t.state = to;
    t.reason = reason;
    t.turnsWithoutProgress = 0;
    t.updatedAt = new Date(this.now()).toISOString();
    this.log(actor, action, t.id, undefined, `${fromState} -> ${to}${reason ? ` (${reason})` : ""}`);
    const ev = { task: this.view(t), event: `${fromState}->${to}`, at: t.updatedAt };
    for (const party of [t.requesterId, t.assigneeId]) {
      if (party !== actor) this.taskEvents.set(party, [...(this.taskEvents.get(party) ?? []), ev]);
    }
  }

  private cascadeCancel(parentId: string, reason: TaskReason): TaskView[] {
    const out: TaskView[] = [];
    for (const child of this.tasks.values()) {
      if (child.parentTaskId === parentId) {
        if (!TERMINAL_STATES.has(child.state)) {
          this.transition(child, "cancelled", reason, "system", "task.cascade_cancel");
          out.push(this.view(child));
        }
        out.push(...this.cascadeCancel(child.id, reason));
      }
    }
    return out;
  }

  private ancestorParties(t: TaskRec): Set<string> {
    const s = new Set<string>();
    let cur: TaskRec | undefined = t;
    while (cur) {
      s.add(cur.requesterId);
      s.add(cur.assigneeId);
      cur = cur.parentTaskId ? this.tasks.get(cur.parentTaskId) : undefined;
    }
    return s;
  }

  private idempotent<T>(caller: string, key: string | undefined, fn: () => T): T {
    if (!key) return fn();
    if (key.length > LIMITS.maxIdempotencyKeyChars) throw new CoreError("invalid_input", "idempotency key too long");
    const k = `${caller}|${key}`;
    if (this.idempotency.has(k)) return this.idempotency.get(k) as T;
    const result = fn();
    this.idempotency.set(k, result);
    return result;
  }

  private publicProfile(e: EntityRec): EntityPublicProfile {
    const skills = e.claimedSkills.map((s) => ({ ...s, verified: e.verifiedSkills.get(s.id) === digest(s) }));
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      connectionType: e.connectionType,
      availability: "unknown",
      skills,
      card: structuredClone(e.card),
      profileStatus: !e.registered ? "unregistered" : skills.every((s) => s.verified) ? "verified" : "pending_verification",
    };
  }

  private msgView(m: MessageRec): MessageView {
    const { receipts: _r, ...v } = m;
    return structuredClone(v);
  }

  private convView(c: ConversationRec): ConversationView {
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      members: [...c.members].map((m) => ({ id: m, name: this.mustEntity(m).name, isOrchestrator: c.orchestratorId === m })),
    };
  }

  private view(t: TaskRec): TaskView {
    const { deadlineMs, turnsWithoutProgress: _t, resumeState: _r, originMessageId: _o, ...rest } = t;
    return structuredClone({ ...rest, deadline: new Date(deadlineMs).toISOString() });
  }
}

/** Core-side payload validation (defence in depth: the core never trusts the MCP layer's checks). */
export function checkParts(parts: unknown): asserts parts is Part[] {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > LIMITS.maxPartsPerMessage) throw new CoreError("invalid_input", `1-${LIMITS.maxPartsPerMessage} parts required`);
  for (const p of parts) {
    if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
      if ((p as { text: string }).text.length > LIMITS.maxTextChars) throw new CoreError("limit_exceeded", `text part exceeds ${LIMITS.maxTextChars} chars`);
    } else if (p && typeof p === "object" && "data" in p) {
      if (Buffer.byteLength(JSON.stringify((p as { data: unknown }).data) ?? "") > LIMITS.maxDataPartBytes) throw new CoreError("limit_exceeded", `data part exceeds ${LIMITS.maxDataPartBytes} bytes`);
    } else {
      throw new CoreError("invalid_input", "each part must be {text} or {data}");
    }
  }
}

class ReferenceSession implements CoreSession {
  constructor(private readonly core: ReferenceCore, readonly entityId: string) {}
  async whoami() { return this.core.whoami(this.entityId); }
  async proposeProfile(p: { card: Record<string, unknown> }) { return this.core.proposeProfile(this.entityId, p.card); }
  async listEntities(f?: { query?: string; skillTag?: string }) { return this.core.listEntities(this.entityId, f); }
  async getEntity(id: string) { return this.core.getEntity(this.entityId, id); }
  async sendMessage(m: SendMessageInput) { return this.core.sendMessage(this.entityId, m); }
  async checkInbox(o?: { limit?: number }) { return this.core.checkInbox(this.entityId, o?.limit); }
  async createTask(t: CreateTaskInput) { return this.core.createTask(this.entityId, t); }
  async updateTask(u: UpdateTaskInput) { return this.core.updateTask(this.entityId, u); }
  async getTask(id: string) { return this.core.getTask(this.entityId, id); }
  async listGroups() { return this.core.listGroups(this.entityId); }
  async getConversationHistory(id: string, o?: { limit?: number; before?: string }) { return this.core.getConversationHistory(this.entityId, id, o); }
}
