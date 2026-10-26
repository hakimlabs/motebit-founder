---
"@motebit/runtime": patch
---

`ConversationManager.trimmed()` budgets history by the provider's current model through `historyTokenBudget` (read per call, so a model switch applies on the next turn) instead of the flat `CONVERSATION_BUDGET` of 8,000 tokens. `maxConversationHistory` defaults to 100 messages, up from 40, which leaves headroom under Motebit Cloud's 200-message request limit for the current message and the turn's tool rounds. `summarizeAndStore` passes the summarizer only the newest messages within the model's budget; older ones are already in the stored summary it also receives.
