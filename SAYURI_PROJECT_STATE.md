# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.57  
**Cognitive Core:** 0.1.0  
**Base runtime:** Letta Code 0.34.4

## Architectural decision

Sayuri is not a cosmetic fork of Letta. The imported runtime remains the lower
execution layer for proven infrastructure: streaming, MemFS/Git memory storage,
tool execution, permissions, subagents, background tasks, cron, queues,
recovery, and WebSocket turn lifecycle.

The new `src/sayuri/` layer owns product policy and cognition:

```
Sayuri Cognitive Core
  Model Gateway
  Planner contract
  Task Lifecycle
  Action Broker
  Evidence Ledger
  Result Verifier
        |
        v
Letta-derived execution runtime
```

## Model policy

The only external LLM route supported by Sayuri is:

- provider: **Cloud.ru**
- model: **DeepSeek-V4-Flash**
- automatic model/provider fallback: **disabled**

The existing upstream provider catalog is not yet removed because doing so would
unnecessarily destabilize the imported runtime. Sayuri's Model Gateway becomes
the authority above that catalog.

## Completed in 0.1.57 foundation

- Introduced independent Sayuri project/core versioning.
- Added a single-model Model Gateway contract.
- Added an Action Broker policy boundary.
- Added persistent-task lifecycle semantics and checkpoints.
- Added evidence receipt semantics.
- Added a planner validation contract.
- Added a Result Verifier that refuses unsupported completion claims.
- Registered `src/sayuri` tests in the existing CI unit-test discovery.

## Next integration stage

1. Put the Action Broker in front of real mutating tool execution.
2. Remove `unrestricted` as the Sayuri execution default, including subagents.
3. Persist receipts and checkpoints to the existing durable runtime/memory layer.
4. Route Cloud.ru/DeepSeek-V4-Flash through the Model Gateway.
5. Bind Planner → Broker → Tool → Receipt → Verifier into the turn lifecycle.

Do not mass-rename Letta internals yet. Preserve upstream-compatible low-level
runtime code until Sayuri owns each corresponding boundary with tests.
