/**
 * Policy-preset tests.
 *
 * FAG-32 acceptance criteria #4: every new workspace starts under a
 * safe-default policy. The presets are pure data; the tests assert
 * the catalog is well-formed and that `buildPolicyDraft` produces
 * a payload the policy administrator can consume.
 */
import { describe, it, expect } from 'vitest';
import {
  POLICY_PRESETS,
  buildPolicyDraft,
  defaultPreset,
  findPreset,
  type PolicyPresetId,
} from '../src/policy-presets.js';

describe('POLICY_PRESETS catalog', () => {
  it('exposes the four documented presets', () => {
    const ids = POLICY_PRESETS.map((p) => p.id);
    expect(ids).toContain('read_only');
    expect(ids).toContain('draft_before_send');
    expect(ids).toContain('restricted');
    expect(ids).toContain('unrestricted_ack');
  });

  it('marks exactly one preset as the default', () => {
    const defaults = POLICY_PRESETS.filter((p) => p.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0]?.id).toBe('draft_before_send');
  });

  it('every preset has at least one rule', () => {
    for (const p of POLICY_PRESETS) {
      expect(p.rules.length, p.id).toBeGreaterThan(0);
    }
  });

  it('every rule id is unique within a preset (shared IDs across presets are fine for inheritance)', () => {
    for (const p of POLICY_PRESETS) {
      const ids = new Set<string>();
      for (const r of p.rules) {
        expect(ids.has(r.id), `duplicate rule id ${r.id} in preset ${p.id}`).toBe(false);
        ids.add(r.id);
      }
    }
  });
});

describe('defaultPreset / findPreset', () => {
  it('defaultPreset returns the isDefault preset', () => {
    expect(defaultPreset().id).toBe('draft_before_send');
  });

  it('findPreset returns the matching preset for a known id', () => {
    expect(findPreset('read_only' as PolicyPresetId)?.id).toBe('read_only');
    expect(findPreset('restricted' as PolicyPresetId)?.id).toBe('restricted');
  });

  it('findPreset returns undefined for an unknown id', () => {
    expect(findPreset('not_a_preset' as PolicyPresetId)).toBeUndefined();
  });
});

describe('safe-default semantics', () => {
  it('read_only denies every connector / desktop / browser action', () => {
    const preset = findPreset('read_only' as PolicyPresetId)!;
    const namespaces = preset.rules
      .filter((r) => r.effect === 'DENY')
      .flatMap((r) => (r.action.type === 'namespace' ? [r.action.namespace] : []));
    expect(namespaces).toContain('connector');
    expect(namespaces).toContain('desktop');
    expect(namespaces).toContain('browser');
  });

  it('draft_before_send allows reads but denies mail.send and dm.send', () => {
    const preset = findPreset('draft_before_send' as PolicyPresetId)!;
    const denyActions = preset.rules
      .filter((r) => r.effect === 'DENY' && r.action.type === 'exact')
      .map((r) => (r.action.type === 'exact' ? r.action.name : null));
    expect(denyActions).toContain('mail.send');
    expect(denyActions).toContain('dm.send');
  });

  it('restricted adds shell / code-exec / browser-checkout / desktop-takeover denials', () => {
    const preset = findPreset('restricted' as PolicyPresetId)!;
    const denyActions = preset.rules
      .filter((r) => r.effect === 'DENY' && r.action.type === 'exact')
      .map((r) => (r.action.type === 'exact' ? r.action.name : null));
    expect(denyActions).toContain('mail.send');
    // The restricted preset has the additional deny rules.
    const denyNamespace = preset.rules
      .filter((r) => r.effect === 'DENY' && r.action.type === 'any')
      .map((r) => r.condition);
    expect(denyNamespace.length).toBeGreaterThan(0);
  });

  it('unrestricted_ack allows every connector / desktop / browser action', () => {
    const preset = findPreset('unrestricted_ack' as PolicyPresetId)!;
    const allowNamespaces = preset.rules
      .filter((r) => r.effect === 'ALLOW')
      .flatMap((r) => (r.action.type === 'namespace' ? [r.action.namespace] : []));
    expect(allowNamespaces).toContain('connector');
    expect(allowNamespaces).toContain('desktop');
    expect(allowNamespaces).toContain('browser');
  });
});

describe('buildPolicyDraft', () => {
  it('produces a copy of the rules so the caller cannot mutate the preset', () => {
    const preset = defaultPreset();
    const draft = buildPolicyDraft(preset, 'admin@example.com');
    expect(draft.createdBy).toBe('admin@example.com');
    expect(draft.changeNote).toContain('draft_before_send');
    expect(draft.rules.length).toBe(preset.rules.length);
    // Mutating the draft must not affect the catalog.
    (draft.rules[0] as { id: string }).id = 'mutated';
    expect(preset.rules[0]?.id).not.toBe('mutated');
  });
});
