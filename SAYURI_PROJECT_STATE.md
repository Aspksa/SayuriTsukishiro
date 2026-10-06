# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.78  
**Cognitive Core:** 0.21.0

## Closed stage: Subagent Capability Leases

Subagents now have an explicit Sayuri capability boundary instead of inheriting
the parent's effective tool approvals.

A lease is bound to one parent task, one parent plan, one active parent step,
one child identity, one workspace root and one explicit tool set. Read-only
leases can grant only read tools. Scoped mutation leases can grant reads plus
the narrow file mutation family; shell, task/lifecycle and destructive tools
are rejected.

The Letta subagent manager now exposes a restricted launch path that suppresses
parent/session auto-approval inheritance. Sayuri uses that path and forces the
exact `openai-compatible/DeepSeek-V4-Flash` model handle for newly launched
leased children.

A child result is returned with a parent task/step-bound evidence receipt. The
child cannot directly mutate Sayuri task status, long-term goal status, parent
plan status or approval state.

## NEXT_ACTION

**Integrate leased-subagent result receipts into the parent Sayuri Execution
Controller and durable evidence store, so a child may advance only its bound
active parent step; then add durable background execution leases.**
