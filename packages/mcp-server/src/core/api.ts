// The interface between the MCP layer (Entity 2) and the core (Entity 1).
// PROPOSED FOR FREEZE — see docs/protocol/CORE-API.md and ADR-P2. Do not change without an ADR.
//
// Design rule: the caller's identity is bound when the session is created from an API key.
// No method takes a "caller" or "from" argument, so the MCP layer cannot spoof identity even if buggy.

import type {
  ActionCategory,
  Budget,
  ConversationId,
  ConversationView,
  EntityId,
  EntityPublicProfile,
  InboxItem,
  MessageId,
  MessageView,
  Part,
  Receipt,
  SelfProfile,
  SourceRef,
  TaskId,
  TaskView,
} from "./types.js";

export interface CoreApi {
  /** Resolve an API key to a session bound to exactly one entity. Returns null for unknown/revoked keys. */
  authenticate(apiKey: string): Promise<CoreSession | null>;
}

export interface ProfileProposal {
  /** Partial A2A AgentCard. Validated against schemas/agent-card.schema.json after the server fills transport fields. */
  card: Record<string, unknown>;
}

export interface SendMessageInput {
  /** Exactly one of `toEntityId` (DM, auto-created) or `conversationId`. */
  toEntityId?: EntityId;
  conversationId?: ConversationId;
  taskId?: TaskId;
  inReplyTo?: MessageId;
  parts: Part[];
  idempotencyKey?: string;
}

export interface CreateTaskInput {
  assigneeId: EntityId;
  conversationId?: ConversationId;
  parentTaskId?: TaskId;
  category: ActionCategory;
  goal: string;
  expectedOutput?: string;
  constraints?: string[];
  input?: Part[];
  sourceRefs?: SourceRef[];
  budget?: Partial<Budget>;
  idempotencyKey?: string;
}

export type UpdateTaskInput =
  | { taskId: TaskId; action: "accept" }
  | { taskId: TaskId; action: "request_input"; parts: Part[] }
  | { taskId: TaskId; action: "provide_input"; parts: Part[] }
  | { taskId: TaskId; action: "complete"; artifacts: { name?: string; parts: Part[] }[] }
  | { taskId: TaskId; action: "fail"; parts?: Part[] }
  | { taskId: TaskId; action: "reject"; parts?: Part[] }
  | { taskId: TaskId; action: "cancel" }
  | { taskId: TaskId; action: "reclassify"; category: ActionCategory };

/** Everything an authenticated entity can do. Approvals and grants are deliberately absent (human-only, see AdminApi). */
export interface CoreSession {
  readonly entityId: EntityId;
  whoami(): Promise<SelfProfile>;
  proposeProfile(p: ProfileProposal): Promise<SelfProfile>;
  listEntities(filter?: { query?: string; skillTag?: string }): Promise<EntityPublicProfile[]>;
  getEntity(id: EntityId): Promise<EntityPublicProfile>;
  sendMessage(m: SendMessageInput): Promise<{ message: MessageView; receipts: Receipt[] }>;
  /** Returns undelivered items for this entity and marks message receipts `delivered`. */
  checkInbox(opts?: { limit?: number }): Promise<InboxItem[]>;
  createTask(t: CreateTaskInput): Promise<TaskView>;
  updateTask(u: UpdateTaskInput): Promise<TaskView>;
  getTask(id: TaskId): Promise<TaskView>;
  listGroups(): Promise<ConversationView[]>;
  getConversationHistory(id: ConversationId, opts?: { limit?: number; before?: MessageId }): Promise<MessageView[]>;
}

/**
 * Human-only operations (web UI, WP-E1-04). MUST NOT be reachable with an entity API key,
 * from MCP, or from any agent-facing endpoint. Included here so conformance tests can drive them.
 */
export interface AdminApi {
  createWorkspace(name: string): Promise<{ workspaceId: string }>;
  createEntity(input: {
    workspaceId: string;
    name: string;
    connectionType: "A" | "B" | "C";
    webhookUrl?: string;
  }): Promise<{ entityId: EntityId; apiKey: string }>;
  revokeKey(entityId: EntityId): Promise<{ apiKey: string }>;
  verifySkill(entityId: EntityId, skillId: string): Promise<void>;
  grantCategories(entityId: EntityId, categories: ActionCategory[]): Promise<void>;
  setApprovalMode(
    entityId: EntityId,
    mode:
      | { kind: "ask_every_time" }
      | { kind: "standing_rules"; rules: Partial<Record<ActionCategory, "allow" | "ask" | "deny">> }
      | { kind: "full_access_workspace" },
  ): Promise<void>;
  createGroup(input: {
    workspaceId: string;
    name: string;
    memberIds: EntityId[];
    orchestratorId?: EntityId;
  }): Promise<{ conversationId: ConversationId }>;
  decideApproval(taskId: TaskId, decision: "approve" | "reject"): Promise<TaskView>;
  /** The stop button. Cancels the task and every descendant. */
  stopTask(taskId: TaskId): Promise<TaskView[]>;
  auditLog(): Promise<{ at: string; actor: string; action: string; target?: string; decision?: string; detail?: string }[]>;
}
