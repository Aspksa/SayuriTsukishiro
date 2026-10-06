# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.81  
**Cognitive Core:** 0.24.0

## Closed stage: Background Work Supervisor

The cognitive loop now reconciles durable background work before continuing
ordinary parent execution.

Completed child work is handed into the parent verifier before a new planner
step can run. Live in-process background work remains `running`; after a real
process restart, a durable running record becomes `orphaned` instead of being
silently duplicated.

Only orphaned read-only work with a durable assignment and a still-valid
deadline can be auto-resumed. Orphaned mutation leases are surfaced as blocked
and require explicit cancellation or a new approved lease. Failed, cancelled
and expired background work also blocks its unresolved parent step instead of
being ignored.

The cognitive loop therefore sees background state as part of task state rather
than an unrelated UI activity.

## NEXT_ACTION

**Add Cron/Background Admission Control: scheduled triggers may create work
intents, but must enter through project goal/task recovery, single-active-task
arbitration, capability leases, and Action Broker; no cron callback may directly
execute mutations.**
