# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.67  
**Cognitive Core:** 0.11.0

## Closed stage: Project Goal Manager

Sayuri now distinguishes long-term project goals from executable tasks.

Goals are durable, project-scoped, priority ordered, dependency aware, and link
to the task IDs created to pursue them. Goal selection is deterministic:
paused, blocked, terminal, or dependency-incomplete goals cannot be selected.

The work selector follows a stronger rule:

```
unfinished task exists?
  yes → resume it
  no  → choose next eligible active goal
           ↓
       create Planner seed
```

This prevents a model from abandoning unfinished work simply because another
goal looks more attractive. The LLM does not choose project priority or
dependency satisfaction.

A planner seed carries only task/project/goal identity, objective, constraints,
and success criteria. It is not an execution plan and grants no permissions.

## NEXT_ACTION

**Build Planner v1 around a strict proposal envelope: DeepSeek-V4-Flash may
propose ordered steps for a planner seed, but deterministic validation assigns
risk/evidence requirements and the LLM never receives execution authority.**
