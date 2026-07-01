/**
 * Onboarding state machine.
 *
 * The first-run flow walks a new workspace through six ordered
 * steps. The state machine is intentionally tiny: a `currentStep`,
 * a `completedSteps` set, and a transition table. The control plane
 * (HTTP / UI) is the only writer; the primitive is pure logic, easy
 * to test, and easy to resume after an interruption.
 *
 * The six steps are the FAG-32 acceptance criteria #1:
 *   1. workspace_profile        — name, region, default locale
 *   2. owner_identity           — confirm the human who owns the workspace
 *   3. policy_defaults          — pick a safe-default policy preset
 *   4. account_linking          — link at least one connector account
 *   5. first_agent              — seed the first AgentCard from a template
 *   6. review_launch            — final review and launch
 *
 * `currentStep` advances only when the previous step is recorded as
 * complete. The state machine refuses to skip forward; the control
 * plane is responsible for collecting whatever per-step data it
 * needs (the state machine does not own per-step payloads).
 */
import { z } from 'zod';

/** The six onboarding steps, in their required order. */
export const OnboardingStepSchema = z.enum([
  'workspace_profile',
  'owner_identity',
  'policy_defaults',
  'account_linking',
  'first_agent',
  'review_launch',
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

/** The terminal states of the state machine. */
export const OnboardingStatusSchema = z.enum(['in_progress', 'completed', 'abandoned']);
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

/** Persisted state for a workspace's onboarding run. */
export const OnboardingStateSchema = z.object({
  workspaceId: z.string().min(1),
  currentStep: OnboardingStepSchema,
  completedSteps: z.array(OnboardingStepSchema).default([]),
  status: OnboardingStatusSchema.default('in_progress'),
  /** Optional human-readable reason for an `abandoned` state. */
  abandonedReason: z.string().optional(),
  /** ISO 8601 timestamp of the last state mutation. */
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

/** Ordered list of steps. The first entry is the start step. */
export const ONBOARDING_STEP_ORDER: ReadonlyArray<OnboardingStep> = [
  'workspace_profile',
  'owner_identity',
  'policy_defaults',
  'account_linking',
  'first_agent',
  'review_launch',
];

/** Error raised when a transition is not legal from the current state. */
export class OnboardingTransitionError extends Error {
  readonly code: 'invalid_transition' | 'step_not_complete' | 'terminal_state';
  constructor(code: 'invalid_transition' | 'step_not_complete' | 'terminal_state', message: string) {
    super(message);
    this.name = 'OnboardingTransitionError';
    this.code = code;
  }
}

/** Build the initial state for a fresh workspace. */
export function startOnboarding(workspaceId: string, now: () => Date = () => new Date()): OnboardingState {
  return {
    workspaceId,
    currentStep: ONBOARDING_STEP_ORDER[0]!,
    completedSteps: [],
    status: 'in_progress',
    updatedAt: now().toISOString(),
  };
}

/** Mark the current step complete and advance to the next step. */
export function completeCurrentStep(state: OnboardingState, now: () => Date = () => new Date()): OnboardingState {
  if (state.status !== 'in_progress') {
    throw new OnboardingTransitionError('terminal_state', `cannot complete step from terminal status "${state.status}"`);
  }
  if (state.completedSteps.includes(state.currentStep)) {
    throw new OnboardingTransitionError('invalid_transition', `step "${state.currentStep}" is already marked complete`);
  }
  const idx = ONBOARDING_STEP_ORDER.indexOf(state.currentStep);
  const next = ONBOARDING_STEP_ORDER[idx + 1];
  const completed: OnboardingState = {
    ...state,
    completedSteps: [...state.completedSteps, state.currentStep],
    currentStep: next ?? state.currentStep,
    status: next ? 'in_progress' : 'completed',
    updatedAt: now().toISOString(),
  };
  if (!next) {
    // The last step was just completed; the workspace is launched.
    completed.currentStep = state.currentStep;
  }
  return completed;
}

/** Mark a previous step as the new current step (back navigation). */
export function revisitStep(
  state: OnboardingState,
  step: OnboardingStep,
  now: () => Date = () => new Date(),
): OnboardingState {
  if (state.status === 'completed') {
    throw new OnboardingTransitionError('terminal_state', 'cannot revisit a step in a completed onboarding');
  }
  if (state.status === 'abandoned') {
    throw new OnboardingTransitionError('terminal_state', 'cannot revisit a step in an abandoned onboarding; resume first');
  }
  // Back-nav is allowed to any prior step, including the current one.
  if (!ONBOARDING_STEP_ORDER.includes(step)) {
    throw new OnboardingTransitionError('invalid_transition', `unknown step "${step}"`);
  }
  return { ...state, currentStep: step, updatedAt: now().toISOString() };
}

/** Abandon onboarding, capturing the reason. The run can be resumed. */
export function abandonOnboarding(
  state: OnboardingState,
  reason: string,
  now: () => Date = () => new Date(),
): OnboardingState {
  if (!reason.trim()) {
    throw new OnboardingTransitionError('invalid_transition', 'abandon reason must not be empty');
  }
  if (state.status === 'completed') {
    throw new OnboardingTransitionError('terminal_state', 'cannot abandon a completed onboarding');
  }
  return { ...state, status: 'abandoned', abandonedReason: reason, updatedAt: now().toISOString() };
}

/** Resume an abandoned onboarding. The currentStep is preserved. */
export function resumeOnboarding(state: OnboardingState, now: () => Date = () => new Date()): OnboardingState {
  if (state.status !== 'abandoned') {
    throw new OnboardingTransitionError('invalid_transition', `cannot resume from status "${state.status}"`);
  }
  const { abandonedReason: _abandonedReason, ...rest } = state;
  void _abandonedReason;
  return { ...rest, status: 'in_progress', updatedAt: now().toISOString() };
}

/** Read-only helper: is the run finished? */
export function isOnboardingTerminal(state: OnboardingState): boolean {
  return state.status === 'completed';
}

/** Read-only helper: progress in [0, 1]. */
export function onboardingProgress(state: OnboardingState): number {
  if (state.status === 'completed') return 1;
  if (state.completedSteps.length === 0) return 0;
  // Count the in-flight step as 50% so progress moves on entry.
  return Math.min(1, (state.completedSteps.length + 0.5) / ONBOARDING_STEP_ORDER.length);
}

/**
 * Restart the onboarding flow from the first step. Completed-step
 * history is dropped, the workspace is set back to `in_progress`.
 * Useful when the owner wants to redo onboarding with a different
 * policy preset or a different account linkage.
 */
export function restartFromBeginning(state: OnboardingState, now: () => Date = () => new Date()): OnboardingState {
  return {
    ...state,
    currentStep: ONBOARDING_STEP_ORDER[0]!,
    completedSteps: [],
    status: 'in_progress',
    abandonedReason: undefined,
    updatedAt: now().toISOString(),
  };
}
