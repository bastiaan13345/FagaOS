import { describe, expect, it } from 'vitest';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';
import {
  ControlPlane,
  createInMemoryCardRegistry,
  type ControlPlaneTask,
} from '../src/index.js';

type AgentCardInput = z.input<typeof AgentCardSchema>;

function card(): AgentCardInput {
  return {
    id: 'agent.test.approvals',
    name: 'Approval Agent',
    version: '0.1.0',
    owner: { id: 'team:platform' },
    auth: { kind: 'none' },
    capabilities: [{ name: 'gmail.send' }],
  };
}

function createClock(start = '2026-06-19T12:00:00.000Z') {
  let now = new Date(start).getTime();
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function createControlPlane(clock: () => Date) {
  const audit = createInMemoryAuditLog();
  const cards = createInMemoryCardRegistry();
  cards.register(card());
  return {
    audit,
    controlPlane: new ControlPlane({ audit, cards, clock }),
  };
}

async function createSession(controlPlane: ControlPlane) {
  return controlPlane.createSession({
    agentId: 'agent.test.approvals',
    createdBy: { id: 'user:alice', type: 'user' },
    input: {},
  });
}

async function enqueueTask(
  controlPlane: ControlPlane,
  sessionId: string,
  opts: { capabilityOk?: boolean; maxAttempts?: number } = {},
): Promise<ControlPlaneTask> {
  return controlPlane.enqueueTask({
    sessionId,
    tool: 'gmail.send',
    arguments: { to: 'customer@example.com', body: 'draft' },
    createdBy: { id: 'agent.test.approvals', type: 'agent' },
    auditCorrelationId: 'corr-approval-flow',
    capabilityCheck: opts.capabilityOk === false
      ? { ok: false, policyId: 'policy.gmail.send', reason: 'requires human approval' }
      : { ok: true, policyId: 'policy.gmail.send' },
    maxAttempts: opts.maxAttempts,
  });
}

function approvalInput(sessionId: string, taskId: string) {
  return {
    sessionId,
    taskId,
    requestedBy: { id: 'agent.test.approvals', type: 'agent' as const },
    riskReason: 'External email send may disclose user data',
    proposedAction: 'Send customer follow-up email',
    sourceEvidence: [
      { kind: 'message', id: 'msg-1', summary: 'Customer asked for pricing details' },
    ],
    affectedResource: { kind: 'email.thread', id: 'thread-123' },
    timeoutAt: '2026-06-19T12:05:00.000Z',
    policyRule: 'policy.gmail.send',
    auditCorrelationId: 'corr-approval-flow',
  };
}

describe('@fagaos/control-plane — approvals, notifications, and escalation', () => {
  it('expires requested approvals and correlates the audit entry to the session, task, tool call, and resource', async () => {
    const time = createClock();
    const { audit, controlPlane } = createControlPlane(time.clock);
    const session = await createSession(controlPlane);
    const task = await enqueueTask(controlPlane, session.id);
    const approval = await controlPlane.requestApproval(approvalInput(session.id, task.id));

    time.advance(5 * 60_000 + 1);
    const expired = await controlPlane.expireApprovals();

    expect(expired).toEqual([
      expect.objectContaining({ id: approval.id, state: 'expired' }),
    ]);
    const entries = await audit.read();
    const expireEntry = entries.find((entry) => entry.action === 'approval.expire');
    expect(expireEntry?.data).toMatchObject({
      auditCorrelationId: 'corr-approval-flow',
      sessionId: session.id,
      taskId: task.id,
      toolCallId: task.id,
      affectedResource: { kind: 'email.thread', id: 'thread-123' },
      severity: 'warning',
    });
  });

  it('supersedes duplicate active approval requests for the same task and policy rule', async () => {
    const { audit, controlPlane } = createControlPlane(createClock().clock);
    const session = await createSession(controlPlane);
    const task = await enqueueTask(controlPlane, session.id);
    const first = await controlPlane.requestApproval(approvalInput(session.id, task.id));
    const second = await controlPlane.requestApproval({
      ...approvalInput(session.id, task.id),
      proposedAction: 'Send revised customer follow-up email',
    });

    expect(controlPlane.getApproval(first.id).state).toBe('superseded');
    expect(second.state).toBe('requested');
    expect(controlPlane.listApprovals().filter((item) => item.state === 'requested')).toHaveLength(1);
    const entries = await audit.read();
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['approval.supersede', 'approval.request']),
    );
  });

  it('records denial and edited approval decisions with actor and audit correlation data', async () => {
    const { audit, controlPlane } = createControlPlane(createClock().clock);
    const session = await createSession(controlPlane);
    const deniedTask = await enqueueTask(controlPlane, session.id);
    const denied = await controlPlane.requestApproval(approvalInput(session.id, deniedTask.id));
    const deniedDecision = await controlPlane.decideApproval(denied.id, {
      actor: { id: 'user:reviewer', type: 'user' },
      decision: 'deny',
      reason: 'Recipient is not verified',
    });

    const editedTask = await enqueueTask(controlPlane, session.id);
    const editable = await controlPlane.requestApproval({
      ...approvalInput(session.id, editedTask.id),
      policyRule: 'policy.gmail.followup',
    });
    const editedDecision = await controlPlane.decideApproval(editable.id, {
      actor: { id: 'user:reviewer', type: 'user' },
      decision: 'edit',
      reason: 'Remove pricing terms',
      editedAction: 'Send customer follow-up email without pricing terms',
    });

    expect(deniedDecision).toMatchObject({
      state: 'denied',
      decision: { actor: { id: 'user:reviewer', type: 'user' }, reason: 'Recipient is not verified' },
    });
    expect(editedDecision).toMatchObject({
      state: 'edited',
      editedAction: 'Send customer follow-up email without pricing terms',
    });
    const entries = await audit.read();
    const denialEntry = entries.find((entry) => entry.action === 'approval.deny');
    const editEntry = entries.find((entry) => entry.action === 'approval.edit');
    expect(denialEntry?.data).toMatchObject({
      approvalId: denied.id,
      auditCorrelationId: 'corr-approval-flow',
      sessionId: session.id,
      taskId: deniedTask.id,
      severity: 'warning',
    });
    expect(editEntry?.data).toMatchObject({
      approvalId: editable.id,
      editedAction: 'Send customer follow-up email without pricing terms',
    });
  });

  it('escalates terminal task failures into an approval request and local-dev notification', async () => {
    const time = createClock();
    const { audit, controlPlane } = createControlPlane(time.clock);
    const session = await createSession(controlPlane);
    const task = await enqueueTask(controlPlane, session.id, { maxAttempts: 1 });
    await controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });
    const failed = await controlPlane.failTask(task.id, {
      workerId: 'worker-1',
      error: 'browser session crashed',
    });

    expect(failed.state).toBe('failed');
    const approvals = controlPlane.listApprovals();
    expect(approvals).toEqual([
      expect.objectContaining({
        state: 'requested',
        escalationReason: 'repeated_tool_failure',
        riskReason: 'Tool "gmail.send" failed after 1 attempts: browser session crashed',
      }),
    ]);
    expect(controlPlane.listNotifications()).toEqual([
      expect.objectContaining({
        channel: 'local_dev',
        severity: 'error',
        topic: 'failures',
        dedupeKey: `escalation:repeated_tool_failure:${task.id}`,
        approvalId: approvals[0]!.id,
      }),
    ]);
    const entries = await audit.read();
    const escalation = entries.find((entry) => entry.action === 'escalation.request');
    expect(escalation?.data).toMatchObject({
      reason: 'repeated_tool_failure',
      sessionId: session.id,
      taskId: task.id,
      approvalId: approvals[0]!.id,
      severity: 'error',
    });
  });

  it('deduplicates local-dev notifications for policy denials', async () => {
    const { controlPlane } = createControlPlane(createClock().clock);
    const session = await createSession(controlPlane);
    const task = await enqueueTask(controlPlane, session.id, { capabilityOk: false });

    const first = await controlPlane.escalatePolicyDenial(task.id);
    const second = await controlPlane.escalatePolicyDenial(task.id);

    expect(first.id).toBe(second.id);
    expect(controlPlane.listNotifications()).toHaveLength(1);
    expect(controlPlane.listNotifications()[0]).toMatchObject({
      topic: 'policy_denials',
      dedupeKey: `escalation:policy_denial:${task.id}`,
      resource: { kind: 'task', id: task.id },
    });
  });
});
