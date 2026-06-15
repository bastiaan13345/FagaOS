import { describe, expect, it } from 'vitest';
import { createControlPlaneServer, createSampleCard } from '../src/bootstrap.js';

describe('control-plane server bootstrap', () => {
  it('builds a sample card with the configured MCP URL', () => {
    const card = createSampleCard({ host: '0.0.0.0', port: 9999 });
    expect(card.id).toBe('agent.sample.echo');
    expect(card.mcpEndpoints?.[0]?.url).toBe('http://0.0.0.0:9999/mcp/echo');
  });

  it('registers the boot-time sample card and exposes the HTTP server', async () => {
    const boot = createControlPlaneServer({ host: '127.0.0.1', port: 0 });
    const registered = await boot.cards.get('agent.sample.echo');
    expect(registered?.name).toBe('Sample Echo Agent');

    const { port, close } = await boot.server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'agent.sample.echo',
          createdBy: { id: 'system:test', type: 'system' },
          input: {},
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      close();
    }
  });
});
