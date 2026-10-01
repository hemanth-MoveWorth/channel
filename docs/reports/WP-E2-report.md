# Entity 2 report: WP-E2-01 … WP-E2-03 (2026-10-01)

To: Mow. Branch: `e2/protocol-security`.

## WP-E2-01: MCP server

**Built:** `packages/mcp-server`. It has the 10 contracted tools over stdio (`src/bin/stdio.ts`) and streamable HTTP (`src/http.ts`), backed by the `CoreApi` interface (`src/core/api.ts`). Tool reference and setup: `docs/protocol/MCP-TOOLS.md`.

**Acceptance:**
- `test/transports.test.ts` spawns the real stdio entrypoint as a child process (exactly how Claude Code and Cursor launch MCP servers) against a running hub. It registers a profile, sends a message, the peer replies over HTTP, and the stdio client sees the reply in `check_inbox`. ✅
- `test/mcp-tools.test.ts` covers every tool, the full task lifecycle, approvals, groups and idempotency. ✅
- **Not yet done:** a manual run with the actual Claude Code app. The Claude Code CLI isn't installed on this machine. The protocol path is identical (official MCP SDK client over stdio). Steps are in MCP-TOOLS.md "Claude Code / Cursor over stdio". This takes 5 minutes for the user.

**Deviations:**
- "Freeze the interface with Entity 1 first": Entity 1 hasn't delivered yet. I **proposed** the interface (CORE-API.md, ADR-P2) and built against it with an in-memory reference core. **Mow and Entity 1 need to accept or amend it.**
- The dev hub exposes `/core/rpc` so multiple stdio clients share one core. It's dev-only and gets replaced by Entity 1's API.

## WP-E2-02: A2A compatibility

**Built:**
- `schemas/agent-card.schema.json` (A2A v1.0.1 AgentCard + SignalDesk strictness)
- a valid sample card and an invalid sample card
- `src/a2a/mapping.ts`
- `docs/protocol/A2A.md` (field mapping, state tables both directions, external-agent interop guide)

**Acceptance:** the sample card validates and the self-grant card fails, naming its offending fields (`test/a2a.test.ts`). ✅ The mapping table needs **Mow's review** (A2A.md §3, ADR-P3).

**Deviation:** none. Note that the A2A gateway endpoint is explicitly out of prototype scope (A2A.md §5).

## WP-E2-03: Security review + sign-off

**Built:**
- `SECURITY.md`: trust boundary, layered injection defence, keys and auth, capability verification flow, limits, threat→test map, checklist, residual risks, sign-off
- 31 adversarial tests (ADV-01 to ADV-31)

**Acceptance:**
- Checklist in repo. ✅
- Adversarial tests pass: 50/50 total. ✅
- Mutation spot-check: removing session binding, envelope defang, or the source-ref check fails exactly ADV-27, ADV-11 and ADV-16. ✅
- **Written sign-off:** posted in SECURITY.md §9. **E2 layer: PASS (localhost only). Whole prototype: NOT SIGNED OFF.** Blocked on gates G1, G3–G6, which are Entity 1 deliverables, and on G2 for any non-localhost exposure.

## Decisions needed from Mow
1. Accept or amend ADR-P1 through ADR-P6 (ARCHITECTURE.md §5).
2. Ask Entity 1 to provide `makeCore({ now })` so the adversarial suite can gate the real core (SECURITY.md §6).
3. Confirm Entity 2 reviews G3 (webhook signing) and G4 (exactly-once) designs before Entity 1 implements them.
