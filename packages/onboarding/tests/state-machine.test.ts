/**
 * Onboarding state-machine tests.
 *
 * FAG-32 acceptance criteria exercised:
 *   - Happy path: workspace profile -> owner -> policy -> link -> agent -> review
 *   - Back navigation: revisitStep
 *   - Interrupted onboarding: abandon + resume
 *   - Terminal-state guards
 *   - Progress is monotonic
 */
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STEP_ORDER,
  abandonOnboarding,
  completeCurrentStep,
  isOnboardingTerminal,
  onboardingProgress,
  restartFromBeginning,
  resumeOnboarding,
  revisitStep,
  startOnboarding,
} from '../src/state-machine.js';

const fixedNow = () => new Date('2025-01-01T00:00:00.000Z');

describe('startOnboarding', () => {
  it('starts at workspace_profile with an empty completed-steps set', () => {
    const s = startOnboarding('w1', fixedNow);
    expect(s.workspaceId).toBe('w1');
    expect(s.currentStep).toBe('workspace_profile');
    expect(s.completedSteps).toEqual([]);
    expect(s.status).toBe('in_progress');
    expect(s.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('completeCurrentStep — happy path', () => {
  it('walks all six steps in order and lands in completed status', () => {
    let s = startOnboarding('w1', fixedNow);
    for (let i = 0; i < ONBOARDING_STEP_ORDER.length; i++) {
      s = completeCurrentStep(s, fixedNow);
    }
    expect(s.status).toBe('completed');
    expect(s.completedSteps).toEqual([...ONBOARDING_STEP_ORDER]);
    expect(isOnboardingTerminal(s)).toBe(true);
    expect(onboardingProgress(s)).toBe(1);
  });

  it('rejects completing a step that is already in completedSteps', () => {
    // Construct a state where the currentStep is already recorded
    // as complete (e.g. after a manual state migration). The state
    // machine refuses to advance to avoid double-counting.
    const s = {
      workspaceId: 'w1',
      currentStep: 'workspace_profile' as const,
      completedSteps: ['workspace_profile' as const],
      status: 'in_progress' as const,
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    expect(() => completeCurrentStep(s, fixedNow)).toThrow(/already marked complete/);
  });

  it('progress increases monotonically from 0 to 1', () => {
    let s = startOnboarding('w1', fixedNow);
    expect(onboardingProgress(s)).toBe(0);
    for (let i = 0; i < ONBOARDING_STEP_ORDER.length - 1; i++) {
      s = completeCurrentStep(s, fixedNow);
      const expected = (s.completedSteps.length + 0.5) / ONBOARDING_STEP_ORDER.length;
      expect(onboardingProgress(s)).toBeCloseTo(expected);
    }
    s = completeCurrentStep(s, fixedNow);
    expect(onboardingProgress(s)).toBe(1);
  });
});

describe('completeCurrentStep — terminal-state guards', () => {
  it('refuses to advance after the workspace is completed', () => {
    let s = startOnboarding('w1', fixedNow);
    for (let i = 0; i < ONBOARDING_STEP_ORDER.length; i++) s = completeCurrentStep(s, fixedNow);
    expect(() => completeCurrentStep(s, fixedNow)).toThrow(/completed/);
  });

  it('refuses to advance after the onboarding is abandoned', () => {
    let s = startOnboarding('w1', fixedNow);
    s = completeCurrentStep(s, fixedNow);
    s = abandonOnboarding(s, 'user navigated away', fixedNow);
    expect(() => completeCurrentStep(s, fixedNow)).toThrow(/abandoned/);
  });
});

describe('revisitStep — back navigation', () => {
  it('jumps back to a prior step without losing completed history', () => {
    let s = startOnboarding('w1', fixedNow);
    s = completeCurrentStep(s, fixedNow); // workspace_profile done
    s = completeCurrentStep(s, fixedNow); // owner_identity done
    s = revisitStep(s, 'workspace_profile', fixedNow);
    expect(s.currentStep).toBe('workspace_profile');
    expect(s.completedSteps).toEqual(['workspace_profile', 'owner_identity']);
  });

  it('refuses back navigation on a completed onboarding', () => {
    let s = startOnboarding('w1', fixedNow);
    for (let i = 0; i < ONBOARDING_STEP_ORDER.length; i++) s = completeCurrentStep(s, fixedNow);
    expect(() => revisitStep(s, 'owner_identity', fixedNow)).toThrow(/completed/);
  });

  it('refuses back navigation while abandoned (resume first)', () => {
    let s = startOnboarding('w1', fixedNow);
    s = abandonOnboarding(s, 'paused', fixedNow);
    expect(() => revisitStep(s, 'owner_identity', fixedNow)).toThrow(/resume/);
  });

  it('refuses unknown step names', () => {
    const s = startOnboarding('w1', fixedNow);
    expect(() => revisitStep(s, 'not_a_step' as never, fixedNow)).toThrow(/unknown step/);
  });
});

describe('abandonOnboarding + resumeOnboarding', () => {
  it('captures the reason and switches to abandoned status', () => {
    let s = startOnboarding('w1', fixedNow);
    s = abandonOnboarding(s, 'user closed the tab', fixedNow);
    expect(s.status).toBe('abandoned');
    expect(s.abandonedReason).toBe('user closed the tab');
  });

  it('rejects an empty abandon reason', () => {
    const s = startOnboarding('w1', fixedNow);
    expect(() => abandonOnboarding(s, '   ', fixedNow)).toThrow(/reason/);
  });

  it('refuses to abandon a completed onboarding', () => {
    let s = startOnboarding('w1', fixedNow);
    for (let i = 0; i < ONBOARDING_STEP_ORDER.length; i++) s = completeCurrentStep(s, fixedNow);
    expect(() => abandonOnboarding(s, 'too late', fixedNow)).toThrow(/completed/);
  });

  it('resume restores in_progress status and drops the reason', () => {
    let s = startOnboarding('w1', fixedNow);
    s = completeCurrentStep(s, fixedNow);
    s = abandonOnboarding(s, 'paused', fixedNow);
    const r = resumeOnboarding(s, fixedNow);
    expect(r.status).toBe('in_progress');
    expect(r.abandonedReason).toBeUndefined();
    expect(r.currentStep).toBe(s.currentStep);
    expect(r.completedSteps).toEqual(s.completedSteps);
  });

  it('resume is rejected when the onboarding is not abandoned', () => {
    const s = startOnboarding('w1', fixedNow);
    expect(() => resumeOnboarding(s, fixedNow)).toThrow(/cannot resume/);
  });
});

describe('restartFromBeginning', () => {
  it('wipes completed steps and jumps back to the start', () => {
    let s = startOnboarding('w1', fixedNow);
    s = completeCurrentStep(s, fixedNow);
    s = completeCurrentStep(s, fixedNow);
    s = restartFromBeginning(s, fixedNow);
    expect(s.currentStep).toBe('workspace_profile');
    expect(s.completedSteps).toEqual([]);
    expect(s.status).toBe('in_progress');
  });
});

describe('default clock fallback', () => {
  // These tests deliberately do NOT pass a `now` argument so the
  // default `() => new Date()` clock factory is exercised.
  it('startOnboarding uses Date.now() when no clock is supplied', () => {
    const s = startOnboarding('w1');
    expect(s.currentStep).toBe('workspace_profile');
    expect(s.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('completeCurrentStep uses Date.now() when no clock is supplied', () => {
    const s = completeCurrentStep(startOnboarding('w1'));
    expect(s.completedSteps).toContain('workspace_profile');
  });

  it('abandonOnboarding uses Date.now() when no clock is supplied', () => {
    const s = abandonOnboarding(startOnboarding('w1'), 'tab closed');
    expect(s.status).toBe('abandoned');
    expect(s.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('resumeOnboarding uses Date.now() when no clock is supplied', () => {
    const s0 = abandonOnboarding(startOnboarding('w1'), 'tab closed');
    const s = resumeOnboarding(s0);
    expect(s.status).toBe('in_progress');
  });

  it('restartFromBeginning uses Date.now() when no clock is supplied', () => {
    const s = restartFromBeginning(startOnboarding('w1'));
    expect(s.currentStep).toBe('workspace_profile');
  });

  it('revisitStep uses Date.now() when no clock is supplied', () => {
    const s = revisitStep(startOnboarding('w1'), 'workspace_profile');
    expect(s.currentStep).toBe('workspace_profile');
  });
});
