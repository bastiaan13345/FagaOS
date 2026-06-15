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
import { auditLogContractVersion } from '@fagaos/audit-log';
import { createControlPlaneServer } from './bootstrap.js';

const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '127.0.0.1';

const { sampleCard, server } = createControlPlaneServer({ port: PORT, host: HOST });

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
