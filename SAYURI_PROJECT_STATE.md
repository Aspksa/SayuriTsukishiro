# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.87  
**Cognitive Core:** 0.29.0

## Closed stage: Foundation Upstream Automation Isolation

The imported Letta runtime still contains upstream release, cross-repository
sync, and external Amelia/Letta agent workflows. They remain as source
references, but they must not acquire authority merely because the code now
lives in the Sayuri repository.

The following workflow jobs are now fail-closed unless
`github.repository == 'letta-ai/letta-code'`:

- `Publish release`;
- `Release Cascade`;
- `Prepare release`;
- `Sync Tools to letta-cloud`;
- the imported `Letta Code` issue/comment agent action;
- the imported Amelia `Code Review` action.

This complements the already isolated Claude, Codex, pi-ai and built-in-skills
watchers. Normal Sayuri CI, packaging checks and runtime smoke tests remain
enabled.

The cognitive-control stack stays at Cognitive Core 0.29.0. The reusable
`SayuriCognitiveControlPanel` still requires an explicit `projectId` and a
`SayuriCognitiveStateClient`; project identity must not be inferred from cwd,
conversation IDs, or agent IDs.

## NEXT_ACTION

**Bind `SayuriCognitiveControlPanel` into the first runtime surface that owns
both an `AppServerClient` and an explicit Sayuri `projectId`; do not infer
project identity from cwd or conversation IDs.**
