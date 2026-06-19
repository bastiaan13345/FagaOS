import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlPlane,
  JsonFileControlPlaneRepository,
  loadControlPlaneRepositoryState,
  createInMemoryCardRegistry,
  type ControlPlaneTask,
} from '../src/index.js';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

function card(): AgentCardInput {
  return {
    id: 'agent.test.scheduler',
    name: 'Scheduler Agent',
    version: '0.1.0',
    owner: { id: 'team:platform' },
    auth: { kind: 'none' },
    capabilities: [{ name: 'echo' }],
  };
}

function createClock(start = '2026-06-15T12:00:00.000Z') {
  let now = new Date(start).getTime();
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function createControlPlane(filePath: string, clock: () => Date) {
  const audit = createInMemoryAuditLog();
  const cards = createInMemoryCardRegistry();
  cards.register(card());
  const repository = new JsonFileControlPlaneRepository({ filePath });
  return {
    audit,
    controlPlane: new ControlPlane({ audit, cards, repository, clock }),
  };
}

describe('@fagaos/control-plane — durable scheduler lifecycle', () => {
  let dir: string;
  let filePath: string;
  const emptyRepositoryState = {
    version: 1 as const,
    sessions: [],
    tasks: [],
    toolInvocations: [],
    approvals: [],
    notificationPreferences: [],
    notifications: [],
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fagaos-control-plane-'));
    filePath = join(dir, 'control-plane-state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists sessions, queued tasks, capability outcomes, and tool invocation records across restart', async () => {
    const { clock } = createClock();
    const first = createControlPlane(filePath, clock);
    const session = await first.controlPlane.createSession({
      agentId: 'agent.test.scheduler',
      createdBy: { id: 'user:alice', type: 'user' },
      input: { prompt: 'persist me' },
    });
    const task = await first.controlPlane.enqueueTask({
      sessionId: session.id,
      tool: 'echo',
      arguments: { text: 'hello' },
      createdBy: { id: 'user:alice', type: 'user' },
      auditCorrelationId: 'corr-persist',
      capabilityCheck: { ok: true, policyId: 'policy.echo' },
    });
    await first.controlPlane.invokeTool(session.id, { arguments: { text: 'tool' } }, 'echo');

    const second = createControlPlane(filePath, clock);

    expect(second.controlPlane.getSession(session.id)).toMatchObject({
      id: session.id,
      state: 'running',
      input: { prompt: 'persist me' },
    });
    expect(second.controlPlane.listTasks()).toEqual([
      expect.objectContaining({
        id: task.id,
        state: 'queued',
        auditCorrelationId: 'corr-persist',
        capabilityCheck: { ok: true, policyId: 'policy.echo' },
      }),
    ]);
    expect(second.controlPlane.listToolInvocations()).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        tool: 'echo',
        ok: true,
        correlationId: expect.any(String),
      }),
    ]);
  });

  it('prevents concurrent claims and extends the lease on heartbeat', async () => {
    const time = createClock();
    const { controlPlane } = createControlPlane(filePath, time.clock);
    const task = await enqueueRunnableTask(controlPlane);

    const firstClaim = await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });
    const secondClaim = await controlPlane.claimTask({ workerId: 'worker-2', leaseMs: 1_000 });

    expect(firstClaim?.task).toMatchObject({
      id: task.id,
      state: 'claimed',
      claimedBy: 'worker-1',
      attempt: 1,
    });
    expect(secondClaim).toBeNull();

    time.advance(500);
    const heartbeat = await controlPlane.heartbeatTask(task.id, {
      workerId: 'worker-1',
      leaseMs: 2_000,
    });

    expect(heartbeat.leaseExpiresAt).toBe('2026-06-15T12:00:02.500Z');
  });

  it('recovers expired leases so another worker can claim the task', async () => {
    const time = createClock();
    const { controlPlane } = createControlPlane(filePath, time.clock);
    const task = await enqueueRunnableTask(controlPlane);
    await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });

    time.advance(1_001);
    const recovered = await controlPlane.recoverStuckTasks();
    const secondClaim = await controlPlane.claimTask({ workerId: 'worker-2', leaseMs: 1_000 });

    expect(recovered.map((t) => t.id)).toEqual([task.id]);
    expect(secondClaim?.task).toMatchObject({
      id: task.id,
      state: 'claimed',
      claimedBy: 'worker-2',
      attempt: 2,
    });
  });

  it('cancels queued tasks and prevents later claims', async () => {
    const { controlPlane } = createControlPlane(filePath, createClock().clock);
    const task = await enqueueRunnableTask(controlPlane);

    const cancelled = await controlPlane.cancelTask(task.id, {
      reason: 'operator request',
      actor: { id: 'user:alice', type: 'user' },
    });
    const claim = await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });

    expect(cancelled).toMatchObject({
      id: task.id,
      state: 'cancelled',
      terminalReason: 'operator request',
    });
    expect(claim).toBeNull();
  });

  it('retries failed tasks until max attempts and then marks them failed', async () => {
    const { controlPlane } = createControlPlane(filePath, createClock().clock);
    const task = await enqueueRunnableTask(controlPlane, { maxAttempts: 2 });

    const firstClaim = await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });
    expect(firstClaim?.task.attempt).toBe(1);
    const retry = await controlPlane.failTask(task.id, {
      workerId: 'worker-1',
      error: 'temporary failure',
      retryDelayMs: 0,
    });
    const secondClaim = await controlPlane.claimTask({ workerId: 'worker-2', leaseMs: 1_000 });
    expect(secondClaim?.task.attempt).toBe(2);
    const failed = await controlPlane.failTask(task.id, {
      workerId: 'worker-2',
      error: 'permanent failure',
      retryDelayMs: 0,
    });

    expect(retry.state).toBe('queued');
    expect(failed).toMatchObject({
      id: task.id,
      state: 'failed',
      terminalReason: 'permanent failure',
      attempt: 2,
    });
  });

  it('records audit correlation IDs for enqueue, claim, and completion', async () => {
    const { audit, controlPlane } = createControlPlane(filePath, createClock().clock);
    const task = await enqueueRunnableTask(controlPlane, { auditCorrelationId: 'corr-audit' });
    await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });
    await controlPlane.completeTask(task.id, {
      workerId: 'worker-1',
      result: { ok: true },
    });

    const entries = await audit.read();
    const correlated = entries.filter((e) => e.data['auditCorrelationId'] === 'corr-audit');

    expect(correlated.map((e) => e.action)).toEqual([
      'task.enqueue',
      'task.claim',
      'task.complete',
    ]);
    expect(correlated.every((e) => e.resource.id === task.id)).toBe(true);
  });

  it('returns empty state for missing or empty state files and rejects malformed state', async () => {
    const missing = await loadControlPlaneRepositoryState(join(dir, 'missing.json'));
    expect(missing).toEqual(emptyRepositoryState);

    const emptyPath = join(dir, 'empty.json');
    await writeFile(emptyPath, '', 'utf8');
    const empty = await loadControlPlaneRepositoryState(emptyPath);
    expect(empty).toEqual(emptyRepositoryState);
    const emptyRepository = new JsonFileControlPlaneRepository({ filePath: emptyPath });
    expect(emptyRepository.listSessions()).toEqual([]);

    const malformedPath = join(dir, 'malformed.json');
    await writeFile(malformedPath, '{bad-json', 'utf8');
    await expect(loadControlPlaneRepositoryState(malformedPath)).rejects.toThrow();
    expect(() => new JsonFileControlPlaneRepository({ filePath: malformedPath })).toThrow();
  });

  it('upserts and defensively copies durable notification preferences', async () => {
    const { controlPlane } = createControlPlane(filePath, createClock().clock);

    await controlPlane.setNotificationPreference({
      topic: 'approvals',
      severity: 'warning',
      channels: ['local_dev'],
      enabled: true,
    });
    await controlPlane.setNotificationPreference({
      topic: 'approvals',
      severity: 'warning',
      channels: ['local_dev'],
      enabled: false,
    });

    const preferences = controlPlane.listNotificationPreferences();
    preferences[0]!.channels.push('local_dev');

    expect(controlPlane.listNotificationPreferences()).toEqual([
      {
        topic: 'approvals',
        severity: 'warning',
        channels: ['local_dev'],
        enabled: false,
      },
    ]);

    const restarted = createControlPlane(filePath, createClock().clock);
    expect(restarted.controlPlane.listNotificationPreferences()).toEqual([
      {
        topic: 'approvals',
        severity: 'warning',
        channels: ['local_dev'],
        enabled: false,
      },
    ]);
  });

  it('defensively copies repository records and reports misses without mutating stored state', async () => {
    const { controlPlane } = createControlPlane(filePath, createClock().clock);
    const session = await controlPlane.createSession({
      agentId: 'agent.test.scheduler',
      createdBy: { id: 'user:alice', type: 'user' },
      input: { prompt: 'copy me' },
    });
    const task = await controlPlane.enqueueTask({
      sessionId: session.id,
      tool: 'echo',
      arguments: { value: 1 },
      createdBy: { id: 'user:alice', type: 'user' },
      auditCorrelationId: 'corr-copy',
      capabilityCheck: { ok: true },
    });

    const sessions = controlPlane.listSessions();
    sessions[0]!.input['prompt'] = 'mutated';
    const tasks = controlPlane.listTasks();
    tasks[0]!.arguments['value'] = 2;

    expect(controlPlane.getSession(session.id).input).toEqual({ prompt: 'copy me' });
    expect(controlPlane.getTask(task.id).arguments).toEqual({ value: 1 });
    try {
      controlPlane.getTask('missing-task');
      throw new Error('expected getTask to throw');
    } catch (e) {
      expect(e).toMatchObject({ code: 'task_not_found' });
    }
  });
});

async function enqueueRunnableTask(
  controlPlane: ControlPlane,
  opts: { maxAttempts?: number; auditCorrelationId?: string } = {},
): Promise<ControlPlaneTask> {
  const session = await controlPlane.createSession({
    agentId: 'agent.test.scheduler',
    createdBy: { id: 'user:alice', type: 'user' },
    input: {},
  });
  return controlPlane.enqueueTask({
    sessionId: session.id,
    tool: 'echo',
    arguments: {},
    createdBy: { id: 'user:alice', type: 'user' },
    auditCorrelationId: opts.auditCorrelationId ?? 'corr-task',
    maxAttempts: opts.maxAttempts,
    capabilityCheck: { ok: true },
  });
}
