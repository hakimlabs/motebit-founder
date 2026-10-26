import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_TOKENS,
  LARGE_WINDOW_HISTORY_TOKENS,
  historyTokenBudget,
} from "../models.js";

describe("historyTokenBudget", () => {
  it("gives the large budget to Anthropic, OpenAI and Google ids", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-4-6", "gpt-5.4", "o3", "gemini-2.5-flash"]) {
      expect(historyTokenBudget(m)).toBe(LARGE_WINDOW_HISTORY_TOKENS);
    }
  });

  it("keeps the conservative budget for local, other vendors and unknown ids", () => {
    for (const m of [
      "qwen3",
      "llama3.2:latest",
      "gpt-oss",
      "deepseek-chat",
      "llama-3.3-70b-versatile",
      "mystery-model",
    ]) {
      expect(historyTokenBudget(m)).toBe(DEFAULT_HISTORY_TOKENS);
    }
  });

  it("no model is the conservative budget", () => {
    expect(historyTokenBudget(null)).toBe(DEFAULT_HISTORY_TOKENS);
    expect(historyTokenBudget(undefined)).toBe(DEFAULT_HISTORY_TOKENS);
    expect(historyTokenBudget("  ")).toBe(DEFAULT_HISTORY_TOKENS);
  });

  it("Motebit Cloud auto takes the large budget; legacy small-window OpenAI ids do not", () => {
    expect(historyTokenBudget("auto")).toBe(LARGE_WINDOW_HISTORY_TOKENS);
    for (const m of ["gpt-3.5-turbo", "gpt-4", "gpt-4-0613", "gpt-4-32k"]) {
      expect(historyTokenBudget(m)).toBe(DEFAULT_HISTORY_TOKENS);
    }
    for (const m of ["gpt-4o", "gpt-4.1", "gpt-4o-mini"]) {
      expect(historyTokenBudget(m)).toBe(LARGE_WINDOW_HISTORY_TOKENS);
    }
  });
});
