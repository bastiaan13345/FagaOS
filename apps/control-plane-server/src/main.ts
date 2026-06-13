#!/usr/bin/env node
/**
 * FagaOS control-plane server entry point.
 *
 * Phase 0 boots the in-memory control plane, the FAG-8 audit log
 * primitive (surfaced through @fagaos/audit-log's compat layer), and
 * the in-memory card registry on a single TCP port.
 *
 * Phase 1 will swap:
 *   - the in-memory audit log for the file-backed / persistent
 *     store (FAG-8),
 *   - the stub tool gateway for real desktop/browser (FAG-4) and
 *     email/messaging/calendar (FAG-5) tool server dispatchers.
 */
import { ControlPlane, createInMemoryCardRegistry } from '@fagaos/control-plane';
import { createHttpServer } from '@fagaos/control-plane/http';
import { createInMemoryAuditLog, auditLogContractVersion } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '127.0.0.1';

const audit = createInMemoryAuditLog();
const cards = createInMemoryCardRegistry();

// Seed a sample card so the server is useful out of the box.
const sampleCard: AgentCardInput = {
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
      url: `http://${HOST}:${PORT}/mcp/echo`,
    },
  ],
};
const parsedSampleCard = AgentCardSchema.parse(sampleCard);
cards.register(parsedSampleCard);

const controlPlane = new ControlPlane({ audit, cards });
const server = createHttpServer({ controlPlane, exposeCardRegistration: true });

server.listen(PORT, HOST).then(({ port, close }) => {
  // eslint-disable-next-line no-console
  console.log(
    `[fagaos-control-plane] listening on http://${HOST}:${port}\n` +
      `  - sample card: ${sampleCard.id} v${sampleCard.version}\n` +
      `  - audit log: ${auditLogContractVersion}\n` +
      `  - OpenAPI:  docs/api/control-plane.openapi.yaml`,
  );
  // Stash the close handle for graceful shutdown in Phase 1.
  void close;
});
