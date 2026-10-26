# Context budget v1 — the end-game shape (design, founder review)

**Target invariant:** every turn sends the model as much of the conversation as its real window and its payer's spend policy allow, counted in the model's own tokens, without rewriting the start of the request between turns. What no longer fits is folded into a summary in one step, never shaved off a message at a time.

**Degrees of freedom to remove:**

1. The context size a turn may use. Today it's a guess: a vendor table and a 64k constant (the interim fix, below) or a flat 8,000 (before it). It should be a function of the model's window.
2. How tokens are counted. Today `ceil(chars / 4)`. It should be the model's tokenizer, or an estimate calibrated against the provider's own usage report.
3. When history changes. Today a sliding trim drops the oldest message whenever the total crosses the budget, so the request's prefix changes on almost every turn past the limit. It should change only at a compaction, a few times per long conversation.
4. Who owns the spend ceiling. Today it is implied by the context constants and a 100-message cap sized to dodge the proxy's 200-message limit. It should be owned by the lane that pays.

## Why

The intelligence-parity bench (run 40198849734: Opus 5.5, judged by Fable 5.1) measured the cost of the current shape. In the trimming contrast (B″ ↔ B), `longctx-turn1-recall` scored **4.63 with motebit's trimmed history vs 9.25 with the full history**. On that prompt motebit sent about 2,700 of 7,900 tokens to a model with a 1M-token window. Motebit forgot the start of a conversation that claude.ai and ChatGPT would have kept.

The interim fix, `fix(runtime): conversation history is budgeted by the model`, raises the budget to 64k for Anthropic, current OpenAI and Google models and for Cloud `auto`. It also bounds summarization input and sets a 100-message window. That closes the measured gap, but it is not the end-game. Its own review list:

- a magic 64k grouped by vendor;
- `chars / 4`, which is off by 30% or more on code and non-English text;
- a sliding trim that changes the prefix each turn, defeating the prompt cache and invalidating preserved thinking blocks;
- cost policy coupled into context policy by comments.

This document is the path from there. Each increment below is a strict step that nothing later has to undo.

## What a frontier team ships (the pattern, not a guess)

- **The window is a property of the model and is read from the vendor.** Anthropic's `GET /v1/models` returns `max_input_tokens` and `max_tokens` per model. Hard-coding windows is what the catalog-drift gate already refuses to do for model ids.
- **Tokens are counted, not estimated.** Anthropic has `POST /v1/messages/count_tokens`. OpenAI's tokenizers are public. Every response reports `usage.input_tokens`, so any estimator can be calibrated per model against ground truth.
- **History is append-only between compactions.**
  - Prompt caching is a prefix match: any byte change early in the request invalidates everything after it.
  - On Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, thinking blocks are bound to the unedited conversation that produced them. Editing earlier turns invalidates them, and on enforced accounts returns a 400.
  - A sliding trim edits earlier turns every turn.
- **Near the limit, compact once.** Claude Code auto-compacts as the window fills. Anthropic exposes server-side compaction (beta `compact-2026-01-12`, `context_management.edits: [{type: "compact_20260112"}]`, default trigger 150k tokens), which returns a compaction block the client must send back verbatim.
- **Long-term recall is memory, not transcript.** Past the window, facts come back through retrieval. Motebit already has this in the memory graph (`docs/doctrine/memory-architecture.md`).
- **Spend ceilings are billing policy.** They are enforced where the money is: a per-request input cap on a metered token, or a user setting on BYOK. They are not hidden in a context table.

## The end-game shape

### 1. `ModelContextProfile` — the window as a fact

```ts
// @motebit/sdk (Layer 0, pure data + resolver)
interface ModelContextProfile {
  readonly model: string;
  readonly maxInputTokens: number; // the window
  readonly maxOutputTokens: number;
  readonly source: "live" | "snapshot" | "probe" | "default";
}
```

- **Cloud vendors.** A committed snapshot per model id, verified weekly against the vendor's Models API by the existing `check-model-catalog-drift` gate, which today checks only ids. Where a vendor's API doesn't report windows, the snapshot cites the vendor doc and carries a review-by date, the same discipline as `MODEL_DEFAULT_REVIEW_BY`. At runtime a surface may refresh from the live catalog (`discoverModels` already fetches it for `/model`), with the snapshot as the offline fallback.
- **Local servers.** Probe the server: Ollama's `/api/show` reports the model's context length, and `num_ctx` is what it will actually load. Use the smaller of the two. If the probe fails, the conservative default applies (`source: "default"`, 8k).
- **Wiring.** `ProviderCapability.contextWindowTokens` (`@motebit/protocol`, already defined and never populated) is filled from this profile, so routing and admission read the same number.

### 2. One budget equation, in one place

```
available_history = maxInputTokens
                  − reserve_output          (the turn's max_tokens)
                  − system_prompt_tokens
                  − tool_definition_tokens
                  − packed_context_tokens   (memories, state, slab)
                  − current_message_tokens
                  − safety_margin           (tokenizer error bound; 0 when counted exactly)
then  min(available_history, lane_spend_cap)   (§5)
```

- **Admission uses the same equation.** It is commitment 1 of `intelligence-pluggability-contract.md`: if the fixed parts alone exceed the window, the turn is denied honestly before any call. A small local model gets a typed refusal, not a truncated prompt.
- **One computation only.** No other module computes a context size. A drift gate, `check-context-budget-canonical`, refuses a second computation, the same way `check-prompt-budget` holds the system prompt.

### 3. Counted tokens, calibrated

`TokenCounter` is a port with three adapters:

