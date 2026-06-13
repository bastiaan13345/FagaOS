import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentCardSchema,
  cardIdentityHash,
  parseAgentCard,
  safeParseAgentCard,
} from '../src/index.js';

const minimalValidCard = {
  id: 'agent.test.echo',
  name: 'Echo Agent',
  version: '0.1.0',
  owner: { id: 'team:platform' },
  auth: { kind: 'none' },
};

describe('@fagaos/agent-manifest — AgentCard schema', () => {
  it('accepts a minimal valid card', () => {
    const parsed = parseAgentCard(minimalValidCard);
    expect(parsed.id).toBe('agent.test.echo');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.mcpEndpoints).toEqual([]);
    expect(parsed.toolServers).toEqual([]);
    expect(parsed.createdAt).toMatch(/T/);
  });

  it('rejects invalid ids', () => {
    const bad = { ...minimalValidCard, id: 'agent with spaces!' };
    const result = safeParseAgentCard(bad);
    expect(result.success).toBe(false);
  });

  it('rejects non-semver versions', () => {
    const bad = { ...minimalValidCard, version: 'v1' };
    const result = safeParseAgentCard(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown auth kinds', () => {
    const bad = { ...minimalValidCard, auth: { kind: 'magic-token' } };
    const result = safeParseAgentCard(bad);
    expect(result.success).toBe(false);
  });

  it('enforces capability.name shape', () => {
    const bad = {
      ...minimalValidCard,
      capabilities: [{ name: 'Read.FS' }],
    };
    const result = safeParseAgentCard(bad);
    expect(result.success).toBe(false);
  });

  it('accepts a fully-populated card', () => {
    const full = {
      ...minimalValidCard,
      description: 'Echoes back whatever you send it.',
      capabilities: [
        { name: 'fs.read', scope: '/tmp' },
        { name: 'email.send' },
      ],
      auth: {
        kind: 'bearer',
        secretRef: 'vault:echo-bearer',
        audience: 'https://api.fagaos.local',
      },
      mcpEndpoints: [
        {
          id: 'mcp.in',
          name: 'Inbound MCP',
          role: 'server',
          transport: 'http+sse',
          url: 'https://mcp.fagaos.local/echo',
        },
      ],
      toolServers: [
        {
          id: 'fs-server',
          implementation: '@fagaos/tool-server-fs',
          category: 'filesystem',
          endpoints: ['mcp.in'],
        },
      ],
      metadata: { build: 42 },
    };
    const parsed = parseAgentCard(full);
    expect(parsed.capabilities).toHaveLength(2);
    expect(parsed.mcpEndpoints).toHaveLength(1);
    expect(parsed.toolServers).toHaveLength(1);
    expect(parsed.auth.kind).toBe('bearer');
  });

  it('cardIdentityHash is stable for the same identity-relevant fields', () => {
    const a = parseAgentCard({
      ...minimalValidCard,
      description: 'ignored by identity hash',
    });
    const b = parseAgentCard({
      ...minimalValidCard,
      description: 'different description',
      metadata: { whatever: true },
    });
    expect(cardIdentityHash(a)).toBe(cardIdentityHash(b));
  });

  it('cardIdentityHash changes when capabilities change', () => {
    const a = parseAgentCard({
      ...minimalValidCard,
      capabilities: [{ name: 'fs.read' }],
    });
    const b = parseAgentCard({
      ...minimalValidCard,
      capabilities: [{ name: 'fs.write' }],
    });
    expect(cardIdentityHash(a)).not.toBe(cardIdentityHash(b));
  });

  it('cardIdentityHash changes when version changes', () => {
    const a = parseAgentCard({ ...minimalValidCard, version: '0.1.0' });
    const b = parseAgentCard({ ...minimalValidCard, version: '0.2.0' });
    expect(cardIdentityHash(a)).not.toBe(cardIdentityHash(b));
  });

  it('exports the schema object', () => {
    expect(AgentCardSchema.safeParse(minimalValidCard).success).toBe(true);
  });

  it('emits a loadable JSON Schema artifact (dist/agent-card.schema.json)', () => {
    // The schema artifact is built by `npm run build:schema` (or the package's
    // `build:schema` script). Vitest runs after `npm run build` at the package
    // level, which produces dist/. Fall back to the src/ copy in dev when only
    // the build:schema script has been run.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(__dirname, '../dist/agent-card.schema.json'),
      resolve(__dirname, '../src/agent-card.schema.json'),
    ];
    const path = candidates.find((p) => {
      try {
        readFileSync(p, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    expect(path, 'agent-card.schema.json must exist (run `npm run build:schema`)').toBeDefined();
    if (!path) return;
    const schema = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(schema['$id']).toBe('https://fagaos.dev/schemas/agent-card/v1.json');
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['id']).toBeDefined();
    expect(props['capabilities']).toBeDefined();
    expect(props['auth']).toBeDefined();
    const required = schema['required'] as string[];
    expect(required).toContain('id');
    expect(required).toContain('name');
    expect(required).toContain('version');
    expect(required).toContain('owner');
    expect(required).toContain('auth');
  });
});
