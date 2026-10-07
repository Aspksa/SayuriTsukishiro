# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.84  
**Cognitive Core:** 0.27.0

## Closed stage: WebSocket Cognitive State Subscriptions

The Cognitive Control Plane now supports live project subscriptions in addition
to explicit snapshot reads.

A client subscribes with `sayuri_state_subscribe` and immediately receives a
sanitized project snapshot. Durable task-registry, background-lease, and
cron-intent writes publish project-change signals only after persistence
succeeds. The listener coalesces repeated signals by project and emits the
latest `sayuri_state_update` snapshot to subscribed connections.

Subscriptions reuse the existing listener connection subscription set, so they
survive suspend/resume and are removed with normal connection cleanup. Outbound
state updates use the bounded wire queue and status-frame latest-wins
coalescing.

The typed `AppServerClient` now exposes state read, subscribe, unsubscribe,
and update-observer helpers, so UI code does not need raw WebSocket JSON.

Security boundaries from v0.1.83 remain unchanged: clients still cannot write
arbitrary lifecycle state, approvals, receipts, or goal completion.

## NEXT_ACTION

**Add the Cognitive Control UI projection/client cache: consume
`sayuri_state_subscribe/update`, render active task/plan/background/cron
state, and issue revision-guarded confirm/cancel commands.**
