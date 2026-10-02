// WP-E2-02: Agent Card schema + state mapping.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAgentCard } from "../src/a2a/card.js";
import { A2A_TASK_STATES, fromA2AState, toA2AState } from "../src/a2a/mapping.js";
import { TASK_REASONS, TASK_STATES } from "../src/core/types.js";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../../schemas/examples/${f}`, import.meta.url), "utf8"));

describe("Agent Card schema", () => {
  it("sample card validates", () => {
    expect(validateAgentCard(load("agent-card.research-agent.json"))).toEqual({ ok: true });
  });

  it("self-granting card is rejected with the offending fields named", () => {
    const v = validateAgentCard(load("agent-card.invalid-self-grant.json"));
    expect(v.ok).toBe(false);
    const errs = !v.ok ? v.errors.join("\n") : "";
    expect(errs).toContain("verifiedPermissions");
    expect(errs).toContain("grantedCategories");
    expect(errs).toContain("verified");
  });

  it("required A2A fields are enforced", () => {
    const card = load("agent-card.research-agent.json");
    for (const k of ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
      const c = { ...card };
      delete c[k];
      expect(validateAgentCard(c).ok, k).toBe(false);
    }
  });
});

describe("Task state mapping", () => {
  it("every SignalDesk state maps to a valid A2A state and carries the exact state in metadata", () => {
    for (const s of TASK_STATES) {
      const m = toA2AState(s);
      expect(A2A_TASK_STATES).toContain(m.state);
      expect(m.state).not.toBe("TASK_STATE_UNSPECIFIED");
      expect(m.metadata["signaldesk/state"]).toBe(s);
    }
  });

  it("ADR-008 §3: only failed + permission_denied is REJECTED; cancelled is always CANCELED", () => {
    expect(toA2AState("failed", "permission_denied").state).toBe("TASK_STATE_REJECTED");
    for (const r of TASK_REASONS.filter((x) => x !== "permission_denied")) expect(toA2AState("failed", r).state, r).toBe("TASK_STATE_FAILED");
    for (const r of TASK_REASONS) expect(toA2AState("cancelled", r).state, r).toBe("TASK_STATE_CANCELED");
    expect(toA2AState("cancelled", "approval_rejected").metadata["signaldesk/reason"]).toBe("approval_rejected");
  });

  it("awaiting_approval is shown as WORKING (client must wait, cannot resolve it)", () => {
    expect(toA2AState("awaiting_approval").state).toBe("TASK_STATE_WORKING");
  });

  it("every inbound A2A state except UNSPECIFIED maps to a SignalDesk state", () => {
    for (const a of A2A_TASK_STATES) {
      if (a === "TASK_STATE_UNSPECIFIED") {
        expect(() => fromA2AState(a)).toThrow();
        continue;
      }
      expect(TASK_STATES).toContain(fromA2AState(a).state);
    }
    expect(fromA2AState("TASK_STATE_AUTH_REQUIRED")).toEqual({ state: "awaiting_approval" });
    expect(fromA2AState("TASK_STATE_REJECTED")).toEqual({ state: "cancelled", reason: "rejected_by_assignee" });
    for (const a of A2A_TASK_STATES.filter((x) => x !== "TASK_STATE_UNSPECIFIED")) {
      const r = fromA2AState(a).reason;
      if (r) expect(TASK_REASONS, a).toContain(r); // ADR-008 §1: closed enum
    }
  });

  it("round-trips are stable for the states A2A can express", () => {
    for (const s of ["submitted", "working", "input_required", "completed", "cancelled"] as const) {
      expect(fromA2AState(toA2AState(s).state).state).toBe(s);
    }
  });
});
