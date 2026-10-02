// SignalDesk task states <-> A2A v1.0 TaskState (lf.a2a.v1.TaskState). Normative table: docs/protocol/A2A.md §3.

import type { TaskReason, TaskState } from "../core/types.js";

export const A2A_TASK_STATES = [
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

export const SIGNALDESK_STATE_METADATA_KEY = "signaldesk/state";
export const SIGNALDESK_REASON_METADATA_KEY = "signaldesk/reason";

// ADR-008 §3: only failed + permission_denied is shown as REJECTED.
const REJECTION_REASONS: ReadonlySet<TaskReason> = new Set(["permission_denied"]);

/** Outbound: what an external A2A client sees. Lossy by design; the exact state rides in metadata. */
export function toA2AState(state: TaskState, reason?: TaskReason): { state: A2ATaskState; metadata: Record<string, string> } {
  const metadata: Record<string, string> = { [SIGNALDESK_STATE_METADATA_KEY]: state };
  if (reason) metadata[SIGNALDESK_REASON_METADATA_KEY] = reason;
  switch (state) {
    case "submitted":
    case "queued":
      return { state: "TASK_STATE_SUBMITTED", metadata };
    case "working":
      return { state: "TASK_STATE_WORKING", metadata };
    case "awaiting_approval":
      // The requester cannot resolve a human approval by sending input or credentials, so neither
      // INPUT_REQUIRED nor AUTH_REQUIRED is truthful. WORKING tells the client to wait. (ADR-008)
      return { state: "TASK_STATE_WORKING", metadata };
    case "input_required":
      return { state: "TASK_STATE_INPUT_REQUIRED", metadata };
    case "completed":
      return { state: "TASK_STATE_COMPLETED", metadata };
    case "failed":
      return { state: reason && REJECTION_REASONS.has(reason) ? "TASK_STATE_REJECTED" : "TASK_STATE_FAILED", metadata };
    case "cancelled":
      return { state: "TASK_STATE_CANCELED", metadata }; // any reason, incl. approval_rejected / rejected_by_assignee
  }
}

/** Inbound: a status reported by an external A2A agent we delegated to. */
export function fromA2AState(a2a: A2ATaskState): { state: TaskState; reason?: TaskReason } {
  switch (a2a) {
    case "TASK_STATE_SUBMITTED":
      return { state: "submitted" };
    case "TASK_STATE_WORKING":
      return { state: "working" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { state: "input_required" };
    case "TASK_STATE_AUTH_REQUIRED":
      // The remote agent needs credentials/consent; only a human can provide those. Never forward secrets in chat (§2.8).
      // Mow's ruling on ADR-008 (2026-10-02): reuse policy_requires_approval from the closed enum.
      return { state: "awaiting_approval", reason: "policy_requires_approval" };
    case "TASK_STATE_COMPLETED":
      return { state: "completed" };
    case "TASK_STATE_FAILED":
      return { state: "failed", reason: "assignee_reported_failure" };
    case "TASK_STATE_REJECTED":
      // ADR-008 §2: an agent declining is cancelled with rejected_by_assignee, not failed.
      return { state: "cancelled", reason: "rejected_by_assignee" };
    case "TASK_STATE_CANCELED":
      return { state: "cancelled" };
    case "TASK_STATE_UNSPECIFIED":
      throw new Error("TASK_STATE_UNSPECIFIED is not a valid status update");
  }
}
