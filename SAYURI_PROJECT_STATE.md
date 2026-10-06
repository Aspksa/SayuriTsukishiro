# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.75  
**Cognitive Core:** 0.18.0

## Closed stage: Task Finalizer

The final checkpoint can now flow through one deterministic finalization path.

The finalizer runs the task Completion Gate, requires the completed state to be
reflected in the project registry, finds the unique long-term goal linked to the
task, evaluates Goal Success Verification, and then asks the Project Work
Orchestrator for the next recoverable or eligible unit of work.

If all linked tasks are complete but explicit textual success criteria are still
unconfirmed, the goal is moved to `blocked` with an evidence-wait reason. That
prevents the orchestrator from generating duplicate tasks for the same goal.
Blocked goals may still pass Goal Success Verification later after the required
user-confirmation evidence is recorded.

The model still cannot set task status, goal status, or evidence authority.

## NEXT_ACTION

**Build the Cognitive Loop Supervisor: turn verified checkpoints into
deterministic continue/finalize/wait decisions, recover after restart, and keep
one active project task without giving the LLM lifecycle authority.**
