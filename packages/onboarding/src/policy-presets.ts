/**
 * Safe-default policy presets.
 *
 * FAG-32 acceptance criterion #4: every new workspace starts under a
 * safe-default policy set. The defaults below are deliberately
 * conservative — read-only where possible, draft-before-send,
 * per-action approval for sends and calendar writes, restricted
 * network and file access, no persistent approvals. Admins loosen
 * the policy through the regular FAG-24 draft / review / publish
 * flow; the onboarding flow just submits the draft.
 *
 * The presets are pure data: a list of `PolicyRule`s plus a
 * metadata record (label, blurb, whether it's the default). The
 * onboarding control plane picks one, calls `buildPolicyDraft`, and
 * hands the resulting draft to the policy administrator.
 */
import type { PolicyRule } from '@fagaos/policy';

/** Identifier for a preset. The set is small and stable. */
export type PolicyPresetId = 'read_only' | 'draft_before_send' | 'restricted' | 'unrestricted_ack';

/** A preset is a bundle of policy rules plus a description. */
export interface PolicyPreset {
  readonly id: PolicyPresetId;
  readonly label: string;
  readonly blurb: string;
  /** True for the recommended default on a brand-new workspace. */
  readonly isDefault: boolean;
  readonly rules: ReadonlyArray<PolicyRule>;
}

/* ------------------------------------------------------------------------- */
/* Preset rules                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Read-only preset: deny every connector / desktop / browser action.
 * Use this for the "I just want to see what FagaOS does" tier. The
 * workspace owner can flip to a more permissive preset any time
 * via the policy admin UI.
 */
const READ_ONLY_RULES: ReadonlyArray<PolicyRule> = [
  {
    id: 'onboarding.read_only.connector.deny',
    effect: 'DENY',
    description: 'Deny every connector call (read or write) under the read-only preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'connector' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.read_only.desktop.deny',
    effect: 'DENY',
    description: 'Deny every desktop action under the read-only preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'desktop' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.read_only.browser.deny',
    effect: 'DENY',
    description: 'Deny every browser action under the read-only preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'browser' },
    resource: { type: 'any' },
  },
];

/**
 * Draft-before-send preset (the recommended default). Reads are
 * allowed; writes create a draft that the user must approve. Any
 * `send` / `delete` action is denied outright until a follow-up
 * preset or ad-hoc grant widens it.
 */
