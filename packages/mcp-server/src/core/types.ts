// Domain types shared by the MCP layer and the core.
// Normative source: docs/protocol/CORE-API.md (proposed for freeze, ADR-P2).

export type EntityId = string;
export type WorkspaceId = string;
export type ConversationId = string;
export type MessageId = string;
export type TaskId = string;

/** ARCHITECTURE §2.3. A = API/webhook, B = MCP client, C = proxied closed tool. */
export type ConnectionType = "A" | "B" | "C";

/** ARCHITECTURE §2.4 — the only task states. Nothing else may be stored. */
export const TASK_STATES = [
  "submitted",
  "queued",
  "working",
  "input_required",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled"]);

/** ARCHITECTURE §2.5 — delivery receipts, per recipient. */
export type ReceiptState = "stored" | "delivered" | "accepted_for_execution";

/**
 * Action categories a task can fall into, ordered from lowest to highest risk.
 * Permission rules (WP-E1-03) are evaluated per category. Proposed in ADR-P4.
 */
export const ACTION_CATEGORIES = [
  "research",
  "read_context",
  "tool_use",
  "write",
  "send_external",
  "publish",
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];
export const categoryRisk = (c: ActionCategory): number => ACTION_CATEGORIES.indexOf(c);

/** Why a task failed / paused. Free-form strings are not allowed so the UI and A2A mapping stay total. */
export type TaskReason =
  | "rejected_by_assignee"
  | "approval_rejected"
  | "permission_denied"
  | "budget_runtime_exceeded"
  | "hop_limit_reached"
  | "no_progress_limit_reached"
  | "reclassified_needs_approval"
  | "policy_requires_approval"
  | "external_auth_required"
  | "stopped_by_user"
  | "parent_cancelled"
  | "assignee_reported_failure";

/** A2A-shaped content part (A2A v1.0 `Part`, JSON form). Only text + data in the prototype. */
export type Part =
  | { text: string; mediaType?: string }
  | { data: unknown; mediaType?: string };

export interface Budget {
  /** Wall-clock limit from creation; enforced by the core. */
  maxRuntimeSec: number;
  /** Max agent-authored messages attached to this task before it pauses. */
  maxHops: number;
  /** Only enforceable for SignalDesk-hosted agents (type C proxies, built-in orchestrator). */
  maxCostUsd?: number;
}

/** A reference the requester attaches to a task. The requester must itself be cleared for it (anti confused-deputy). */
export type SourceRef =
  | { kind: "conversation"; id: ConversationId }
  | { kind: "message"; id: MessageId }
  | { kind: "task"; id: TaskId };

export interface SkillView {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  /** True only after the owning human verified it. Self-claims are always false. */
  verified: boolean;
}

/** What other entities may see about an entity. Never includes webhook URLs, owner identity, keys, or grants. */
export interface EntityPublicProfile {
  id: EntityId;
  name: string;
  description: string;
  connectionType: ConnectionType;
  availability: "online" | "offline" | "unknown";
  skills: SkillView[];
  /** A2A v1.0 AgentCard as self-described by the entity (untrusted). */
  card: Record<string, unknown>;
  profileStatus: "unregistered" | "pending_verification" | "verified";
}

export interface SelfProfile extends EntityPublicProfile {
  workspaceId: WorkspaceId;
  /** Categories this entity has been granted (by its human), for its own information. */
  grantedCategories: ActionCategory[];
}

export interface MessageView {
  id: MessageId;
  conversationId: ConversationId;
  taskId?: TaskId;
  inReplyTo?: MessageId;
  from: { id: EntityId | "human" | "system"; name: string };
  parts: Part[];
  createdAt: string;
}

export interface TaskView {
  id: TaskId;
  conversationId: ConversationId;
  parentTaskId?: TaskId;
  depth: number;
  requesterId: EntityId;
  assigneeId: EntityId;
  category: ActionCategory;
  goal: string;
  expectedOutput?: string;
  constraints?: string[];
  sourceRefs: SourceRef[];
  state: TaskState;
  reason?: TaskReason;
  hops: number;
  budget: Budget;
  deadline: string;
  artifacts: { artifactId: string; name?: string; parts: Part[] }[];
  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  messageId: MessageId;
  recipientId: EntityId;
  state: ReceiptState;
}

export type InboxItem =
  | { kind: "message"; message: MessageView; receipt: ReceiptState }
  | { kind: "task_update"; task: TaskView; event: string; at: string };

export interface ConversationView {
  id: ConversationId;
  kind: "dm" | "group";
  name?: string;
  members: { id: EntityId; name: string; isOrchestrator: boolean }[];
}

/** Errors the core may raise. The MCP layer maps them to tool errors without leaking internals. */
export type CoreErrorCode =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_transition"
  | "invalid_input"
  | "limit_exceeded"
  | "conflict";

export class CoreError extends Error {
  constructor(public readonly code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
  }
}
