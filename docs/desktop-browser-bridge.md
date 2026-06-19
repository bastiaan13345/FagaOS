# Desktop and Browser Bridge Runtime

FAG-26 turns the FAG-15 proof of concept into the first production-capable
desktop/browser bridge boundary. The bridge remains transport-neutral: callers
use one `DesktopBridge` contract while runtime adapters own local OS commands,
browser transports, and optional remote worker leases.

The first supported target set is:

- `linux-x11-cdp` for local Linux hosts using X11 command-line primitives plus
  Chrome DevTools Protocol.
- `macos-xctest-cdp` and `windows-uia-cdp` as explicit adapter targets with the
  same contract. They are not implemented by the default host adapter yet; calls
  fail closed until platform-specific command runners are bound.

This keeps the production path focused on desktop/browser runtime mechanics and
does not expand into product UI or cloud autoscaling.

## Package

The implementation lives in `packages/desktop-bridge` and exports a
transport-neutral `DesktopBridge` interface plus a local deterministic
implementation:

- `LocalDesktopBridge` manages session lifecycle, sandbox directories, timeout
  cleanup, capability checks, audit correlation, desktop command validation,
  drop-folder file exchange, browser navigation, inspection streams, and remote
  worker lease hooks.
- `CapabilityVerifier` is the authorization hook. FAG-13 can replace the local
  allow-list verifier with the policy engine adapter without changing callers.
- `NetworkPolicy` is deny-by-default. Tests opt in to specific URLs to prove
  the hook is enforced before browser adapter dispatch.
- `DesktopRuntimeAdapter` isolates screenshot, mouse, keyboard, and clipboard
  operations. If no adapter is supplied, deterministic local behavior remains
  available in test mode only; production mode fails closed unless runtime
  adapter support is explicitly configured for the requested operation.
- `BrowserAdapter` isolates browser profile lifecycle, navigation, inspection,
  and streaming hooks behind the bridge. Production mode requires an explicit
  browser adapter instead of using the deterministic stub.
- `RemoteWorkerProvisioner` is the lifecycle seam for a future scheduler or
  worker pool. It can provision and release a lease per session, but the bridge
  does not autoscale workers itself.

  `StubBrowserAdapter` returns deterministic navigation results and is the
  default for local tests. `ChromeDevToolsBrowserAdapter` is the CDP-shaped
  skeleton for future real browser workers. Construct `LocalDesktopBridge` with
  `mode: 'production'` for production wiring so missing adapters fail at
  configuration or operation time instead of returning fake-success results.

## Session Boundary

Each bridge session creates a private directory under the configured
`sandboxRoot`:

```text
<sandboxRoot>/<session-id>/
  profile/   # per-session temp browser profile
  drop/      # only supported file ingress/egress channel
```

Callers only receive the profile and drop-folder paths for inspection and local
testing. Bridge file operations resolve paths under `drop/`, reject lexical
traversal, validate real paths for existing files and parent directories, and
open files with no-follow flags so symlink escapes are not treated as valid file
exchange. Termination and timeout cleanup remove the full per-session directory.
Cleanup is best-effort across browser teardown, desktop termination, worker
release, and directory removal: one failing step does not skip the rest.

Runtime adapters must still run under the FAG-4 isolation model: separate OS
user or equivalent worker identity, constrained desktop session, portal or
native accessibility backend, default-deny network policy, and explicit teardown.
The bridge enforces path containment and cleanup; host isolation remains the
adapter or worker supervisor's job.

## Capabilities and Audit

Every bridge action passes through `CapabilityVerifier` before touching session
state or adapters. Operation-specific resource context is forwarded before
dispatch, including coordinates, clipboard/text lengths, requested browser URL
components, drop-file relative paths, and `auditCorrelationId`. That gives
FAG-13 policy code enough context to deny specific resources before network
checks or adapter calls run.

Denials are recorded in the append-only audit log with a `deny` outcome and then
surfaced as `CapabilityDeniedError`.

Successful actions and boundary denials append `desktopBridge.*` audit events
against the `desktopBridge.session` resource. The PoC uses the existing
`@fagaos/audit-log` core primitive, preserving the hash-chained audit contract.

Current operations:

- `session.create`, `session.inspect`, `session.terminate`
- `session.stream.open`
- `screenshot.capture`
- `mouse.click`
- `keyboard.type`
- `clipboard.read`, `clipboard.write`
- `browser.navigate`
- `file.readDrop`, `file.writeDrop`

## Runtime Adapters

`createHostDesktopAdapter({ target: 'linux-x11-cdp', commandRunner })` maps the
first Linux target onto injected host commands:

- screenshot: `import -window root png:-`
- mouse: `xdotool mousemove <x> <y> click <button>`
- keyboard: `xdotool type --clearmodifiers <text>`
- clipboard: `xclip -selection clipboard`

The adapter accepts a command runner instead of spawning processes directly. That
keeps process execution, worker transport, and privilege boundaries outside the
bridge package while still giving production code a real OS-level dispatch path.
Unsupported platform targets return an adapter that fails closed until their
native runners are implemented.

## Browser Runtime

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

Browser adapters may also implement:

- `createSession()` to launch or bind a per-session browser profile.
- `inspectSession()` to expose endpoint/profile/stream availability.
- `openInspectionStream()` to provide a supervised live stream URL.
- `teardownSession()` to close browser processes before the profile directory is
  removed.

Human takeover is represented by inspection and stream hooks only in this
package. Product UI, approval workflows, and operator controls remain deferred to
the supervising layer because FAG-26 is scoped to bridge runtime mechanics.

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
deny-by-default network behavior, drop-folder containment, timeout cleanup,
teardown cleanup, injected desktop runtime dispatch, browser inspection streams,
remote worker provision/release seams, audit correlation propagation, and Linux
host command mapping.

## Out of Scope

- Product UI or human takeover UI.
- Cloud autoscaling or worker pool ownership.
- Direct process spawning inside the bridge package.
- macOS XCTest and Windows UIA command runners until those platform adapters are
  bound.
