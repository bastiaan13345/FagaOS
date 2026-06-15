# Repository, Review, and Release Flow

FagaOS implementation work moves through GitHub pull requests into `main`.
Local-only commits are acceptable while an issue is in progress, but a completed
code change should end with a reviewable PR unless the issue explicitly says the
handoff is local-only.

## Canonical Repository

- GitHub repository: `https://github.com/bastiaan13345/FagaOS.git`
- Trunk branch: `main`
- Local remotes must include the canonical repository as `origin`:

```bash
git remote add origin https://github.com/bastiaan13345/FagaOS.git
git fetch origin main
```

If the local checkout has no remote, create the branch and commit locally, then
report the missing remote as a handoff blocker. Do not mark a code-changing issue
done until the branch is pushed or the blocker is recorded.

## Branch Strategy

Use short issue-keyed branches:

```text
feature/fag-22-repo-pr-packaging
fix/fag-14-audit-remediation
docs/fag-8-phase-0
```

Create feature branches from the latest verified `main` unless the issue names a
dependency branch. If an issue depends on another in-flight branch, state that in
the PR body and merge the dependency first.

## Pull Request Policy

Every PR title or body must contain the routable issue key, for example:

```text
FAG-22: add release flow and deployment packaging
```

Use `Closes FAG-22` in the PR body only when merging the PR should close the
issue automatically. Otherwise use `Refs FAG-22`.

Minimum PR body:

```markdown
## Summary
- What changed

## Verification
- npm run verify

Refs FAG-22
```

Reviews must check the security boundary touched by the change. Audit log,
policy, sandbox/runtime, connector credentials, and control-plane scheduler
changes require at least one Platform and Security review before merge.

## Merge Policy

- `main` stays deployable.
- Use squash merge for feature PRs so each issue lands as one traceable commit.
- Do not merge with failing CI, skipped coverage, or missing packaging
  verification.
- Do not bypass review for security-sensitive paths:
  `packages/core/src/audit/**`, `packages/policy/**`, `packages/runtime/**`,
  `packages/connectors/**`, and `packages/control-plane/**`.
- Dependency branches merge before dependants. If a dependant branch must be
  reviewed early, keep the PR marked as blocked in its description.

## Required Checks

CI runs these checks on pull requests to `main`:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run package:verify
```

`npm run verify` runs the same local gate. The coverage thresholds are defined
in `vitest.config.ts` and documented in `docs/qa-strategy.md`.

`npm run package:verify` rebuilds the TypeScript workspaces and validates the
deployable package manifests for:

- `@fagaos/control-plane-server`
- `@fagaos/runtime`

The verifier fails if a deployable workspace is missing deploy metadata, a built
entrypoint, packaged include paths, or local `@fagaos/*` dependency packages.

## Release Tags

Release tags use this format:

```text
fagaos-vMAJOR.MINOR.PATCH
```

Pre-release tags append the channel:

```text
fagaos-v0.2.0-rc.1
fagaos-v0.2.0-alpha.1
```

Tag only commits on `main` after CI passes. The release note should list merged
issue keys, verification status, and any packaging or deployment caveats.

## Deployment Packaging

Phase 2 packaging remains Node workspace based. There is no bundler step yet:
each deployable surface ships its compiled `dist/` directory and `package.json`
metadata.

Control-plane service:

```bash
npm run package:verify
HOST=127.0.0.1 PORT=8080 node apps/control-plane-server/dist/main.js
```

Runtime package:

```bash
npm run package:verify
node -e "import('./packages/runtime/dist/index.js').then((m) => console.log(m.RUNTIME_NOT_IMPLEMENTED))"
```

Production cloud infrastructure, container images, and release artifact upload
are still out of scope for Phase 2. This flow establishes the local packaging
contract that those later steps will consume.
