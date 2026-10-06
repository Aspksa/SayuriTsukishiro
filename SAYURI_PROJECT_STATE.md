# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.80  
**Cognitive Core:** 0.23.0

## Closed stage: Durable Background Execution Leases

Background child work now has durable ownership and restart state.

Each record stores the project owner, parent agent/conversation, exact capability
lease, deadline and lifecycle state. Live work transitions
`leased -> running -> completed/failed`; cancellation aborts the live child and
is persisted. Restart recovery never silently duplicates a running child:
non-expired running records become `orphaned`; expired work becomes
`expired`.

Completed work retains its parent-bound result receipt until handoff. Handoff is
idempotent: the parent controller accepts/checkpoints the receipt once, while a
restart after parent persistence but before lease-state persistence can detect
the already-durable receipt/step and finish only the `handed-off` transition.

No background child owns the parent lifecycle. Orphaned work is deliberately not
auto-relaunched yet, because mutation replay without an explicit safety decision
could duplicate side effects.

## NEXT_ACTION

**Add Background Work Supervisor integration: surface
orphaned/completed/expired leases to the cognitive loop, auto-handoff completed
results before new planning, never auto-relaunch orphaned mutations, and only
resume explicitly safe read-only leases.**
