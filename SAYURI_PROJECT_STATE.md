# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.83  
**Cognitive Core:** 0.26.0

## Closed stage: WebSocket Cognitive Control Plane

Sayuri now exposes a narrow, typed cognitive-control boundary for the UI.

The client may:
- read sanitized project/task/plan/background/cron-intent state;
- explicitly confirm a task that is already in `waiting-user`;
- request semantic cancellation of a task, background lease, or pending cron intent.

The client may **not** directly set lifecycle states, grant tool approvals, write
evidence receipts, or mark goals complete. Task mutations require
`expected_revision`, so stale UI state fails closed instead of overwriting a
newer durable task revision.

Background snapshots omit receipt bodies and expose only the durable receipt ID.
Task cancellation is routed through the lifecycle and cancels active child
background leases before the task snapshot is persisted.

```
UI command
 -> strict protocol validator
 -> semantic cognitive-control operation
 -> domain lifecycle / cancellation function
 -> durable state + task registry
```

## NEXT_ACTION

**Add WebSocket Cognitive State subscriptions: emit sanitized
project/task/background/cron-intent updates after durable mutations so the UI
can stay current without polling.**
