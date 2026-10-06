# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.59  
**Cognitive Core:** 0.3.0  
**Base runtime:** Letta Code 0.34.4

## Current architecture

Version 0.1.59 adds durable state below the cognitive lifecycle without putting
mutable execution authority into the LLM.

```
Goal / Task / Plan
        ↓
Sayuri Execution Controller
        ↓
Action Broker
        ↓
Runtime tool boundary
        ↓
Execution receipt
        ↓
Evidence Ledger
        ↓
Durable Brain State
        ↓
Result Verifier
        ↓
Checkpoint / Resume
```

## Durable Brain State

The file-backed state store persists:

- task lifecycle snapshot;
- validated plan snapshot;
- append-only evidence receipts;
- checkpoint state;
- execution-to-tool-call evidence correlation.

Writes use atomic snapshot replacement and a cross-process lock. Task IDs are
encoded before becoming path segments, so a model- or user-supplied task ID
cannot escape the Sayuri state directory.

The default state root is `~/.sayuri/state`. It can be overridden with
`SAYURI_STATE_DIR`; callers may also inject an explicit store root.

## Recovery policy

A restarted Sayuri process can load the task, plan, receipts, restore evidence
correlation, verify an already completed tool execution, and continue from a
checkpoint.

**Approval grants are deliberately not persisted.** A mutation that was approved
before a process restart does not inherit that approval after restart. Sayuri
must obtain a live approval again before a new mutating tool call.

This separates durable knowledge ("what happened") from ephemeral authority
("what may happen now").

## Security invariants

- default permission mode: `standard`;
- subagent permission mode: `standard`;
- read access is restricted to approved scope;
- mutation requires task + plan + scope + live approval;
- Action Broker is additive to existing runtime permission and sandbox guards;
- missing or corrupt evidence does not become a successful checkpoint;
- evidence persistence failure is surfaced rather than silently claiming
  success.

## Model policy

The only intended external LLM route remains:

- provider: **Cloud.ru**
- model: **DeepSeek-V4-Flash**
- automatic provider/model fallback: **disabled**

The imported provider catalog is still present underneath and is not yet the
authority for Sayuri.

## Next stage

1. Bind durable Sayuri sessions to the primary chat/turn lifecycle.
2. Bridge existing approval UI responses into one-shot Sayuri authorizations.
3. Wire Cloud.ru/DeepSeek-V4-Flash into the Model Gateway.
4. Make workspace sandboxing default-on for Sayuri shell execution.
5. Add project-scoped goal recovery and unfinished-task resume.

Mass renaming of imported Letta internals remains deferred. We keep replacing
authority boundaries first, then branding and compatibility layers later.
