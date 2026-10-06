# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.82  
**Cognitive Core:** 0.25.0

## Closed stage: Cron/Background Admission Control

Cron triggers can now enter Sayuri without becoming direct autonomous model
execution.

A generic scheduler admission hook runs before conversation creation and prompt
queueing. Ordinary Letta schedules remain unchanged. A Sayuri-marked schedule is
consumed by a strict machine-readable intent parser and persisted as a durable
project work intent instead of being sent directly to an LLM turn.

Each schedule occurrence has a deterministic intent ID, so duplicate delivery
of the same occurrence is idempotent. Unknown/authority fields are rejected.

The cognitive supervisor admits at most one pending scheduled intent when the
project has no unfinished task. Admission creates a normal long-term goal with
the schedule origin recorded as a constraint. From there the existing flow is
unchanged:

```
cron trigger -> durable work intent -> long-term goal
 -> single-active-task arbitration -> Planner Runtime
 -> Action Broker / evidence / completion gates
```

Cron callbacks therefore never receive mutation authority.

## NEXT_ACTION

**Add the WebSocket Cognitive Control Plane: expose read-only
project/task/plan/background/cron-intent state to the UI, route explicit user
confirmations and cancellations through typed commands, and forbid WebSocket
clients from directly setting lifecycle, approval, receipt, or goal-completion
state.**
