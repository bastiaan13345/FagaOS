/**
 * In-memory Cedar-like policy engine.
 *
 * The engine evaluates `PolicyRequest`s against a versioned rule set
 * using a strict, deterministic algorithm:
 *
 *   1. For every rule in the rule set, decide whether it matches the
 *      request (principal × action × resource × conditions). A
 *      condition is satisfied iff its tree of leaf operators all
 *      match against the request `context`.
 *   2. If any DENY rule matches, return `{ allow: false, ruleId }`
 *      with that rule's id. DENY always wins, even if an ALLOW also
 *      matches.
 *   3. If any ALLOW rule matches, return `{ allow: true, ruleId }`.
 *   4. Otherwise, default deny.
 *
 * The engine is fed by the `PolicyAdministrator` via the
 * `PolicyDecisionStore`. When the administrator publishes a new
 * version, the engine re-installs the published rule set. Until a
 * version is published, the engine falls back to the rule set passed
 * at construction time, or empty (default-deny) if none was passed.
 *
 * Cedar fidelity is intentionally limited: the engine supports
 * principal/action/resource matching and condition trees, which is
 * what Phase 2 needs. It does *not* yet support entity hierarchies,
 * link expansion, or template instantiation. Those are the gap to
 * fill if/when we adopt a real Cedar backend (see ADR 0005).
 */
import { z } from 'zod';
import {
  PolicyRuleSchema,
  type ConditionLeaf,
  type ConditionNode,
  type PolicyDecision,
  type PolicyEngineV2,
  type PolicyRequest,
  type PolicyRule,
  type PolicyDecisionStore,
} from './types.js';

export interface InMemoryCedarLikePolicyEngineOptions {
  store: PolicyDecisionStore;
  /** Initial rules. Replaced when the first version is published. */
  initialRules?: PolicyRule[];
}

export class InMemoryCedarLikePolicyEngine implements PolicyEngineV2 {
  private rules: PolicyRule[];
  private readonly store: PolicyDecisionStore;
  private versionId: string | null = null;
  private versionNumber: number | null = null;

  constructor(opts: InMemoryCedarLikePolicyEngineOptions) {
    this.store = opts.store;
    this.rules = [];
    if (opts.initialRules && opts.initialRules.length > 0) {
      this.rules = opts.initialRules.map((r) => PolicyRuleSchema.parse(r));
    }
    const published = this.store.getPublished();
    if (published) {
      this.installPublished(published);
    }
  }

