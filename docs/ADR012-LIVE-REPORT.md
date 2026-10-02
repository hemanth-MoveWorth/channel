# ADR-012: real Hermes → Codex acceptance

**Result: the bounded local greeting passed on 2026-10-02.** This proves the
connectivity milestone, not full Phase 0 or SaaS readiness. G1 remains open.

## Actual exchange

- Human action: clicked **Run “Hi” exchange** in the local SignalDesk page.
- Hermes: installed Hermes CLI, configured `gemma4:31b` via `ollama-cloud`.
- Hermes session: `20261002_105205_c95f12`.
- Exchange: `827f80cb-7e4c-44c3-ab09-6c04dabf4222`.
- Hermes actually called MCP `list_entities`, `send_message`, and `check_inbox`.
- Greeting: **Hi**. SignalDesk created the two-member DM in persistent SQLite.
- The local connector claimed the greeting and launched the installed Codex CLI
  using its existing ChatGPT sign-in, with user configuration and integrations
  disabled, a read-only sandbox, stdin input, and an empty dedicated directory.
- Codex session: `01a0fd51-129e-74c1-8e15-f749ca64b3cf`.
- Actual generated reply: **Hi Hermes, this is Codex.**
- The connector posted that completed output using the separate Codex credential.
- Hermes read the reply at `2026-10-02T15:52:30.907Z` and ended with
  `Codex replied: "Hi Hermes, this is Codex."`

[Captured execution evidence](../evidence/live/2026-10-02-real-exchange.json)
contains the selected real Hermes session's messages/tool calls, actual Codex
completion events, and SQLite exchange/message records. It excludes credentials,
provider configuration, global memory, and unrelated conversations. The browser
shows both actual messages and completed delivery/read stages.

## E2 review requirements and proof

| Requirement | Implementation and verification |
| --- | --- |
| Isolate Codex; stdin, timeout, no resumed context | `codexArguments`, `peerPrompt`, and `runProcess`; real CLI turn completed with no observed tool calls. Test passes shell metacharacters literally through stdin and kills an overlong process. |
| Persistent SQLite | `scripts/live.mjs`, fixed `data/live/channel.db`; reopen test preserves messages, reply, and read state. |
| Core-owned DM creation | Authenticated core creates or reuses only an exact two-member same-workspace DM; identity/self/other-recipient tests and real DM creation. |
| Sender-scoped idempotency | SQLite key binds sender, content and recipient; replay returns original; changed content conflicts; no duplicate reply. |
| Atomic claim, durable bounds, crash handling | Competing database connections yield one claim; recovered claimed work becomes uncertain and cannot run automatically again; Stop and expiry prevent reply/claim. |
| Hermes reads actual answer | Real `check_inbox` tool result and Hermes final quotation, plus durable `read_at`. |
| No general work through this exception | Raw HTTP tests reject human fallback, wrong credentials, entity arming, and ordinary task/message bypass. |

Validation: **37/37 core tests**, **57/57 existing MCP package tests**, MCP
TypeScript typecheck passed. These automated tests use scripted fixtures and are
separate from the real exchange evidence above.

## Real failure found and repaired

The first run (`7fa52729-9343-4ba7-8706-10a4aad0f44e`) failed before sending a
message. Hermes discovered the MCP tools but falsely reported its subprocess dead.
The installed `tools/mcp_tool.py`, in `MCPServerTask._stdio_children_dead`, contained:

```python
if not psutil.pid_exists(pid):
    continue
return True  # alive (signal permission irrelevant for liveness)
return False  # at least one child alive
```

Removed only the erroneous `return True` line in the installed Hermes copy.
The original is backed up locally as `data/live/hermes-mcp_tool-before-fix.py`.
Direct runtime probes now return false for an actual live PID and true for a
nonexistent PID; the following real MCP exchange passed. This local dependency
repair is not an upstream Hermes release or a change shipped inside SignalDesk.
An upstream update may replace it. The installed Hermes repository has this
one-line uncommitted patch; no other Hermes source file was changed.

Hermes also prints `Unknown toolsets: mcp-signaldesk` before dynamic discovery;
the real run subsequently registers and successfully calls that server's tools.
This warning did not prevent the exchange and is retained in private stdout.

## Scope and reproduction

Follow the README's `npm run live:setup` / `npm run live` instructions. Stop any
other app occupying port 3000 first. The launcher prevents duplicate owners of
its database. A crashed claimed exchange becomes uncertain rather than charging
for another automatic model call; a human must start another exchange.

This uses fresh Codex CLI sessions, not the user's regular ChatGPT chat and not
E1's current desktop session. Human arming is still required. General autonomous
conversation, group orchestration, persistent resumed agent contexts, production
authentication, public hosting, and broader G1/G3 security work remain outstanding.
The greeting-specific MCP adapter connects directly to E1's real core; it is not
the general ReferenceCore or E2's temporary-database test adapter.
