# Sayuri Tsukishiro — Project State

**Sayuri version:** 0.1.62  
**Cognitive Core:** 0.6.0

## Closed stage: Default-on Workspace Sandbox

Sayuri now requests the imported runtime workspace sandbox whenever the host has
a supported kernel backend. The project directory becomes the writable root and
its parent becomes the isolation tree.

If no supported backend exists, Sayuri does not silently grant shell authority:
system-mutation approval bridging remains denied. The imported runtime currently
supports Seatbelt on macOS and bubblewrap on Linux; Windows has no kernel
backend in this codebase yet.

A Bash/exec_command/write_stdin approval is accepted only when the live turn
carries a workspace sandbox whose root matches the Sayuri execution scope.
Tool-call approval remains plan-bound, exact-argument-bound, and one-shot.

## NEXT_ACTION

**Route Cloud.ru DeepSeek-V4-Flash through the Sayuri Model Gateway at the
primary model-resolution boundary, with no provider/model fallback.**