  /* ------------------------ Engine surface --------------------------- */

  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    this.refreshIfChanged();
    let firstDeny: PolicyRule | null = null;
    for (const rule of this.rules) {
      if (!this.matches(rule, request)) continue;
      if (rule.effect === 'DENY') {
        if (firstDeny === null) firstDeny = rule;
        // Keep scanning — a later ALLOW cannot override a DENY, but
        // we want the *first* DENY so the audit log has a stable
        // rule id to record.
      }
    }
    if (firstDeny) {
      return { allow: false, ruleId: firstDeny.id, reason: `deny:${firstDeny.id}` };
    }
    for (const rule of this.rules) {
      if (!this.matches(rule, request)) continue;
      if (rule.effect === 'ALLOW') {
        return { allow: true, ruleId: rule.id, reason: `allow:${rule.id}` };
      }
    }
    return { allow: false, reason: 'no_matching_allow' };
  }

  addRules(rules: PolicyRule[]): void {
    const parsed = rules.map((r) => PolicyRuleSchema.parse(r));
    this.rules = [...this.rules, ...parsed];
  }

  reset(rules: PolicyRule[] = []): void {
    this.rules = rules.map((r) => PolicyRuleSchema.parse(r));
  }

  currentRules(): ReadonlyArray<PolicyRule> {
    return [...this.rules];
  }

  effectiveVersion(): { versionId: string; version: number } | null {
    if (!this.versionId || this.versionNumber === null) return null;
    return { versionId: this.versionId, version: this.versionNumber };
  }

  /* ----------------------- Match evaluation -------------------------- */

  private matches(rule: PolicyRule, request: PolicyRequest): boolean {
    return (
      this.principalMatches(rule.principal, request) &&
      this.actionMatches(rule.action, request) &&
      this.resourceMatches(rule.resource, request) &&
      (!rule.condition || this.conditionMatches(rule.condition, request.context ?? {}))
    );
  }

  private principalMatches(principal: PolicyRule['principal'], request: PolicyRequest): boolean {
    switch (principal.type) {
      case 'any':
        return true;
      case 'id':
        return request.actor.id === principal.id;
      case 'prefix':
        return request.actor.id.startsWith(principal.prefix);
      case 'role': {
        const roles = readRoles(request.context);
        return roles.includes(principal.role);
      }
    }
  }

  private actionMatches(action: PolicyRule['action'], request: PolicyRequest): boolean {
    switch (action.type) {
      case 'any':
        return true;
      case 'exact':
        return request.action.namespace === action.namespace && request.action.name === action.name;
      case 'namespace':
        if (request.action.namespace !== action.namespace) return false;
        return action.name === undefined || request.action.name === action.name;
    }
  }

  private resourceMatches(resource: PolicyRule['resource'], request: PolicyRequest): boolean {
    switch (resource.type) {
      case 'any':
        return true;
      case 'exact':
        return request.resource.type === resource.resourceType && request.resource.id === resource.id;
      case 'type':
        return request.resource.type === resource.resourceType;
    }
  }

  private conditionMatches(node: ConditionNode, context: Record<string, unknown>): boolean {
    switch (node.op) {
      case 'all':
        return node.children.every((c) => this.conditionMatches(c, context));
      case 'any':
        return node.children.some((c) => this.conditionMatches(c, context));
      case 'not':
        return !node.children.every((c) => this.conditionMatches(c, context));
      default:
        return this.leafMatches(node as ConditionLeaf, context);
    }
  }

  private leafMatches(leaf: ConditionLeaf, context: Record<string, unknown>): boolean {
    const value = readPath(context, leaf.path);
    switch (leaf.op) {
      case 'eq':
        return value === leaf.value;
      case 'neq':
        return value !== leaf.value;
      case 'lt':
        return typeof value === 'number' && value < leaf.value;
      case 'lte':
        return typeof value === 'number' && value <= leaf.value;
      case 'gt':
        return typeof value === 'number' && value > leaf.value;
      case 'gte':
        return typeof value === 'number' && value >= leaf.value;
      case 'in':
        return leaf.values.includes(value as never);
      case 'startsWith':
        return typeof value === 'string' && value.startsWith(leaf.value);
      case 'exists':
        return value !== undefined;
    }
  }

  /* ---------------------- Version management ------------------------- */

  /**
   * Re-install the published version's rules if it has changed since
   * the last refresh. Called on every `decide()` so the engine always
   * sees the live version published by the administrator.
   */
  private refreshIfChanged(): void {
    const published = this.store.getPublished();
    if (published && published.id !== this.versionId) {
      this.installPublished(published);
    } else if (published === null && this.versionId !== null) {
      // The previously-published version was retired and no new version
      // has been published; fall back to the empty rule set (default deny).
      this.rules = [];
      this.versionId = null;
      this.versionNumber = null;
    }
  }

  /** Internal: install the published version. */
  installPublished(version: ReturnType<PolicyDecisionStore['getPublished']>): void {
    if (!version) return;
    this.rules = version.rules.map((r) => PolicyRuleSchema.parse(r));
    this.versionId = version.id;
    this.versionNumber = version.version;
  }
}

function readRoles(context: Record<string, unknown> | undefined): string[] {
  if (!context) return [];
  const raw = context['roles'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string');
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cursor: unknown = value;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/* ------------------------ Schema exports --------------------------- */

export const PolicyEngineV2Schema = z.object({
  rules: z.array(PolicyRuleSchema),
});
