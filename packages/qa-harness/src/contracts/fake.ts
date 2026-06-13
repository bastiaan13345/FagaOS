/**
 * FakeConnectorHarness: offline implementation of `ConnectorHarness`
 * for unit tests and CI. It backs onto an in-memory store, signs
 * webhooks with HMAC-SHA-256, and lets the suite inject 401/410/429
 * responses on the next call.
 *
 * Concrete connectors (FAG-5) will ship their own harness that
 * proxies to the real provider.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectorHarness } from './types.js';

export interface FakeConnectorHarnessOptions {
  /** Webhook secret. Default: a random 32-byte key. */
  webhookSecret?: string;
  /** Items to seed `list()` with. Default: 12 generated items. */
  listItems?: Array<Record<string, unknown>>;
  /** Items per page. Default: 5. */
  pageSize?: number;
  /** Latency to inject into `health()`. Default: 1 ms. */
  healthLatencyMs?: number;
}

interface InjectedStatus {
  status: 401 | 410 | 429;
  retryAfterMs?: number;
}

export class FakeConnectorHarness implements ConnectorHarness {
  private readonly secret: Buffer;
  private readonly items: Array<Record<string, unknown>>;
  private readonly pageSize: number;
  private readonly healthLatencyMs: number;
  private nextStatus: InjectedStatus | undefined;
  private readonly issuedKeys = new Map<string, unknown>();
  private tokenCounter = 0;

  constructor(opts: FakeConnectorHarnessOptions = {}) {
    this.secret = Buffer.from(opts.webhookSecret ?? randomBytes(32).toString('hex'), 'utf8');
    const count = 12;
    this.items = opts.listItems ?? Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}`, n: i + 1 }));
    this.pageSize = opts.pageSize ?? 5;
    this.healthLatencyMs = opts.healthLatencyMs ?? 1;
  }

  async obtainCredentials(): Promise<{ token: string; expiresAt: number }> {
    this.tokenCounter += 1;
    return {
      token: `fake-token-${this.tokenCounter}-${randomBytes(4).toString('hex')}`,
      expiresAt: Date.now() + 60_000,
    };
  }

  async invoke<T = unknown>(args: {
    auth: { token: string };
    capability: { type: string; operation: string };
    args: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; data?: T; error?: { code: string; message: string; retryAfterMs?: number; status?: number }; idempotencyKey: string }> {
    // Honor an injected status first.
    const injected = this.nextStatus;
    this.nextStatus = undefined;
    if (injected) {
      return {
        ok: false,
        idempotencyKey: args.idempotencyKey,
        error: {
          code: `HTTP_${injected.status}`,
          message: `injected ${injected.status}`,
          status: injected.status,
          ...(injected.retryAfterMs !== undefined ? { retryAfterMs: injected.retryAfterMs } : {}),
        },
      };
    }

    if (!args.auth.token) {
      return {
        ok: false,
        idempotencyKey: args.idempotencyKey,
        error: { code: 'AUTH_MISSING', message: 'no token', status: 401 },
      };
    }

    // Idempotency replay returns the cached body verbatim.
    if (this.issuedKeys.has(args.idempotencyKey)) {
      const cached = this.issuedKeys.get(args.idempotencyKey) as { data: T };
      return { ok: true, data: cached.data, idempotencyKey: args.idempotencyKey };
    }

    const data = (args.capability.operation === 'echo' ? args.args : { ok: true, op: args.capability.operation }) as T;
    this.issuedKeys.set(args.idempotencyKey, { data });
    return { ok: true, data, idempotencyKey: args.idempotencyKey };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = 'sha256=' + createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
    } catch {
      return false;
    }
  }

  buildSignedWebhook(payload: Record<string, unknown>): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    const signature = 'sha256=' + createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
    return { rawBody, signature };
  }

  injectNextStatus(status: 401 | 410 | 429, opts?: { retryAfterMs?: number }): void {
    this.nextStatus = { status, ...(opts?.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}) };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return { ok: true, latencyMs: this.healthLatencyMs };
  }

  async list<T = unknown>(args: { auth: { token: string }; limit: number; cursor?: string }): Promise<{ items: T[]; nextCursor?: string }> {
    if (!args.auth.token) throw new Error('no token');
    const start = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
    if (Number.isNaN(start) || start < 0) throw new Error('bad cursor');
    const limit = Math.min(args.limit, this.pageSize);
    const slice = this.items.slice(start, start + limit) as unknown as T[];
    const next = start + slice.length;
    const out: { items: T[]; nextCursor?: string } = { items: slice };
    if (next < this.items.length) out.nextCursor = String(next);
    return out;
  }
}
