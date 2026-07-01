/**
 * @fagaos/onboarding — first-run onboarding and account-linking primitive.
 *
 * FAG-32 acceptance criteria are met as follows:
 *   1. Onboarding steps          — see `./state-machine.js`
 *   2. Account-linking states    — see `./account-link.js`
 *   3. Scope explanations        — see `./scope-explain.js`
 *   4. Safe-default policies     — see `./policy-presets.js`
 *   5. Backend read/write        — HTTP / UI wire these primitives; the
 *                                  primitive layer is the testable core.
 *   6. Interrupted / reauth tests — covered in the per-module tests.
 *
 * The package is the seam between the control-plane / UI and the
 * FAG-25 connector gateway, the FAG-24 policy engine, and the
 * FAG-6 capability broker. It owns no I/O of its own; everything
 * is pure data + state-machine transitions, easy to test.
 */
export * from './state-machine.js';
export * from './account-link.js';
export * from './policy-presets.js';
export * from './scope-explain.js';
