# Desktop and Browser Bridge PoC

FAG-15 turns the Phase 0 desktop bridge placeholder into an executable local
proof of concept. The package is intentionally deterministic: it models the
session, capability, audit, sandbox, and browser-navigation contracts without
performing real OS-level input injection or launching a production browser
worker.

## Package

The implementation lives in `packages/desktop-bridge` and exports a
transport-neutral `DesktopBridge` interface plus a local deterministic
implementation:

- `LocalDesktopBridge` manages session lifecycle, sandbox directories, timeout
  cleanup, clipboard state, desktop command validation, and browser navigation.
- `CapabilityVerifier` is the authorization hook. FAG-13 can replace the local
  allow-list verifier with the policy engine adapter without changing callers.
- `NetworkPolicy` is deny-by-default. Tests opt in to specific URLs to prove
  the hook is enforced before browser adapter dispatch.
- `BrowserAdapter` isolates browser automation behind the bridge.
  `StubBrowserAdapter` returns deterministic navigation results and is the
  default for local tests. `ChromeDevToolsBrowserAdapter` is the CDP-shaped
  skeleton for future real browser workers.

## Session Boundary

Each bridge session creates a private directory under the configured
`sandboxRoot`:

```text
<sandboxRoot>/<session-id>/
  profile/   # per-session temp browser profile
  drop/      # only supported file ingress/egress channel
```

Callers only receive the profile and drop-folder paths for inspection and local
testing. Bridge file operations resolve paths under `drop/` and reject traversal
outside that folder. Termination and timeout cleanup remove the full
per-session directory.

The PoC does not claim a hard OS sandbox. Production adapters must still run
under the FAG-4 isolation model: separate OS user, constrained desktop session,
portal or native accessibility backend, and explicit human takeover controls.

## Capabilities and Audit

Every bridge action passes through `CapabilityVerifier` before touching session
state or adapters. Denials are recorded in the append-only audit log with a
`deny` outcome and then surfaced as `CapabilityDeniedError`.

Successful actions and boundary denials append `desktopBridge.*` audit events
against the `desktopBridge.session` resource. The PoC uses the existing
`@fagaos/audit-log` core primitive, preserving the hash-chained audit contract.

Current operations:

- `session.create`, `session.inspect`, `session.terminate`
- `screenshot.capture`
- `mouse.click`
- `keyboard.type`
- `clipboard.read`, `clipboard.write`
- `browser.navigate`
- `file.readDrop`, `file.writeDrop`

## Browser Adapter

`navigateBrowser()` validates the session, checks the capability, parses the
URL, asks `NetworkPolicy`, and only then calls `BrowserAdapter.navigate()`.
The stub adapter returns:

```ts
{
  ok: true,
  url,
  title: `Stub page for ${url}`,
}
```

`ChromeDevToolsBrowserAdapter` accepts a transport with a single `send()` method
and currently drives the minimal CDP sequence: `Page.enable`, `Page.navigate`,
and `Runtime.evaluate` for `document.title`. This keeps tests stable while
preserving the future adapter path for Playwright, Chrome DevTools Protocol,
Linux portal, macOS XCTest, Windows UIA, or remote worker implementations.

## Local Run Instructions

Install pinned dependencies:

```bash
npm ci
```

Run the focused bridge suite:

```bash
npm test --workspace @fagaos/desktop-bridge -- packages/desktop-bridge/tests/desktop-bridge.test.ts
```

Run full repository verification:

```bash
npm run verify
```

The focused tests cover session lifecycle, permission denial, audit logging,
deterministic screenshot capture, keyboard and mouse validation, clipboard
round-trip, browser navigation through the stub and CDP skeleton adapters,
deny-by-default network behavior, drop-folder containment, timeout cleanup, and
teardown cleanup.

## Out of Scope

- Real VNC/noVNC streaming.
- Real OS input injection.
- Cloud worker provisioning.
- Human takeover UI.
- Full policy engine integration before FAG-13 lands.