const DRAFT_BEFORE_SEND_RULES: ReadonlyArray<PolicyRule> = [
  {
    id: 'onboarding.draft.connector.read.allow',
    effect: 'ALLOW',
    description: 'Allow connector reads (mail.list, mail.get, calendar.events.list, ...).',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'connector.read' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.draft.connector.send.deny',
    effect: 'DENY',
    description: 'Deny connector sends and writes by default; operators opt in per-action.',
    principal: { type: 'any' },
    action: { type: 'exact', namespace: 'connector', name: 'mail.send' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.draft.connector.dm.send.deny',
    effect: 'DENY',
    description: 'Deny DM sends by default; the user can approve per conversation.',
    principal: { type: 'any' },
    action: { type: 'exact', namespace: 'connector', name: 'dm.send' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.draft.calendar.write.deny',
    effect: 'DENY',
    description: 'Deny calendar event creates/updates/deletes by default.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'calendar.write' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.draft.approval.required',
    effect: 'DENY',
    description: 'Force per-action approval for any connector write that has been explicitly opened up.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'connector.write' },
    resource: { type: 'any' },
    // When a write is allowed by a later preset, this condition
    // forces the connector gateway to demand an approval grant.
    // The condition is intentionally a no-op at the policy level
    // — the per-action gate is enforced by the connector gateway
    // when the workspace profile sets `require_approval: true`.
  },
];

/**
 * Restricted preset: same as draft-before-send, plus deny shell /
 * code-exec and require approval for browser checkout and desktop
 * takeover. Network and file access is restricted to an allow-list
 * (declared elsewhere, not in the rule body).
 */
const RESTRICTED_RULES: ReadonlyArray<PolicyRule> = [
  ...DRAFT_BEFORE_SEND_RULES,
  {
    id: 'onboarding.restricted.shell.deny',
    effect: 'DENY',
    description: 'Deny shell and code-exec actions under the restricted preset.',
    principal: { type: 'any' },
    action: { type: 'any' },
    resource: { type: 'any' },
    condition: { op: 'in', path: 'namespace', values: ['shell', 'code-exec'] },
  },
  {
    id: 'onboarding.restricted.browser.checkout.deny',
    effect: 'DENY',
    description: 'Deny browser checkout by default; the user must approve.',
    principal: { type: 'any' },
    action: { type: 'exact', namespace: 'browser', name: 'checkout' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.restricted.desktop.takeover.deny',
    effect: 'DENY',
    description: 'Deny desktop takeover by default; the user must approve.',
    principal: { type: 'any' },
    action: { type: 'exact', namespace: 'desktop', name: 'takeover' },
    resource: { type: 'any' },
  },
];

/**
 * Unrestricted (ack) preset: a deliberately permissive baseline for
 * users who have explicitly acknowledged the risk. This is what
 * FagaOS calls "advanced mode". It is not the default.
 */
const UNRESTRICTED_RULES: ReadonlyArray<PolicyRule> = [
  {
    id: 'onboarding.unrestricted.connector.allow',
    effect: 'ALLOW',
    description: 'Allow every connector action under the unrestricted preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'connector' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.unrestricted.desktop.allow',
    effect: 'ALLOW',
    description: 'Allow desktop actions under the unrestricted preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'desktop' },
    resource: { type: 'any' },
  },
  {
    id: 'onboarding.unrestricted.browser.allow',
    effect: 'ALLOW',
    description: 'Allow browser actions under the unrestricted preset.',
    principal: { type: 'any' },
    action: { type: 'namespace', namespace: 'browser' },
    resource: { type: 'any' },
  },
];

/* ------------------------------------------------------------------------- */
/* Public preset catalog                                                     */
/* ------------------------------------------------------------------------- */

export const POLICY_PRESETS: ReadonlyArray<PolicyPreset> = [
  {
    id: 'read_only',
    label: 'Read-only',
    blurb: 'Reads are blocked, too. Use this to inspect FagaOS without exposing any account data.',
    isDefault: false,
    rules: READ_ONLY_RULES,
  },
  {
    id: 'draft_before_send',
    label: 'Draft before send',
    blurb: 'Reads are allowed; writes create a draft. The user approves each send. Recommended default.',
    isDefault: true,
    rules: DRAFT_BEFORE_SEND_RULES,
  },
  {
    id: 'restricted',
    label: 'Restricted',
    blurb: 'Draft-before-send plus deny shell/code-exec, browser checkout, and desktop takeover.',
    isDefault: false,
    rules: RESTRICTED_RULES,
  },
  {
    id: 'unrestricted_ack',
    label: 'Unrestricted (advanced)',
    blurb: 'Allow all connector / desktop / browser actions. The user has acknowledged the risk.',
    isDefault: false,
    rules: UNRESTRICTED_RULES,
  },
];

/** Find a preset by id, or `undefined` if it does not exist. */
export function findPreset(id: PolicyPresetId): PolicyPreset | undefined {
  return POLICY_PRESETS.find((p) => p.id === id);
}

/** The preset the onboarding flow auto-selects for a brand-new workspace. */
// The catalog always has exactly one preset with `isDefault: true`;
// that invariant is enforced by the unit test `marks exactly one
// preset as the default`. The non-null assertion is therefore safe
// at runtime, and keeps this helper branch-free.
const DEFAULT_PRESET: PolicyPreset = POLICY_PRESETS.find((p) => p.isDefault)!;

/** The preset the onboarding flow auto-selects for a brand-new workspace. */
export function defaultPreset(): PolicyPreset {
  return DEFAULT_PRESET;
}

/**
 * Build a `PolicyAdministrator.draft(...)` payload from a preset.
 * The administrator requires a stable shape; we copy the rules so
 * the caller's preset object cannot be mutated downstream.
 */
export function buildPolicyDraft(preset: PolicyPreset, createdBy: string) {
  return {
    rules: preset.rules.map((r) => ({ ...r })),
    createdBy,
    changeNote: `Onboarding safe-default policy (${preset.id}).`,
  };
}
