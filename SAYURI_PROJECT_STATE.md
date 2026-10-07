# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.85  
**Cognitive Core:** 0.28.0

## Closed stage: Cognitive Control Client Cache

Sayuri now has a reusable client-side state projection above the raw
`AppServerClient`.

`SayuriCognitiveStateClient` keeps one sanitized snapshot per project,
shares one remote WebSocket subscription across local UI listeners, fans out
coalesced `sayuri_state_update` messages, supports explicit refresh, and
reference-counts remote unsubscribe.

The client also exposes only semantic mutations: revision-guarded task
confirmation and the typed cancellation target union. It does not provide a
generic lifecycle/status write API.

This keeps the next UI layer presentation-only: Ink components can observe a
stable project snapshot instead of owning WebSocket protocol state.

## NEXT_ACTION

**Add the Ink/TUI Cognitive Control panel that binds to
`SayuriCognitiveStateClient`, shows active task/plan/background/cron state,
and exposes only revision-guarded confirm/cancel actions.**
