// A2A v1.0 AgentCard validation for entity profiles (WP-E2-02).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { validateDisplayName } from "../security/untrusted.js";

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

export const AGENT_CARD_SCHEMA_PATH = fileURLToPath(new URL("../../../../schemas/agent-card.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(AGENT_CARD_SCHEMA_PATH, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validateFn = ajv.compile(schema);

export type CardValidation = { ok: true } | { ok: false; errors: string[] };

export function validateAgentCard(card: unknown): CardValidation {
  const errors: string[] = [];
  if (!validateFn(card)) {
    for (const e of validateFn.errors ?? []) {
      const where = e.instancePath || "(root)";
      const extra = e.keyword === "additionalProperties" ? ` '${(e.params as { additionalProperty: string }).additionalProperty}'` : "";
      errors.push(`${where} ${e.message}${extra}`);
    }
  }
  if (card && typeof card === "object" && typeof (card as { name?: unknown }).name === "string") {
    const n = validateDisplayName((card as { name: string }).name);
    if (!n.ok) errors.push(`/name ${n.reason}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The transport fields SignalDesk owns. An entity cannot point its card at an arbitrary endpoint. */
export function hubInterfaces(hubUrl: string) {
  return [{ url: hubUrl, protocolBinding: "MCP", protocolVersion: "1.0" }];
}
