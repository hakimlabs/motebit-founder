---
"@motebit/sdk": minor
"motebit": patch
---

Long conversations no longer lose their beginning on large-window models. A turn used to carry at most ~7,000 tokens of history whatever the model, so on Claude, GPT or Gemini a conversation a few pages long dropped its first turns: the intelligence-parity bench scored an answer that needed turn 1 at 4.6/10 through motebit against 9.3/10 with the full history. History now gets 64,000 tokens on Anthropic, current OpenAI and Google models and on Motebit Cloud's `auto` (new `historyTokenBudget`, `LARGE_WINDOW_HISTORY_TOKENS`, `DEFAULT_HISTORY_TOKENS` in `@motebit/sdk`), and keeps 8,000 on local servers, other vendors, legacy small-window OpenAI ids and unknown models. The in-memory conversation window grows from 40 to 100 messages, and a summarization pass now carries only the newest messages that fit the same budget.
