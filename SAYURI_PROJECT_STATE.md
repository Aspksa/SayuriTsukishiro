# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.63  
**Cognitive Core:** 0.7.0

## Closed stage: Exact Cloud.ru Model Route

Sayuri now owns an exact model route above the imported provider catalog.

The public policy remains **Cloud.ru → DeepSeek-V4-Flash**. At the lower runtime
boundary Cloud.ru is represented by the existing OpenAI-compatible provider and
the exact handle `openai-compatible/DeepSeek-V4-Flash`.

```
Sayuri Model Gateway
      ↓
Cloud.ru credentials + Base URL
      ↓
local provider auth store
      ↓
RuntimeModelRoute (exact)
      ↓
ProviderTurnInput snapshot
      ↓
Pi model resolution
      ↓
DeepSeek-V4-Flash only
```

The turn captures the model route before provider streaming starts, so async
stream iteration cannot lose the routing policy. Exact OpenAI-compatible model
resolution supplies no fallback model ID. If Cloud.ru does not publish
`DeepSeek-V4-Flash` at the configured endpoint, verification fails closed.

API keys are persisted only through the existing local provider credential
store. Sayuri descriptors expose a masked key and project-state files contain no
secret.

The upstream multi-provider catalog remains present for compatibility, but it is
not the authority for Sayuri-controlled turns.

## NEXT_ACTION

**Create a primary Sayuri session bootstrap that configures/verifies Cloud.ru,
creates or resumes durable task state, binds the execution controller, and
starts each turn through `withSayuriTurnOptions`.**
