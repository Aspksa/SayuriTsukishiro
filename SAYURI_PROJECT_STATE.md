# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.77  
**Cognitive Core:** 0.20.0

## Closed stage: Plan Step Intent & Retry Enforcement

Tool execution can no longer advance a plan merely because the tool is broadly
read-only or because a matching mutation exists somewhere later in the plan.

An execution receipt is bound to a plan step only when the step is currently
`in-progress` and names the exact tool being executed. Unrelated reads remain
available as harmless exploratory actions inside scope, but they are unbound and
cannot checkpoint or complete planned work.

Human approval bridging is now restricted to exactly one active planned tool
step. Pending/future mutation steps cannot consume an approval early, and every
mutating retry needs a fresh one-shot approval.

Step failures also have deterministic retry budgets by risk. Repeated direct
errors eventually transition the task to `failed`, persist that state, and
block further execution. A later task for the same long-term goal may succeed:
historical failed/cancelled task attempts no longer permanently prevent goal
success, provided at least one linked task completes successfully.

Strict optional-time propagation in recovery/orchestration/finalization was also
normalized so callers never pass an implicit undefined timestamp into lifecycle
transitions.

## NEXT_ACTION

**Add subagent capability leases: each child agent is bound to one parent
task/plan step, receives only an explicit read-only or narrowly approved tool
set, cannot mutate parent lifecycle/goal state, and must return evidence
receipts to the parent verifier.**
