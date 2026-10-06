# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.66  
**Cognitive Core:** 0.10.0

## Closed stage: Unfinished Task Recovery

Sayuri can now recover work by **project**, without already knowing the task ID.

Recovery inspects the durable project registry and the underlying task snapshot.
It repairs stale terminal index entries, advances only safe pre-execution states
through explicit lifecycle transitions, and resumes a primary session for the
first real unfinished task.

Waiting states are intentionally different:

- `waiting-user` is surfaced and remains paused until a
  `user-confirmed` trigger is supplied.
- `waiting-external` remains paused until an `external-ready` trigger is
  supplied.
- a controller in either waiting state denies even read-only tool execution.

This prevents "restart" from silently becoming permission to continue work.

## NEXT_ACTION

**Add a project Goal Manager that persists long-term goals, links goals to task
IDs, chooses the next eligible goal without LLM authority, and creates planner
input for a new task only when no unfinished task should resume.**
