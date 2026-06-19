# Durable Control-Plane State

FAG-21 moves the control plane from private in-memory `Map` state to an
injectable repository. The default remains in-memory for tests and simple
embedding, while local development can opt into a file-backed durable store.
The repository boundary is the stable contract for later SQLite and Postgres
adapters.

## Storage Model

`ControlPlaneRepository` stores three record families:

- `sessions`: agent session identity, lifecycle state, creator, input, result,
  terminal reason, and AgentCard identity hash.
- `tasks`: scheduler work items bound to a session and tool call, including
  arguments, capability verification outcome, audit correlation id, attempts,
  lease owner, lease expiry, and terminal result or reason.
- `toolInvocations`: tool gateway records with session id, tool name, input
  arguments, result/error, duration, and gateway correlation id.
- `approvals`: human approval requests bound to a session and optionally a
  task/tool call. Each request carries risk reason, proposed action, source
  evidence, affected resource, timeout, policy rule, audit correlation id,
  decision actor/reason, and lifecycle state.
- `notificationPreferences`: local notification preference rows keyed by
  topic/severity. Phase 0 only supports the `local_dev` channel.
- `notifications`: deduplicated local-dev notification records for approvals,
  failures, policy denials, reauth needs, long-running stalls, and takeover
  requests.

The local backend is `JsonFileControlPlaneRepository`. It writes one JSON
document atomically by writing a temporary file and renaming it into place. This
is intentionally small and dependency-free for development. Production storage
should implement the same repository interface over SQLite first, then Postgres
when workspace-level state needs shared access.

## Scheduler Semantics

Tasks use this lifecycle:

```
queued -> claimed -> completed
                \-> queued    (retry)
                \-> failed    (retry limit reached)
queued/claimed -> cancelled
claimed -> queued            (lease recovery)
```

`enqueueTask` persists the task with `attempt = 0`. `claimTask` selects the
oldest runnable queued task, marks it `claimed`, assigns `claimedBy`, sets
`leaseExpiresAt`, and increments `attempt`. A second worker cannot claim the
same task because only `queued` tasks are claimable.

`heartbeatTask` extends the lease for the current worker only. `recoverStuckTasks`
requeues claimed tasks whose lease has expired; recovery itself does not
increment attempts. The next successful claim increments the attempt because it
represents another execution attempt.

`failTask` requeues a claimed task while `attempt < maxAttempts`, optionally
delaying the next run through `scheduledAt`. When the current attempt reaches
`maxAttempts`, the task becomes terminal `failed`. `cancelTask` marks queued or
claimed work terminal `cancelled`. `completeTask` marks claimed work terminal
`completed` and stores the result.

Every lifecycle transition appends an audit entry. Task audit data includes the
task's `auditCorrelationId`, session id, and resulting state so audit readers can
link enqueue, claim, retry, recovery, cancellation, and completion events.

## Approval and Escalation Semantics

Approvals use this lifecycle:

```
requested -> viewed -> approved -> executed
requested/viewed -> denied
requested/viewed -> edited
requested/viewed -> expired
requested/viewed -> cancelled
requested/viewed -> superseded
executed -> failed
```

The current control-plane implementation writes `requested`, `approved`,
`denied`, `edited`, `expired`, `cancelled`, and `superseded` states; `viewed`,
`executed`, and `failed` are reserved for the UI/runtime handoff that observes
or executes an approved request.

Duplicate active approvals for the same session, task, and policy rule are
superseded when a newer request arrives. This keeps the queue focused on the
latest proposal while preserving the older request in the audit chain.

Every approval request, decision, and expiration appends an audit entry with
`approvalId`, `sessionId`, `taskId`, `toolCallId`, `auditCorrelationId`,
`policyRule`, and `affectedResource`. Escalations add `escalation.request`
entries with the same session/task correlation. This lets audit readers join the
human decision back to the task, tool call, actor, session, and resource.

Terminal task failure automatically creates a `repeated_tool_failure`
escalation approval and a deduplicated `local_dev` notification. Policy denials
can be escalated through the policy-denial API; repeated calls reuse the active
approval and do not emit duplicate notifications.

## HTTP Surface

The local control-plane HTTP server exposes the approval surface for dev/UI
integration:

- `POST /approvals` creates an approval request.
- `GET /approvals` and `GET /approvals/:id` read the queue.
- `POST /approvals/:id/decision` records approve, deny, edit, or cancel.
- `POST /approvals/expire` expires timed-out active requests.
- `POST /tasks/:id/escalate-policy-denial` creates or reuses a policy-denial
  escalation.
- `GET /notifications` reads local-dev notification records.
- `GET /notification-preferences` and `POST /notification-preferences` read and
  set local notification preferences.

## Local Setup

The control-plane server keeps its old in-memory default:

```bash
npm run dev --workspace @fagaos/control-plane-server
```

To persist local sessions, tasks, and tool invocation records across restarts,
set `FAGAOS_CONTROL_PLANE_STATE_FILE`:

```bash
FAGAOS_CONTROL_PLANE_STATE_FILE=.fagaos/control-plane-state.json \
  npm run dev --workspace @fagaos/control-plane-server
```

The directory is created automatically. Do not store secrets in this file; it is
control-plane state, not a vault.
