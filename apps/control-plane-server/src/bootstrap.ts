import { ControlPlane, createInMemoryCardRegistry } from '@fagaos/control-plane';
import { createHttpServer } from '@fagaos/control-plane/http';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

export interface ControlPlaneServerConfig {
  port: number;
  host: string;
}

export function createSampleCard(config: ControlPlaneServerConfig): AgentCardInput {
  return {
    id: 'agent.sample.echo',
    name: 'Sample Echo Agent',
    description: 'Boot-time seed. Replace via POST /cards or by loading from the registry service in Phase 1.',
    version: '0.1.0',
    owner: { id: 'team:platform', name: 'Platform Team' },
    auth: { kind: 'none' },
    capabilities: [
      { name: 'echo' },
      // TODO(FAG-5): replace the empty `toolServers` block below with
      //   real email/messaging/calendar tool server references once
      //   the integration design lands.
    ],
    toolServers: [
      // TODO(FAG-4): wire the desktop/browser tool server.
      // TODO(FAG-5): wire the email/messaging/calendar tool servers.
    ],
    mcpEndpoints: [
      {
        id: 'mcp.in',
        name: 'Inbound MCP',
        role: 'server',
        transport: 'http+sse',
        url: `http://${config.host}:${config.port}/mcp/echo`,
      },
    ],
  };
}

export function createControlPlaneServer(config: ControlPlaneServerConfig) {
  const audit = createInMemoryAuditLog();
  const cards = createInMemoryCardRegistry();
  const sampleCard = createSampleCard(config);
  const parsedSampleCard = AgentCardSchema.parse(sampleCard);
  cards.register(parsedSampleCard);

  const controlPlane = new ControlPlane({ audit, cards });
  const server = createHttpServer({ controlPlane, exposeCardRegistration: true });

  return {
    audit,
    cards,
    controlPlane,
    sampleCard,
    server,
  };
}
