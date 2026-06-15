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
