/**
 * @fagaos/agent-manifest — typed AgentManifest / AgentCard runtime contract.
 *
 * An AgentCard is the unit of declaration for an agent in FagaOS. The
 * control plane registers cards, sessions bind to them, the policy
 * engine reads them to mint capability tokens, and the orchestrator
 * uses them to dispatch work.
 *
 * Design goals (from FAG-3 + FAG-6):
 *  - Mirror the de-facto Agent Card shape (A2A / Google Agent Card)
 *    so a future A2A export is a 1-file adapter, not a rewrite.
 *  - Be the single source of truth for what a session needs to know
 *    about its agent at start time.
 *  - Be stable across Phase 0 / Phase 1 — schema bumps are versioned.
 *  - Be validatable without code execution (Zod → JSON Schema).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/* --------------------------- Primitive atoms ----------------------------- */

const IdSchema = z.string().min(1).max(128)  .regex(/^[a-zA-Z0-9._:-]+$/, {
  message: 'id must be url-safe (letters, digits, dot, underscore, colon, dash)',
});

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/, {
    message: 'version must be a valid semver',
  });

const UriSchema = z.string().url();

/* ------------------------- Capability declaration ------------------------ */

/**
 * A capability is a named, optionally-constrained permission an agent
 * holds. Used by the policy engine to mint capability tokens (Phase 1).
 *
 * For Phase 0 the value is declarative only — the control-plane API
 * does not yet check capabilities. The shape is stable so the policy
 * engine can be added without breaking agents.
 */
export const CapabilitySchema = z.object({
  /** Dotted lowerCamelCase verb (e.g. "fs.read", "email.send"). */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$/),
  /** Optional resource scope (e.g. fs path, mailbox, calendar id). */
  scope: z.string().optional(),
  /** Optional numeric / string constraints. */
  constraints: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/* --------------------------- MCP endpoint shape -------------------------- */

/**
 * The MCP endpoint an agent exposes (for inbound requests) or consumes
 * (for outbound tool calls). v1 supports `stdio` and `http+sse` per
 * the MCP spec; further transports land in Phase 1.
 */
export const McpEndpointSchema = z.object({
  /** Stable id within the card. */
  id: IdSchema,
  /** Human-readable name. */
  name: z.string().min(1).max(128),
  /** Endpoint role. */
  role: z.enum(['server', 'client']),
  transport: z.enum(['stdio', 'http+sse', 'streamable-http']),
  /** Connection URL or stdio command. Required for http transports. */
  url: UriSchema.optional(),
  /** Required for stdio transport. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  /** Optional env var names (values never declared in the card). */
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional(),
});
export type McpEndpoint = z.infer<typeof McpEndpointSchema>;

/* ----------------------------- Auth shape -------------------------------- */

/**
 * Auth requirements an agent declares for the control plane to satisfy
 * before granting a session. The control plane does not store secrets;
 * it references a secret id resolved by the secret vault (Phase 1).
 */
export const AuthRequirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
  }),
  z.object({
    kind: z.literal('bearer'),
    /** Reference to a secret in the secret vault (not the secret itself). */
    secretRef: z.string().min(1),
    /** Optional token audience. */
    audience: z.string().optional(),
  }),
  z.object({
    kind: z.literal('oauth2'),
    flow: z.enum(['authorization_code', 'client_credentials']),
    /** Reference to the OAuth client id in the secret vault. */
    secretRef: z.string().min(1),
    /** Required for authorization_code flow. */
    authorizationEndpoint: UriSchema.optional(),
    tokenEndpoint: UriSchema.optional(),
    scopes: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('mtls'),
    /** Reference to client cert + key in the secret vault. */
    certRef: z.string().min(1),
    keyRef: z.string().min(1),
  }),
]);
export type AuthRequirement = z.infer<typeof AuthRequirementSchema>;

/* ----------------------------- Owner shape -------------------------------- */

export const OwnerSchema = z.object({
  /** Owner id (e.g. user uuid, team slug, "system"). */
  id: z.string().min(1),
  /** Display name. */
  name: z.string().min(1).max(128).optional(),
  /** Contact email. */
  email: z.string().email().optional(),
});
export type Owner = z.infer<typeof OwnerSchema>;

/* ----------------------------- Tool server shape -------------------------- */

