# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.65  
**Cognitive Core:** 0.9.0

## Closed stage: Project Task Registry

Durable task state is now indexed by project instead of being discoverable only
when a caller already knows the task ID.

Each registry entry records project, task, plan, agent, conversation, goal,
lifecycle status, revision, checkpoint count, latest checkpoint, and next
action. Terminal tasks remain in history; unfinished-task lookup excludes
completed, failed, and cancelled work.

The primary session wraps its durable state store with the project index. Every
saved task/checkpoint therefore refreshes the project registry, and a resumed
session re-publishes its current durable state to repair a missing/stale index.

Registry files use encoded project IDs, atomic replacement, and cross-process
locks.

## NEXT_ACTION

**Add automatic unfinished-task recovery that selects the latest recoverable
task for a project, distinguishes waiting-user/waiting-external from executable
tasks, and resumes only through explicit lifecycle transitions.**
