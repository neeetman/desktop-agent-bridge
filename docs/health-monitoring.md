# Health monitoring

`bridge_health({app:"all",subscribe:true})` subscribes the calling session to confirmed failure/recovery transitions. `subscribe:false` removes its subscription. Unsubscribed and protected sessions receive no health notifications.

Subscriptions persist across router restarts. Before dispatching a queued health notice, the router rechecks the subscription, protection list and the native thread's archive flag. An archived recipient is unsubscribed automatically; its unsent health notices expire with a recorded reason. Unsubscribing also expires queued health notices and works without a reachable desktop. Already dispatched or unknown outcomes remain recorded and are never replayed by this cleanup. Health notices carry the affected app so a changed app filter also applies to queued notices.

Each app has one probe in flight and at least 30 seconds between probe starts. Manual and background requests share it. A slow app does not delay another app's state update. The service HTTP check (`/health`) has a 10-second budget, followed by a read-only native thread query (`/v1/threads?limit=1`) with a 75-second budget. This leaves room for native adapters' own timeout responses. Ordinary task requests keep their existing budgets; no native writes are retried.

The first or second failed sample produces `status:"degraded"`, without a notification. A failure is confirmed after at least three consecutive failed probes spanning at least 60 seconds from the first failed completion. It produces one failure notice; the next complete successful probe produces one recovery notice. A transient failure followed by success produces neither notice. Failure counts and confirmed state persist across router restarts.

## Reading a result

| Field | Meaning |
|---|---|
| `ok` | Last completed probe result, or `null` before the first result |
| `confirmedOk` | Confirmed notification state; can stay true during a transient failed sample |
| `checking` | A new probe is still running |
| `checkedAt`, `ageMs` | Completion time and age of the last sample |
| `status` | `checking`, `healthy`, `degraded`, or `unhealthy` |
| `failedStep`, `errorCode` | Failing service/native step and its error classification |
| `steps[]` | Routes, budgets, measured elapsed times, and HTTP status when available |
| `policy` | Current budgets, interval, confirmation threshold, and response wait |

The status request waits approximately 2.5 seconds for new probes. If a probe is still running, it returns the most recent sample with `checking:true`. It does not count an in-progress probe as a success. The response is bounded so an old MCP worker's outer 65-second timeout does not expire first. As with all in-process deadlines, a blocked Node event loop or a suspended machine can delay the response itself.

`runtime/router/health-probes.jsonl` records every failed probe and confirmed transition, plus one successful sample per app every five minutes. Failure notices include the failing step, elapsed time, and error code. Treat these as local operational data.

## Diagnosis and validation

A single timeout does not prove a disconnected pipe. Inspect the step, actual duration, prior successful sample, and concurrent machine load before taking action. A successful HTTP check alone does not establish native availability. Unknown builds and protocol errors still require compatibility investigation. Health monitoring itself does not restart desktops, refresh MCP workers, approve permissions, or replay tasks; process recovery remains the supervisor's separate responsibility.

Offline tests cover transient failures, persistent outages/recovery, restart persistence, per-app single-flight requests, response bounds, cancellation, and late completion. An isolated HTTP integration test exercises delayed native reads and HTTP 503 responses without contacting real desktop sessions. The original runtime hotfix also received passive three-app checks and background-cycle observation. That evidence does not establish a full v0.7-to-v0.8 deployment migration; see [migration](migration.md).