/**
 * A tool server is the concrete implementation behind one or more MCP
 * endpoints. For Phase 0 these are placeholders: the agent-manifest
 * package declares the *contract* but does not wire implementations.
 *
 * The `category` field is the routing key the control plane uses to
 * dispatch tool calls to the right tool server. Phase 1 fills in real
 * implementations:
 *   - TODO(FAG-4): desktop and browser tool servers
 *     (Firecracker microVM + Playwright+MCP).
 *   - TODO(FAG-5): email / messaging / calendar / filesystem / shell /
 *     code-exec integrations (Nylas / Nango / similar).
 *
 * Each ToolServer entry here is where those land; the `category` enum
 * values mirror the FAG-4 / FAG-5 product split.
 */
export const ToolServerRefSchema = z.object({
  id: IdSchema,
  /** Module path or container image reference. */
  implementation: z.string().min(1),
  /**
   * Categorization — used by the control plane to route tool calls.
   * TODO(FAG-4): the `desktop` and `browser` categories are filled in
   *   by the FAG-4 desktop/browser tool servers.
   * TODO(FAG-5): the `email` / `messaging` / `calendar` / `filesystem`
   *   / `shell` / `code-exec` categories are filled in by the FAG-5
   *   integration tool servers.
   */
  category: z.enum([
    'desktop',
    'browser',
    'email',
    'messaging',
    'calendar',
    'filesystem',
    'shell',
    'code-exec',
    'other',
  ]),
  /** MCP endpoint ids this server backs. */
  endpoints: z.array(IdSchema).min(1),
  /** Optional human-readable description. */
  description: z.string().max(1024).optional(),
});
export type ToolServerRef = z.infer<typeof ToolServerRefSchema>;

/* -------------------------- The AgentCard itself -------------------------- */

/**
 * AgentManifest (a.k.a. AgentCard) — the runtime contract for an agent.
 *
 * Stability:
 *  - The shape is the Phase 0 contract. Additive changes bump minor.
 *  - Breaking changes require a major version bump and an ADR.
 */
export const AgentCardSchema = z.object({
  $schema: z
    .literal('https://fagaos.dev/schemas/agent-card/v1.json')
    .default('https://fagaos.dev/schemas/agent-card/v1.json'),

  /** Globally-unique, url-safe agent id. */
  id: IdSchema,
  /** Display name. */
  name: z.string().min(1).max(128),
  /** Short description for human operators. */
  description: z.string().max(1024).optional(),

  /** Card format version — semver. Bump on schema changes. */
  version: SemverSchema,

  /** Owner of the card (who is accountable for this agent). */
  owner: OwnerSchema,

  /** What the agent is allowed to do. */
  capabilities: z.array(CapabilitySchema).default([]),

  /** Auth requirements the control plane must satisfy. */
  auth: AuthRequirementSchema,

  /** MCP endpoints the agent exposes or consumes. */
  mcpEndpoints: z.array(McpEndpointSchema).default([]),

  /**
   * Tool server references. FAG-4 and FAG-5 plug in here.
   *
   * Phase 0: empty by default. Concrete tool servers land in Phase 1
   * (FAG-4 desktop/browser, FAG-5 integrations) and Phase 2.
   * The control-plane's stub tool gateway returns a deterministic
   * no-op for any tool invocation in the meantime.
   */
  toolServers: z.array(ToolServerRefSchema).default([]),

  /** Optional metadata — pure annotations, never control-plane-relevant. */
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),

  /** ISO 8601 creation time. */
  createdAt: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

/* ------------------------------ Helpers ---------------------------------- */

/** Parse and validate an unknown input as an AgentCard. Throws on failure. */
export function parseAgentCard(input: unknown): AgentCard {
  return AgentCardSchema.parse(input);
}

/** Safe variant — returns a ZodError-style result. */
export function safeParseAgentCard(input: unknown) {
  return AgentCardSchema.safeParse(input);
}

/** Stable hash of a card's identity-relevant fields. */
export function cardIdentityHash(card: AgentCard): string {
  const payload = {
    id: card.id,
    version: card.version,
    capabilities: card.capabilities,
    mcpEndpoints: card.mcpEndpoints.map((e) => ({
      id: e.id,
      role: e.role,
      transport: e.transport,
    })),
  };
  // Stable key ordering is essential for a hash that survives formatters.
  const keys = Object.keys(payload).sort();
  const canonical = keys
    .map((k) => JSON.stringify(k) + ':' + JSON.stringify((payload as Record<string, unknown>)[k]))
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
