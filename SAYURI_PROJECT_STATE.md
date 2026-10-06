# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.64  
**Cognitive Core:** 0.8.0

## Closed stage: Primary Session Bootstrap

Sayuri now has one bootstrap path that assembles the previously separate
safety and cognition components into a primary working session.

Bootstrap order:

```
validate session identity
      ↓
configure Cloud.ru credential/base URL
      ↓
verify exact DeepSeek-V4-Flash model
      ↓
load durable task state
      ├─ exists → resume task/plan/evidence
      └─ absent → create planning → ready → running task
      ↓
bind SayuriExecutionController
      ↓
withSayuriTurnOptions
      ↓
sendMessageStreamWithBackend
```

Every session turn now forces the exact runtime model handle in both the request
surface and the captured runtime model route. A caller attempting to substitute
another model is rejected.

Durable resume does not silently replace the existing task goal or plan.
Cloud.ru credentials remain in the local provider credential store and are not
written into Sayuri task state.

## NEXT_ACTION

**Add a durable project-scoped task registry that indexes active, waiting,
checkpointed, completed, failed, and cancelled Sayuri tasks and can recover
unfinished work by project after restart.**
