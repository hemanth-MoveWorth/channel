# ADR-004 execution boundary

`permission_rules.rule_json` stores the canonical rule. Local admin/owner helpers
derive `created_by` from authenticated identity, never a caller's claimed identity.
`addRule` adds standing rules; `setPermissionMode` configures an entity or workspace
wildcard with explicit canonical rules for each resource/action. Ask mode writes
ask defaults, full access writes allow defaults, and standing mode removes mode
defaults. Existing standing rules remain subject to ADR-004 precedence. The seed
has no rules and therefore denies execution; tests configure their modes explicitly.

Evaluation follows ADR-004 in order: any matching deny, highest specificity,
ask over allow, highest priority, ties deny, and no match deny. A malformed
applicable stored rule also fails closed. Mode labels do not bypass this evaluator.
Every evaluation records its allow/ask/deny decision and reason in `audit_log`.

Task creation evaluates every recipient before queueing. Denial retains the audit
and cancelled task but sends no webhook. Before dispatch the worker rechecks all
recipients and pauses asks with a pending approval. Only a workspace admin/owner
human may approve or reject. Approval is bound to the task, attempt, context input,
and evaluated rule/source decisions. Transport retries reuse that approval; a
manual retry is a new attempt and needs a fresh ask decision. Changed decisions
invalidate the approval; rejection cancels the task. Approval never creates grants.

Sources carry metadata only. Registration derives ownership from the actor and
defaults to private. Only the owner or workspace admin may grant read access.
Every recipient needs ownership, a grant, or shared visibility, plus the applicable
permission rule. These requirements also apply under full access and after human
approval. Group membership gives conversation access, never source access.

The assembler accepts explicitly shared facts, constraints, expected output, and
registered source IDs. It reads the last 20 messages from the task's conversation
as data after membership/read checks; caller-supplied history is ignored. No source
content loader or provenance inference is added. Context inputs are omitted from
general task reads. Authorized packages are persisted per recipient and attempt.
Raw facts, history, credentials, and rule notes are not copied into audit reasons.

Configuration helpers are local application interfaces. ADR-003 freezes no rule or
source-management HTTP routes, so this package adds only its approve/reject routes.
Capability verification and budget/security sign-off remain Entity 2's packages.
