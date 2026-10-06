# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.72  
**Cognitive Core:** 0.16.0

## Closed stage: Completion Gate

Task completion is now a deterministic evidence gate.

A task may leave `checkpointed` only when every plan step is completed or
cancelled. Every completed evidence-bearing step must reference receipts that
exist, belong to the same task and step, succeeded, and include direct evidence.

The controller persists the intermediate `verifying` state before transitioning
to `completed`. If the process stops between those writes, restart recovery can
resume from `verifying` without re-granting execution authority.

Neither Planner output nor model prose can set a task to completed.

## NEXT_ACTION

**Add Goal Success Verification: after a task completes, evaluate the linked
long-term goal from deterministic task status plus explicit success-criteria
evidence; only verified criteria may transition an active goal to completed.**
