# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.70  
**Cognitive Core:** 0.14.0

## Closed stage: Project Work Orchestrator

Sayuri now has one deterministic entry point for project work.

The orchestrator first attempts durable unfinished-task recovery. Only when no
unfinished task exists does it select the next eligible long-term goal and call
Planner Runtime.

For new work the order is intentionally strict:

```
eligible goal
  ↓
Planner Runtime → strict JSON → deterministic compiled plan
  ↓
persist task as ready
  ↓
link task ID to long-term goal
  ↓
explicit ready → running transition
  ↓
persist again
  ↓
bootstrap primary execution controller
```

If a failure occurs after planning, the ready/running task is already durable
and project-indexed, so restart recovery continues the same task instead of
creating duplicate work.

Planner Runtime is never invoked when unfinished work exists.

## NEXT_ACTION

**Add deterministic Plan Progression: a verified tool result must complete
exactly its bound in-progress step, attach receipt IDs, unlock only
dependency-satisfied next steps, persist the updated plan/task, and never let
the LLM mark work complete.**
