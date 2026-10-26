/**
 * ConversationManager — the history budget follows the provider's model.
 *
 * Born from the intelligence-parity bench (run 40198849734): a flat 8,000-token
 * budget cut a 7,900-token conversation to ~2,700 tokens on Opus 5.5, so the
 * answer that needed turn 1 scored 4.63 against 9.25 with the full history.
 */

import { describe, expect, it, vi } from "vitest";
import { ConversationManager, type ConversationDeps } from "../conversation.js";
import { DEFAULT_HISTORY_TOKENS, LARGE_WINDOW_HISTORY_TOKENS } from "@motebit/sdk";

const FACT = "My locker code is 4417.";
// ~1,000 characters ≈ 250 estimated tokens per message.
const FILLER = "The quarterly plan covers hiring, budget and the launch. ".repeat(18);

function makeManager(model: string | null): ConversationManager {
  const provider = model == null ? null : ({ model, generate: vi.fn() } as unknown);
  const deps: ConversationDeps = {
    motebitId: "mb-1",
    maxHistory: 200,
    summarizeAfterMessages: 10_000,
    store: null,
    getProvider: () => provider as ReturnType<ConversationDeps["getProvider"]>,
    getTaskRouter: () => null,
    generateCompletion: vi.fn(async () => "title"),
    assertSensitivityPermitsAiCall: () =>
      ({}) as ReturnType<ConversationDeps["assertSensitivityPermitsAiCall"]>,
  };
  const cm = new ConversationManager(deps);
  cm.pushExchange(FACT, "Noted.");
  // 30 more exchanges ≈ 15,000 estimated tokens: over the default budget,
  // well under the large-window one.
  for (let i = 0; i < 30; i++) cm.pushExchange(`${FILLER} (${i})`, `${FILLER} [${i}]`);
  return cm;
}

describe("ConversationManager — history budget by model", () => {
  it("a large-window model keeps the whole conversation, turn 1 included", () => {
    for (const model of ["claude-opus-5-5", "gpt-5.4", "gemini-2.5-pro"]) {
      const out = makeManager(model).trimmed();
      expect(out).toHaveLength(62);
      expect(out[0]!.content).toBe(FACT);
    }
  });

  it("a local model keeps the conservative budget and drops the oldest turns", () => {
    const out = makeManager("qwen3").trimmed();
    expect(out[0]!.content).toMatch(/trimmed for context/);
    expect(out.some((m) => m.content === FACT)).toBe(false);
    const tokens = out.slice(1).reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
    expect(tokens).toBeLessThanOrEqual(DEFAULT_HISTORY_TOKENS);
  });

  it("no provider wired falls back to the conservative budget", () => {
    const out = makeManager(null).trimmed();
    expect(out.some((m) => m.content === FACT)).toBe(false);
  });

  it("the budget is read per call, so a model switch takes effect on the next turn", () => {
    const provider = { model: "qwen3", generate: vi.fn() };
    const cm = new ConversationManager({
      motebitId: "mb-1",
      maxHistory: 200,
      summarizeAfterMessages: 10_000,
      store: null,
      getProvider: () => provider as unknown as ReturnType<ConversationDeps["getProvider"]>,
      getTaskRouter: () => null,
      generateCompletion: vi.fn(async () => "title"),
      assertSensitivityPermitsAiCall: () =>
        ({}) as ReturnType<ConversationDeps["assertSensitivityPermitsAiCall"]>,
    });
    cm.pushExchange(FACT, "Noted.");
    for (let i = 0; i < 30; i++) cm.pushExchange(`${FILLER} (${i})`, `${FILLER} [${i}]`);
    expect(cm.trimmed()[0]!.content).not.toBe(FACT);
    provider.model = "claude-sonnet-5-5";
    expect(cm.trimmed()[0]!.content).toBe(FACT);
    expect(LARGE_WINDOW_HISTORY_TOKENS).toBeGreaterThan(DEFAULT_HISTORY_TOKENS);
  });

  it("a summarization pass carries only the newest messages that fit the budget", async () => {
    const generate = vi.fn(async (pack: { user_message: string }) => ({
      text: "summary",
      confidence: 1,
      memoryCandidates: [],
      stateUpdates: {},
      _input: pack.user_message,
    }));
    const store = {
      createConversation: () => "conv-1",
      appendMessage() {},
      loadMessages: () => [],
      getActiveConversation: () => null,
      updateSummary() {},
      updateTitle() {},
      listConversations: () => [],
      deleteConversation() {},
    };
    const cm = new ConversationManager({
      motebitId: "mb-1",
      maxHistory: 100,
      summarizeAfterMessages: 10_000,
      store: store as unknown as ConversationDeps["store"],
      getProvider: () =>
        ({ model: "qwen3", generate }) as unknown as ReturnType<ConversationDeps["getProvider"]>,
      getTaskRouter: () => null,
      generateCompletion: vi.fn(async () => "title"),
      assertSensitivityPermitsAiCall: () =>
        ({ provider: { model: "qwen3", generate } }) as unknown as ReturnType<
          ConversationDeps["assertSensitivityPermitsAiCall"]
        >,
    });
    cm.pushExchange(FACT, "Noted.");
    for (let i = 0; i < 30; i++) cm.pushExchange(`${FILLER} (${i})`, `${FILLER} [${i}]`);
    await cm.summarize();
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0]![0].user_message;
    expect(input).not.toContain(FACT);
    expect(input).not.toContain("trimmed for context");
    expect(Math.ceil(input.length / 4)).toBeLessThan(DEFAULT_HISTORY_TOKENS + 1_000);
  });
});
