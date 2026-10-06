# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.73  
**Cognitive Core:** 0.17.0

## Closed stage: Goal Success Verification

Long-term goals can no longer become completed merely because a model says the
work looks finished.

A goal completion evaluation now requires every linked task to exist in the same
project registry and have deterministic lifecycle status `completed`.
Additionally, every textual success criterion must have durable explicit
user-confirmation evidence. Evidence is project/goal/criterion scoped and stored
separately from model output.

Goals with no textual success criteria still require at least one linked,
completed task. Failed, cancelled, waiting, running, or missing tasks keep the
goal active.

Only after the Goal Success Gate passes may the goal transition to
`completed`.

## NEXT_ACTION

**Add a deterministic Task Finalizer that, after the final plan checkpoint,
runs the Completion Gate, updates the project task registry, evaluates the
linked goal through Goal Success Verification, and then asks the work
orchestrator for the next recoverable/eligible unit of work.**
