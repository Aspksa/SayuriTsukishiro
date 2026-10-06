# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.58  
**Cognitive Core:** 0.2.0  
**Base runtime:** Letta Code 0.34.4

## Current architecture

Sayuri remains a higher-level cognitive and policy layer over the imported
execution runtime. Version 0.1.58 establishes the first real enforcement seam:
the low-level tool manager can now receive a runtime-scoped execution control
without importing Sayuri itself.

```
Planner
  ↓
Sayuri Execution Controller
  ↓
Action Broker
  ↓
Runtime Tool Execution Control
  ↓
built-in / mod / external tool
  ↓
Evidence Receipt
  ↓
Result Verifier
  ↓
Task Checkpoint
```

This keeps the dependency direction correct: the generic runtime exposes an
execution-control interface, while `src/sayuri/` supplies the policy.

## Security changes in 0.1.58

- Default permission mode is now `standard`, not `unrestricted`.
- Spawned subagents now start in `standard` permission mode.
- A higher-level execution controller may fail closed immediately before a real
  tool executes.
- Sayuri read access is automatically allowed only inside its approved
  workspace scope.
- Mutations require an active task, a valid plan step, approved scope, and an
  explicit approval grant.
- A plan step cannot authorize an action with a higher risk than the step
  declared.
- Unknown tools are treated conservatively as external actions.

Existing hard permission checks, workspace/cross-agent guards, hooks, and
sandboxing remain in place. The Action Broker is an additional boundary rather
than a replacement for those controls.

## Evidence and verification

Every controlled execution receives a harness-generated `executionId`.
Successful built-in execution produces direct evidence. Mod and external tool
results are marked reported evidence because returning successfully is not
always proof that a detached or remote side effect completed.

The Result Verifier refuses to verify a tool call with missing, failed, denied,
or insufficient-trust evidence. A verified direct tool execution can be turned
into a Task Lifecycle checkpoint containing the exact receipt IDs that justified
the checkpoint.

## Model policy

The only intended external LLM route remains:

- provider: **Cloud.ru**
- model: **DeepSeek-V4-Flash**
- automatic model/provider fallback: **disabled**

The imported provider catalog remains untouched until the Model Gateway is wired
into the primary turn path.

## Next stage

1. Persist receipts and task/checkpoint state across restarts.
2. Connect the primary Sayuri turn lifecycle to
   `SayuriExecutionController`.
3. Feed existing approval results into planned tool authorizations.
4. Route Cloud.ru/DeepSeek-V4-Flash through `ModelGateway`.
5. Make the Sayuri shell workspace sandbox default-on where the OS supports it.

Mass renaming of Letta internals remains intentionally deferred until each
runtime boundary is owned by Sayuri and protected by tests.
