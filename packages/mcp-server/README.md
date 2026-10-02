# @signaldesk/mcp-server

SignalDesk Channel MCP server (WP-E2-01), A2A mapping (WP-E2-02), and the security gate test suite (WP-E2-03).

```bash
npm install
```

```bash
npm test
```

```bash
npm run hub
```

`npm test` runs the tool tests, the adversarial suite and the transport tests (`npm run typecheck` for types). `npm run hub` starts the local dev hub on 127.0.0.1:8787 and writes keys to `.signaldesk-dev/keys.json`.

- Tools and client setup: [`docs/protocol/MCP-TOOLS.md`](../../docs/protocol/MCP-TOOLS.md)
- Core interface (proposed freeze): [`docs/protocol/CORE-API.md`](../../docs/protocol/CORE-API.md)
- A2A mapping: [`docs/protocol/A2A.md`](../../docs/protocol/A2A.md)
- Security model and sign-off: [`SECURITY.md`](../../SECURITY.md)

| Path | What |
|---|---|
| `src/core/api.ts`, `types.ts` | The `CoreApi` / `AdminApi` contract |
| `src/core/reference-core.ts` | In-memory reference core (test double, **not production**) |
| `src/core/remote.ts` | `CoreApi` over HTTP (used by stdio) |
| `src/server.ts` | MCP tools |
| `src/http.ts` | Streamable HTTP transport + dev endpoints |
| `src/bin/stdio.ts`, `src/bin/dev-hub.ts` | Entrypoints |
| `src/security/*` | Keys, limits, untrusted-content envelope, rate limiting |
| `src/a2a/*` | Agent Card validation, state mapping |
