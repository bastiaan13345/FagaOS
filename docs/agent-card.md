# FagaOS AgentCard

> Runtime contract for declaring an agent in FagaOS. Source of truth: [`packages/agent-manifest/src/index.ts`](../packages/agent-manifest/src/index.ts). Machine-readable: [`../packages/agent-manifest/src/agent-card.schema.json`](../packages/agent-manifest/src/agent-card.schema.json) (also emitted to `dist/` after `npm run build:schema`).

## Purpose

An **AgentCard** (a.k.a. AgentManifest) is the unit of declaration for an agent in FagaOS. The control plane registers cards, sessions bind to them, the policy engine reads them to mint capability tokens, and the orchestrator uses them to dispatch work.

A card must answer six questions before a session can be created:

1. **Who** is this agent? (`id`, `name`, `version`, `owner`)
2. **What** is it allowed to do? (`capabilities`)
3. **Where** do its MCP endpoints live? (`mcpEndpoints`)
4. **What** must the control plane authenticate? (`auth`)
5. **What** concrete tool servers back its MCP endpoints? (`toolServers`)
6. **Who** is on the hook if it does something wrong? (`owner`)

The card was originally specified in FAG-9 and is now part of the unified FAG-10 runtime contract layer.

## Stability

The Phase 0 shape is versioned by `$schema` (`https://fagaos.dev/schemas/agent-card/v1.json`). Additive changes bump the **card's** `version` field. Breaking changes require a major `$schema` version and an ADR.

## Example

```json
{
  "$schema": "https://fagaos.dev/schemas/agent-card/v1.json",
  "id": "agent.inbox.triage",
  "name": "Inbox Triage Agent",
  "version": "0.1.0",
  "owner": { "id": "team:productivity", "email": "productivity@example.com" },
  "auth": {
    "kind": "oauth2",
    "flow": "client_credentials",
    "secretRef": "vault:inbox-triage-creds",
    "tokenEndpoint": "https://auth.fagaos.local/oauth2/token",
    "scopes": ["inbox.read", "inbox.draft"]
  },
  "capabilities": [
    { "name": "email.read" },
    { "name": "email.draft" },
    { "name": "calendar.read" }
  ],
  "mcpEndpoints": [
    { "id": "mcp.in",  "name": "Inbound",  "role": "server", "transport": "http+sse", "url": "https://mcp.fagaos.local/triage/in" },
    { "id": "mcp.out", "name": "Outbound", "role": "client", "transport": "streamable-http", "url": "https://mcp.fagaos.local/triage/out" }
  ],
  "toolServers": [
    {
      "id": "gmail",
      "implementation": "@fagaos/tool-server-gmail",
      "category": "email",
      "endpoints": ["mcp.in"]
    },
    {
      "id": "gcal",
      "implementation": "@fagaos/tool-server-gcal",
      "category": "calendar",
      "endpoints": ["mcp.in"]
    }
  ]
}
```

## Field reference

| Field            | Type                | Required | Notes                                                             |
| ---------------- | ------------------- | -------- | ----------------------------------------------------------------- |
| `$schema`        | string (literal)    | no       | Defaults to `https://fagaos.dev/schemas/agent-card/v1.json`.      |
| `id`             | string (url-safe)   | yes      | Globally unique. `^[a-zA-Z0-9._:\-]+$`                            |
| `name`           | string              | yes      | Display name.                                                     |
| `description`    | string              | no       | Up to 1024 chars.                                                 |
| `version`        | semver              | yes      | Card format version, not the agent's runtime version.             |
| `owner`          | object              | yes      | `{ id, name?, email? }` — accountability anchor.                  |
| `capabilities`   | Capability[]        | no       | Default `[]`. Lower-camelCase, dot-namespaced verbs.              |
| `auth`           | Auth (discriminated)| yes      | `none` / `bearer` / `oauth2` / `mtls`.                            |
| `mcpEndpoints`   | McpEndpoint[]       | no       | Default `[]`. `stdio` / `http+sse` / `streamable-http`.           |
| `toolServers`    | ToolServerRef[]     | no       | Default `[]`. **Plugs FAG-4 (desktop/browser) and FAG-5 (integrations).** |
| `metadata`       | object              | no       | Annotations only; never control-plane-relevant.                   |
| `createdAt`      | RFC3339             | no       | Defaults to now.                                                  |

### `Capability`

```ts
{ name: string;          // e.g. "fs.read", "email.send"
  scope?: string;        // e.g. "/tmp", "mailbox:foo@bar"
  constraints?: Record<string, string|number|boolean> }
```

### `AuthRequirement` (discriminated on `kind`)

- `none`
- `bearer`: `{ secretRef, audience? }`
- `oauth2`: `{ flow: "authorization_code"|"client_credentials", secretRef, authorizationEndpoint?, tokenEndpoint?, scopes? }`
- `mtls`: `{ certRef, keyRef }`

`secretRef` and `certRef` are **references**, never values. The secret vault (Phase 1) resolves them. The card is safe to publish.

### `McpEndpoint`

```ts
{ id, name,
  role: "server" | "client",
  transport: "stdio" | "http+sse" | "streamable-http",
  url?, command?, args?, env? }
```

### `ToolServerRef`

```ts
{ id, implementation,         // module path or container image
  category: "desktop"|"browser"|"email"|"messaging"|"calendar"|"filesystem"|"shell"|"code-exec"|"other",
  endpoints: string[]        // McpEndpoint ids this server backs
}
```

`category` is routing metadata for the control plane. When FAG-4 lands, the `desktop` and `browser` categories will resolve to the desktop/browser tool servers. When FAG-5 lands, the `email`, `messaging`, and `calendar` categories resolve to the integration servers.

## What it is *not*

- **Not** a runtime instruction set. The agent's prompt / tools / state live elsewhere.
- **Not** a policy. Capabilities are *declared* here; the policy engine *enforces* them in Phase 1.
- **Not** a transport. The card is JSON; it can be fetched over HTTP, embedded in a CLI, or read from disk.
