# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.86  
**Cognitive Core:** 0.29.0

## Closed stage: Ink Cognitive Control Panel

A reusable Ink/TUI cognitive-control panel now sits above
`SayuriCognitiveStateClient`.

The panel receives an explicit `projectId` and client. It renders the active
task and revision, a bounded projection of plan steps, active background work,
and pending cron intents. It never owns raw WebSocket protocol state.

When focused, the panel exposes only two keyboard actions:
- `c`: confirm a task that is already in `waiting-user`;
- `x`: cancel a nonterminal task.

Both actions use the revision from the rendered snapshot. Terminal tasks expose
neither action. No generic lifecycle/status setter exists in the component.

The panel is intentionally not attached to a global TUI singleton yet: the
current main Ink coordinator does not own an explicit Sayuri project identity
or an `AppServerClient`. Guessing project identity from cwd, agent, or
conversation would create an unsafe hidden binding.

## NEXT_ACTION

**Bind `SayuriCognitiveControlPanel` into the first runtime surface that owns
both an `AppServerClient` and an explicit Sayuri `projectId`; do not infer
project identity from cwd or conversation IDs.**