- **exact** — the vendor's count endpoint or a public tokenizer;
- **server** — a local server's tokenize endpoint;
- **calibrated estimate** — `chars × ratio[model]`, where `ratio` starts conservative and is corrected from each response's `usage.input_tokens`.

The calibrated estimate is the default: it costs no extra call and converges within a few turns. The exact counter is used near the compaction threshold, where error matters.

### 4. Append-only history with watermark compaction

Replace the sliding trim with two thresholds over the counted history:

- **Below the high-water mark** (80% of `available_history`), send the conversation exactly as last sent plus the new turn. The prefix is byte-stable, so the prompt cache hits and preserved thinking stays valid.
- **On crossing it, compact once:**
  1. fold the oldest segment into a summary,
  2. bringing the total down to the low-water mark (50%),
  3. keep the newest turns verbatim.

  The prefix changes once and then stays stable for many turns.

The compaction has two adapters behind one port:

- **Provider-native**, where it exists: Anthropic `compact_20260112`. The compaction block is stored and round-tripped verbatim. The adapter is chosen per provider and never assumed.
- **Client-side** everywhere else: the summarizer the runtime already has, fed exactly the segment being folded. That is never more than the low-water distance, so summarization input is bounded by construction, and the interim fix's separate bound disappears.

A compaction is a recorded event, not a silent rewrite. The conversation store gains a `CompactionRecord`:

- the covered message range, by id;
- the summary text, stamped with `derivedSensitivity` over its inputs (today's rule for summaries);
- the counts before and after.

The full transcript stays in the store. Only the provider request changes, so the owner can still read everything, and a summary can be regenerated or audited against the messages it covers.

**Invariants carried through unchanged:**

- **Sensitivity filtering before anything.** `egressHistory()` filters by the send tier before budgeting or compaction, so nothing above the tier is summarized into a request either.
- **Summarization is an AI call.** It goes through `assertSensitivityPermitsAiCall`, as today.
- **Ring 1.** The same runtime on every surface. Only the profile numbers differ.

### 5. Spend ceilings owned by the lane

`ContextSpendPolicy` is a per-request cap on input tokens, set by whoever pays:

- **Motebit Cloud.**
  - The relay mints `max_input_tokens` into the proxy token per funding tier. It's the same mechanism as the token's model list (`MOTEBIT_CLOUD_TOKEN_MODELS`); free credit gets a small cap and deposits a larger one.
  - The proxy enforces it in tokens and replaces the 200-message count limit (`services/proxy/src/validation.ts`) as the binding rule.
  - The client reads the same cap from the token, so the client's budget and the proxy's refusal can never disagree.
- **BYOK.** A user setting, "maximum context per turn", defaulting to the model's full window minus reserves. The user pays and decides. The setting lives in Settings, as configuration.
- **Local.** No spend cap; the window is the limit.

The 100-message window from the interim fix goes away. The in-memory history becomes the store's view of the conversation, and the token budget alone decides what a request carries.

### 6. Past the window: memory

When a conversation outgrows even the compacted window, older facts return through the memory graph's retrieval, as for any past conversation. Compaction summaries are candidate inputs to the consolidation cycle (`runtime.consolidationCycle()`). That makes a long conversation's durable facts memories with `consolidation_derived` provenance, per `memory-provenance.md`, rather than leaving them only in a summary blob.

## Increments (each one ships alone; none is undone later)

| #   | Ships                                                                                                     | Replaces                                                                                 | Proof                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0   | Interim fix (open PR): 64k for large-window vendors, bounded summarization input, 100-message window      | flat 8k                                                                                  | bench `longctx-turn1-recall` A ≈ B                                                                              |
| 1   | `ModelContextProfile` snapshot + local probe; drift gate verifies windows; populate `contextWindowTokens` | the vendor table inside `historyTokenBudget` (its signature stays; it reads the profile) | gate red on a wrong window; profile tests                                                                       |
| 2   | `TokenCounter` port + calibrated estimator + exact adapters                                               | `chars / 4`                                                                              | per-model error vs `usage.input_tokens` ≤ 5% after 3 turns                                                      |
| 3   | The one budget equation + admission + `check-context-budget-canonical`                                    | scattered reserves                                                                       | admission tests; gate                                                                                           |
| 4   | Append-only history + watermark compaction (client-side) + `CompactionRecord`                             | sliding trim; the separate summarization bound                                           | bench: cache-read share on a 30-turn conversation; recall at 50k and 200k tokens                                |
| 5   | Anthropic native compaction adapter                                                                       | client compaction on Anthropic                                                           | same bench, provider route                                                                                      |
| 6   | `ContextSpendPolicy`: Cloud token cap minted per tier, proxy token-based limit, BYOK setting              | the 64k Cloud-cost hedge and the 100-message window                                      | proxy tests; a Cloud turn at the cap is admitted, one over is refused with the same verdict on client and proxy |

The bench grows to carry the proof: long-context prompts at about 50k and 200k tokens, a cache-read-share metric, and cost per completed turn. It is the same harness that found the defect.

## Decisions for the founder

1. **The BYOK default cap.** I recommend the model's full window. It's the user's money, the vendor apps do the same, and caching makes re-sent history cheap.
2. **Cloud per-tier caps**, for example free credit 32k and deposit 200k. These are pricing decisions, so they're yours.
3. **Watermarks** of 80% and 50%. Standard hysteresis; tunable later from the bench.
4. **Provider-native compaction.** Adopt it behind the adapter (Increment 5), even though it's beta. The client-side path stays the fallback, so there's no lock-in.

## Not in scope

- Changing the system prompt's size or content. That has its own budget gate.
- A "lite runtime" for small models. Refused by `intelligence-pluggability-contract.md`: invariants are constant, only budgets adapt.
- Cross-conversation context. That's memory's job.
