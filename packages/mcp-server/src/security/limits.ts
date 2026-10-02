// Safety rails (ARCHITECTURE §2.9). Single source of truth for numeric limits; documented in SECURITY.md §4.

export const LIMITS = {
  /** Max nesting of delegated sub-tasks (root task = depth 0). */
  maxDelegationDepth: 3,
  /** Default / ceiling for agent-authored messages on one task before it pauses for a human. */
  defaultMaxHops: 24,
  ceilingMaxHops: 100,
  /** Consecutive agent messages on a task with no state change before it pauses (ping-pong guard). */
  maxTurnsWithoutProgress: 10,
  /** Default / ceiling runtime budget per task. */
  defaultMaxRuntimeSec: 15 * 60,
  ceilingMaxRuntimeSec: 24 * 60 * 60,
  ceilingMaxCostUsd: 25,

  /** Payload sizes. */
  maxTextChars: 16_000,
  maxPartsPerMessage: 10,
  maxDataPartBytes: 64 * 1024,
  maxGoalChars: 4_000,
  maxConstraints: 20,
  maxSourceRefs: 20,
  maxIdempotencyKeyChars: 128,
  maxInboxBatch: 50,
  maxHistoryBatch: 100,

  /** Profiles. */
  maxNameChars: 64,
  maxDescriptionChars: 2_000,
  maxSkills: 32,

  /** Per-entity request rate at the MCP edge (token bucket). */
  rateLimitPerMinute: 120,
} as const;
