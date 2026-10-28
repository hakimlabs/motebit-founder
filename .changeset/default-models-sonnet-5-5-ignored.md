---
"@motebit/ai-core": patch
---

`modelRejectsSamplingParams` now covers Claude Haiku 5.5, which rejects non-default sampling values and `budget_tokens`, so Haiku 5.5 requests omit `temperature`; extended thinking stays off for Haiku (`modelSupportsExtendedThinking`), so `budget_tokens` is never sent to it. `byok-router` prices the fast tier at Haiku 5.5's list price ($0.10 / $0.50 per MTok). The task router's `strongest` and `fast` tiers for Claude now resolve through the sdk picker (`claude-opus-5-5`, `claude-haiku-5-5`) instead of hard-coded `claude-opus-5` / `claude-haiku-4-5`.
