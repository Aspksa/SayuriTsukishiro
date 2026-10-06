# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.60  
**Cognitive Core:** 0.4.0  
**Base runtime:** Letta Code 0.34.4

## Closed stage: Turn Execution Context

The primary message boundary can now carry an explicit runtime execution control
into the exact turn-scoped tool snapshot that will later execute tool calls.
No global Sayuri controller is installed: unrelated conversations remain
unaffected.

```
Sayuri controller
      ↓
withSayuriTurnOptions()
      ↓
sendMessageStream
      ↓
PreparedToolExecutionContext
      ↓
captured RuntimeContext
      ↓
tool call execution
```

The captured context includes the conversation, agent, working directory,
`standard` permission mode, and Sayuri's runtime execution control.

## Why the controller is not globally enabled yet

The existing runtime already has a human approval flow. A mutating tool is first
paused for approval and is executed only after the approval decision returns.
Sayuri must consume that existing approval as a one-shot grant before its own
Action Broker sees the real execution. Enabling the controller globally before
that bridge would safely block approved writes, but it would break expected
workflow.

## Durable state invariants retained

- task/plan snapshots survive restarts;
- receipts are append-only and recoverable;
- checkpoints reference verified receipt IDs;
- approval authority is not durable;
- default and subagent permission modes remain `standard`.

## Model policy

Only **Cloud.ru → DeepSeek-V4-Flash** is intended for Sayuri. Automatic LLM
fallback remains disabled.

## NEXT_ACTION

**Bridge an existing human approval decision into a one-shot Sayuri planned
tool authorization before `executeTool` runs.**

This is the single safe next step. After it is tested, the Sayuri controller can
be attached to live mutating turns without bypassing or duplicating the current
approval UI.
