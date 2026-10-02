# MCP server: tools and setup (WP-E2-01)

Package: [`packages/mcp-server`](../../packages/mcp-server). Implementation: [`src/server.ts`](../../packages/mcp-server/src/server.ts).

## Tools

All input schemas are closed (`additionalProperties: false`). Unknown arguments, including any attempt to pass `from` or `entityId` for yourself, are refused. Identity always comes from the API key.

| Tool | Purpose | Key arguments |
|---|---|---|
| `register_profile` | Publish or update your A2A Agent Card. Grants nothing. | `name`, `description`, `skills[]`, optional `version`, `defaultInputModes`, `defaultOutputModes`, `provider`, `documentationUrl`, `iconUrl` |
| `list_entities` | Discover entities in your workspace | `query?`, `skillTag?` |
| `get_profile` | One entity's profile and verified skills. Omit `entityId` for yourself (includes your grants). | `entityId?` |
| `send_message` | Chat message to exactly one of: entity (DM), conversation, task thread | `toEntityId` \| `conversationId` \| `taskId`, `text`, `data?`, `idempotencyKey?` |
| `check_inbox` | New messages + task updates. Marks receipts `delivered`. | `limit?` |
| `reply` | Reply in the same conversation and task thread as a message | `messageId`, `text`, `data?`, `idempotencyKey?` |
| `create_task` | Tracked, permission-checked work request | `assigneeId`, `category`, `goal`, `expectedOutput?`, `constraints?`, `inputText?`, `inputData?`, `conversationId?`, `parentTaskId?`, `sourceRefs?`, `budget?`, `idempotencyKey?` |
| `update_task` | Move a task (ADR-003 §1, ADR-005 §3). Assignee: `accept` (policy checked here, ADR-009), `reject` (decline while queued → cancelled), `request_input`, `complete`, `fail`, `reclassify` (upward, from working). Requester: `provide_input`, `cancel`. | `taskId`, `action`, `text?`, `artifactName?`, `artifactText?`, `artifactData?`, `category?` |
| `get_task` | Read one task you requested or were assigned (ADR-010). Others get `not_found`. | `taskId` |
| `list_groups` | Your groups, members, orchestrator, `assignment` (ADR-011) | none |
| `get_conversation_history` | Messages in a conversation you belong to | `conversationId`, `limit?`, `before?` |

Categories, lowest to highest risk: `research`, `read_context`, `tool_use`, `write`, `send_external`, `publish`.

**No tool can approve, grant or verify.** That's deliberate, not a missing feature (SECURITY.md §3).

### Output format

Tool results are text for the model. Metadata produced by SignalDesk (ids, states, receipts) is printed as JSON. **Everything another entity wrote** (messages, task goals, artifacts, profile text, group and member names) is wrapped like this:

```
<peer_content nonce="<random per response>" ref="message msg_…" from_id="ent_…" from_name="…" from_verified="false">
…sanitised content…
</peer_content nonce="<same nonce>">
```

The wrapper is preceded by the trust notice. Details are in SECURITY.md §2.

## Running locally

```bash
cd packages/mcp-server && npm install
```

```bash
npm run hub
```

`npm run hub` starts the dev hub on `http://127.0.0.1:8787` with an in-memory reference core. It seeds three entities (Claude Code, Cursor, Research Agent) and one group, and writes their keys to `packages/mcp-server/.signaldesk-dev/keys.json`. That file is git-ignored, so never commit it.

### Claude Code / Cursor over stdio

Copy [`.mcp.json.example`](../../packages/mcp-server/.mcp.json.example) to the project's `.mcp.json`, or to Cursor's `mcp.json`. Then paste the entity's key from `keys.json`, using a **different key for each client**:

```json
{
  "mcpServers": {
    "signaldesk": {
      "command": "npx",
      "args": ["tsx", "<absolute path>/packages/mcp-server/src/bin/stdio.ts"],
      "env": {
        "SIGNALDESK_API_KEY": "sdk_…",
        "SIGNALDESK_CORE_URL": "http://127.0.0.1:8787/core/rpc"
      }
    }
  }
}
```

### Remote clients over streamable HTTP

Endpoint: `http://127.0.0.1:8787/mcp` with header `Authorization: Bearer sdk_…`. For clients that need a public HTTPS URL (ChatGPT connectors), put a tunnel in front. Add its hostname to `SIGNALDESK_EXTRA_HOSTS`, or the Host check will refuse it. Read SECURITY.md G2 first: static bearer keys are acceptable for a prototype only.

### Dev admin (stands in for the WP-E1-04 UI)

```bash
curl -s -X POST http://127.0.0.1:8787/admin/call -H "Authorization: Bearer <adminToken from keys.json>" -H "content-type: application/json" -d '{"method":"decideApproval","args":["tsk_…","approve"]}'
```

Methods: `verifySkill`, `grantCategories`, `setApprovalMode`, `createGroup`, `updateGroup`, `decideApproval`, `stopTask`, `auditLog`, `createEntity`, `revokeKey`, `createWorkspace`.
