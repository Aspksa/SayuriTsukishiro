# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.61  
**Cognitive Core:** 0.5.0

## Closed stage: One-shot Approval Bridge

The existing human approval flow now has a generic hook into higher-level
runtime execution control. Sayuri uses it to convert a real human approval into
a narrowly bound one-shot authorization.

```
tool requests mutation
      ↓
existing permission / approval UI
      ↓
human allows
      ↓
RuntimeToolExecutionControl.grantApproval()
      ↓
Sayuri maps toolCallId to one plan step
      ↓
tool name + args + workspace are bound
      ↓
executeTool()
      ↓
Action Broker consumes authorization
      ↓
receipt / verifier
```

## Security properties

- approval does not bypass the plan;
- ambiguous plan-step mapping is denied;
- changed tool name or changed arguments fail the planned check;
- approval can be consumed once only;
- an out-of-scope file mutation is denied;
- replaying the same approved tool call is denied;
- approvals still are not persisted across restarts.

Automatic bridging is intentionally limited to scoped project mutations such as
Write/Edit. Shell/system mutations remain blocked by Sayuri even after a human
approval until the workspace sandbox is made default-on.

## Model policy

Sayuri still targets only **Cloud.ru → DeepSeek-V4-Flash**, with no automatic
fallback to another model.

## NEXT_ACTION

**Make workspace sandboxing default-on for Sayuri shell execution, then allow
system-mutation approval bridging only when the sandbox is active.**
