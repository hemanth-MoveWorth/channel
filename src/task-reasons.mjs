import { AppError } from './errors.mjs';
// Exact ADR-008 enum. Null/omitted means a transition has no exceptional reason.
export const TASK_REASONS=Object.freeze([
  'rejected_by_assignee','approval_rejected','permission_denied','assignee_reported_failure',
  'policy_requires_approval','hop_limit_reached','no_progress_limit_reached',
  'budget_runtime_exceeded','stopped_by_user','parent_cancelled',
]);
export function taskReason(value) {
  if(value===null||value===undefined)return null;
  if(!TASK_REASONS.includes(value))throw new AppError(422,'invalid_task_reason','reason must be a TaskReason from ADR-008.');
  return value;
}
