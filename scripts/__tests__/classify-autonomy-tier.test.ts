/**
 * classify-autonomy-tier — adversarial fixtures on BOTH sides of the T0/T1
 * boundary (docs/proposals/repo-autonomy-v1.md, "Founder actions to adopt"
 * step 2), judged against the committed `.github/CODEOWNERS`.
 *
 * Must be T1: every rule in RULES has at least one fixture that fires it, and
 * every category (codeowners, exclusions 1–5, fail-closed) is covered — so a
 * rule cannot be added without a fixture proving it sends a diff to T1.
 * Must stay T0: a docs-only change, a presentation-only UI change, and the
 * other ordinary changes autonomy exists for.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  RULES,
  classifyDiff,
  classifyRevisions,
  importSpecifiers,
  main,
  parseUnifiedDiff,
  readWorkspacePackages,
  type Classification,
  type RuleCategory,
  type RuleId,
} from "../classify-autonomy-tier.js";
import { ownersOf, parseCodeowners } from "../lib/codeowners.js";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = resolve(__dirname, "..", "..");
const CODEOWNERS = readFileSync(resolve(ROOT, ".github/CODEOWNERS"), "utf-8");
const WORKSPACE = readWorkspacePackages(ROOT);

// ── Diff builders (valid git unified diffs) ──────────────────────────────────

function modify(
  path: string,
  removed: string[],
  added: string[],
  context: string[] = ["// context"],
): string {
  const n = context.length + removed.length;
  const m = context.length + added.length;
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${n} +1,${m} @@`,
    ...context.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function add(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function del(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    "index 2222222..0000000",
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
    "",
  ].join("\n");
}

interface Files {
  base?: Record<string, string>;
  head?: Record<string, string>;
}

function classify(diff: string, files: Files = {}, codeowners = CODEOWNERS): Classification {
  return classifyDiff({
    diff,
    codeowners,
    workspacePackages: WORKSPACE,
    readFile: (rev, path) => (rev === "base" ? files.base : files.head)?.[path] ?? null,
  });
}

const fired = (c: Classification): Set<RuleId> => new Set(c.firings.map((f) => f.rule));

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  diff: string;
  files?: Files;
  codeowners?: string;
  /** Rules that MUST be among the firings (T1 fixtures). */
  expect: RuleId[];
}

const RELAY_TEST = "services/relay/src/__tests__/fees.test.ts";
const RELAY_TEST_SRC = [
  `import { computeFee } from "../fees.js";`,
  `import { describe, expect, it } from "vitest";`,
  `describe("fees", () => {`,
  `  it("takes 5%", () => {`,
  `    expect(computeFee(1_000_000)).toBe(50_000);`,
  `    expect(computeFee(0)).toBe(0);`,
  `  });`,
  `});`,
].join("\n");

const WEB_TEST = "apps/web/src/ui/__tests__/chat-format.test.ts";
const WEB_TEST_SRC = [
  `import { formatChat } from "../chat.js";`,
  `import { expect, it } from "vitest";`,
  `it("formats", () => {`,
  `  expect(formatChat("a")).toBe("a");`,
  `  expect(formatChat("")).toBe("");`,
  `});`,
].join("\n");

const WEB_PKG_BASE = JSON.stringify(
  { name: "@motebit/web", description: "web", dependencies: { zod: "3.23.8" } },
  null,
  2,
);

export const MUST_T1: Fixture[] = [
  // Design list: a weakened relay money-path test (assertion removed; .skip added).
  {
    name: "relay money-path test: assertion removed",
    diff: modify(
      RELAY_TEST,
      ["    expect(computeFee(0)).toBe(0);"],
      [],
      [`  it("takes 5%", () => {`],
    ),
    files: {
      head: { [RELAY_TEST]: RELAY_TEST_SRC.replace("    expect(computeFee(0)).toBe(0);\n", "") },
    },
    expect: ["test-assertion-loss", "owned-subject"],
  },
  {
    name: "relay money-path test: .skip added",
    diff: modify(RELAY_TEST, [`  it("takes 5%", () => {`], [`  it.skip("takes 5%", () => {`]),
    files: { head: { [RELAY_TEST]: RELAY_TEST_SRC.replace(`it("takes`, `it.skip("takes`) } },
    expect: ["test-skip-added", "owned-subject"],
  },
  {
    name: "unowned test: assertion swapped for a no-op (exclusion 5 alone)",
    diff: modify(WEB_TEST, [`  expect(formatChat("")).toBe("");`], [`  formatChat("");`]),
    files: { head: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-assertion-loss"],
  },
  {
    name: "unowned test: it.only added",
    diff: modify(WEB_TEST, [`it("formats", () => {`], [`it.only("formats", () => {`]),
    files: { head: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-skip-added"],
  },
  {
    name: "unowned test: it.fails / skipIf / xit added",
    diff: modify(
      WEB_TEST,
      [],
      [`it.fails("x", () => {});`, `it.skipIf(true)("y", () => {});`, `xit("z", () => {});`],
    ),
    files: { head: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-skip-added"],
  },
  {
    name: "unowned test: timeout raised",
    diff: modify(WEB_TEST, ["}, 5_000);"], ["}, 120_000);"]),
    files: { head: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-timeout-retry"],
  },
  {
    name: "unowned test: retry count raised",
    diff: modify(
      WEB_TEST,
      [`describe("x", { retry: 0 }, () => {`],
      [`describe("x", { retry: 5 }, () => {`],
    ),
    files: { head: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-timeout-retry"],
  },
  {
    name: "test file deleted",
    diff: del(WEB_TEST, WEB_TEST_SRC.split("\n")),
    files: { base: { [WEB_TEST]: WEB_TEST_SRC } },
    expect: ["test-deleted", "deletion"],
  },
  {
    name: "test under an owned package dir (packages/crypto/src/__tests__)",
    diff: modify("packages/crypto/src/__tests__/sign.test.ts", [], ["  expect(1).toBe(1);"]),
    files: {
      head: { "packages/crypto/src/__tests__/sign.test.ts": `import { expect } from "vitest";` },
    },
    expect: ["owned-subject"],
  },
  {
    name: "fixture under an owned package dir",
    diff: modify(
      "packages/verifier/src/__tests__/fixtures/receipt.json",
      ['  "sig": "aa"'],
      ['  "sig": "bb"'],
    ),
    expect: ["owned-subject"],
  },
  {
    name: "unowned-dir test importing a money/identity registry package",
    diff: modify(WEB_TEST, [], ["  expect(2).toBe(2);"]),
    files: {
      head: {
        [WEB_TEST]: `import { SolanaWalletRail } from "@motebit/wallet-solana";\n${WEB_TEST_SRC}`,
      },
    },
    expect: ["owned-subject"],
  },
  {
    name: "test of enforcement code (scripts/lib/tamper-runner)",
    diff: modify("scripts/__tests__/tamper-runner.test.ts", [], ["  expect(x).toBe(1);"]),
    files: {
      head: {
        "scripts/__tests__/tamper-runner.test.ts": `import { runTampers } from "../lib/tamper-runner.js";`,
      },
    },
    expect: ["enforcement-config"],
  },
  // Design list: a workflow edit.
  {
    name: "workflow edit drops a gate",
    diff: modify(
      ".github/workflows/ci.yml",
      ["        run: pnpm check"],
      ["        run: echo skipped"],
    ),
    expect: ["github-config", "codeowners-owned"],
  },
  {
    name: "dependabot config",
    diff: modify(".github/dependabot.yml", ["    interval: daily"], ["    interval: monthly"]),
    expect: ["github-config"],
  },
  // Design list: a loosened dependency range.
  {
    name: "loosened dependency range in an unowned app",
    diff: modify("apps/web/package.json", [`    "zod": "3.23.8"`], [`    "zod": "^3.0.0"`]),
    files: {
      base: { "apps/web/package.json": WEB_PKG_BASE },
      head: { "apps/web/package.json": WEB_PKG_BASE.replace(`"3.23.8"`, `"^3.0.0"`) },
    },
    expect: ["dependency-toolchain"],
  },
  {
    name: "packageManager / scripts field change",
    diff: modify(
      "package.json",
      [`  "packageManager": "pnpm@9.15.0",`],
      [`  "packageManager": "pnpm@9.0.0",`],
    ),
    files: {
      base: { "package.json": `{"packageManager":"pnpm@9.15.0"}` },
      head: { "package.json": `{"packageManager":"pnpm@9.0.0"}` },
    },
    expect: ["dependency-toolchain"],
  },
  {
    name: "lockfile change",
    diff: modify("pnpm-lock.yaml", ["      version: 3.23.8"], ["      version: 3.20.0"]),
    expect: ["dependency-toolchain"],
  },
  {
    name: "node pin change",
    diff: modify(".nvmrc", ["22"], ["20"], []),
    expect: ["dependency-toolchain"],
  },
  {
    name: "Cargo manifest change",
    diff: modify("apps/desktop/src-tauri/Cargo.toml", [`tauri = "2.1"`], [`tauri = "2"`]),
    expect: ["dependency-toolchain"],
  },
  // Design list: a drift-gate config change.
  {
    name: "drift gate weakened (scripts/check-*)",
    diff: modify(
      "scripts/check-deps.ts",
      ["  if (violations.length > 0) process.exit(1);"],
      ["  process.exit(0);"],
    ),
    expect: ["enforcement-config"],
  },
  {
    name: "gate library change (scripts/lib/**)",
    diff: modify("scripts/lib/gate-report.ts", ["  process.exitCode = 1;"], [""]),
    expect: ["enforcement-config"],
  },
  {
    name: "package vitest config lowers coverage thresholds",
    diff: modify("apps/web/vitest.config.ts", ["      lines: 80,"], ["      lines: 10,"]),
    expect: ["enforcement-config"],
  },
  {
    name: "tsconfig loosens strictness",
    diff: modify("apps/web/tsconfig.json", [`    "strict": true,`], [`    "strict": false,`]),
    expect: ["enforcement-config"],
  },
  {
    name: "lint rule loosened",
    diff: modify(
      ".eslintrc.js",
      [`    "no-floating-promises": "error",`],
      [`    "no-floating-promises": "off",`],
    ),
    expect: ["enforcement-config"],
  },
  {
    name: "pre-push hook edited",
    diff: modify(".husky/pre-push", ["pnpm check"], ["true"]),
    expect: ["enforcement-config"],
  },
  {
    name: "turbo pipeline edited",
    diff: modify("turbo.json", [`      "cache": false`], [`      "cache": true`]),
    expect: ["enforcement-config"],
  },
  {
    name: "test setup file can redefine expect",
    diff: modify("apps/web/src/test-setup.ts", [], ["globalThis.expect = () => ({ toBe() {} });"]),
    expect: ["enforcement-config"],
  },
  {
    name: "a T0-looking file carries a lint suppression",
    diff: modify(
      "apps/web/src/ui/chat.ts",
      ["  void send();"],
      ["  // eslint-disable-next-line @typescript-eslint/no-floating-promises", "  send();"],
    ),
    expect: ["check-suppression"],
  },
  {
    name: "a T0-looking file carries @ts-ignore",
    diff: modify(
      "apps/web/src/ui/chat.ts",
      ["  render(x);"],
      ["  // @ts-ignore", "  render(x as never);"],
    ),
    expect: ["check-suppression"],
  },
  // Design list: a rename of an owned file to an unowned path.
  {
    name: "rename of an owned relay money file to an unowned path",
    diff: [
      "diff --git a/services/relay/src/fees.ts b/services/relay/src/util/fees.ts",
      "similarity index 100%",
      "rename from services/relay/src/fees.ts",
      "rename to services/relay/src/util/fees.ts",
      "",
    ].join("\n"),
    expect: ["rename", "codeowners-owned"],
  },
  {
    name: "rename of an unowned doc (fail-closed: a rename is T1)",
    diff: [
      "diff --git a/docs/a.md b/docs/b.md",
      "similarity index 90%",
      "rename from docs/a.md",
      "rename to docs/b.md",
      "index 1111111..2222222 100644",
      "--- a/docs/a.md",
      "+++ b/docs/b.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    expect: ["rename"],
  },
  {
    name: "deleted unowned doc",
    diff: del("docs/old-note.md", ["# old"]),
    expect: ["deletion"],
  },
  // Design list: an unparseable diff.
  { name: "unparseable diff: garbage", diff: "this is not a diff\n", expect: ["unparseable-diff"] },
  {
    name: "unparseable diff: hunk overruns its header",
    diff: [
      "diff --git a/docs/a.md b/docs/a.md",
      "--- a/docs/a.md",
      "+++ b/docs/a.md",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "+c",
      "",
    ].join("\n"),
    expect: ["unparseable-diff"],
  },
  {
    name: "unparseable diff: truncated hunk",
    diff: [
      "diff --git a/docs/a.md b/docs/a.md",
      "--- a/docs/a.md",
      "+++ b/docs/a.md",
      "@@ -1,3 +1,3 @@",
      " a",
      "",
    ].join("\n"),
    expect: ["unparseable-diff"],
  },
  {
    name: "unparseable diff: quoted path",
    diff: [
      `diff --git "a/docs/\\303\\251.md" "b/docs/\\303\\251.md"`,
      `--- "a/docs/\\303\\251.md"`,
      `+++ "b/docs/\\303\\251.md"`,
      "",
    ].join("\n"),
    expect: ["unparseable-diff"],
  },
  { name: "empty diff", diff: "", expect: ["empty-diff"] },
  // Design list: a binary file.
  {
    name: "binary file",
    diff: [
      "diff --git a/apps/web/public/logo.png b/apps/web/public/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/apps/web/public/logo.png and b/apps/web/public/logo.png differ",
      "",
    ].join("\n"),
    expect: ["binary"],
  },
  {
    name: "binary patch",
    diff: [
      "diff --git a/docs/img.bin b/docs/img.bin",
      "new file mode 100644",
      "index 0000000..2222222",
      "GIT binary patch",
      "literal 4",
      "LcmZQzWMT#Y01f~L",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n"),
    expect: ["binary"],
  },
  {
    name: "unrecognised file type",
    diff: modify("apps/web/fly.toml", [`  memory = "512mb"`], [`  memory = "1gb"`]),
    expect: ["unrecognised-type"],
  },
  {
    name: "symlink added",
    diff: [
      "diff --git a/docs/link.md b/docs/link.md",
      "new file mode 120000",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/docs/link.md",
      "@@ -0,0 +1 @@",
      "+../CLAUDE.md",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
    expect: ["symlink"],
  },
  {
    name: "submodule bump",
    diff: [
      "diff --git a/vendor/lib b/vendor/lib",
      "index 1111111..2222222 160000",
      "--- a/vendor/lib",
      "+++ b/vendor/lib",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
      "",
    ].join("\n"),
    expect: ["submodule"],
  },
  {
    name: "content unavailable: package.json with no readable content",
    diff: modify("apps/web/package.json", [`  "description": "a",`], [`  "description": "b",`]),
    expect: ["content-unavailable"],
  },
  {
    name: "content unavailable: test source unreadable",
    diff: modify(WEB_TEST, [], ["  expect(3).toBe(3);"]),
    expect: ["content-unavailable"],
  },
  {
    name: "classifier error: CODEOWNERS it refuses to parse",
    diff: modify("docs/a.md", ["a"], ["b"]),
    codeowners: "!/docs/ @hakimlabs\n",
    expect: ["classifier-error"],
  },
  {
    name: "constitutional file (CODEOWNERS-owned)",
    diff: modify("CLAUDE.md", ["old"], ["new"]),
    expect: ["codeowners-owned"],
  },
  {
    name: "the classifier itself is owned",
    diff: modify("scripts/classify-autonomy-tier.ts", ["  return x;"], ["  return y;"]),
    expect: ["codeowners-owned", "enforcement-config"],
  },
  {
    name: "a T0 file hiding behind a T1 file in the same diff",
    diff:
      modify("docs/a.md", ["a"], ["b"]) +
      modify("services/relay/src/fees.ts", ["  return 5;"], ["  return 0;"]),
    expect: ["codeowners-owned"],
  },
];

const T0_TEST = "apps/web/src/ui/__tests__/chat-format.test.ts";

export const MUST_T0: { name: string; diff: string; files?: Files }[] = [
  // Design list: a docs-only change.
  {
    name: "docs-only change (docs/**/*.md, not owned)",
    diff: modify(
      "docs/doctrine/agent-archetypes.md",
      ["The old sentence."],
      ["The new, clearer sentence."],
    ),
  },
  {
    name: "new doc page",
    diff: add("docs/ops/new-runbook.md", ["# Runbook", "", "Steps."]),
  },
  // Design list: a presentation-only UI change.
  {
    name: "presentation-only UI change in an unowned app file",
    diff: modify(
      "apps/web/src/ui/chat.ts",
      [`  bubble.className = "chat-bubble";`],
      [`  bubble.className = "chat-bubble chat-bubble--calm";`],
    ),
  },
  {
    name: "presentation-only markup / style change",
    diff: modify(
      "apps/web/index.html",
      [`  <div class="rail">`],
      [`  <div class="rail rail--compact">`],
    ),
  },
  {
    name: "a changeset",
    diff: add(".changeset/calm-chat.md", [
      "---",
      `"@motebit/web": patch`,
      "---",
      "",
      "Calmer chat bubbles.",
    ]),
  },
  {
    name: "a strengthened unowned test (assertions added, nothing skipped)",
    diff: modify(T0_TEST, [], [`  expect(formatChat("b")).toBe("b");`]),
    files: { head: { [T0_TEST]: WEB_TEST_SRC } },
  },
  {
    name: "package.json description-only change",
    diff: modify(
      "apps/web/package.json",
      [`  "description": "web",`],
      [`  "description": "the web surface",`],
    ),
    files: {
      base: { "apps/web/package.json": WEB_PKG_BASE },
      head: { "apps/web/package.json": WEB_PKG_BASE.replace(`"web"`, `"the web surface"`) },
    },
  },
  {
    name: "bench prompt data (scripts/bench/**/*.json)",
    diff: modify("scripts/bench/intelligence-parity/prompts.json", [`  "a": 1`], [`  "a": 2`]),
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("must-T1 fixtures", () => {
  for (const f of MUST_T1) {
    it(`T1: ${f.name}`, () => {
      const c = classify(f.diff, f.files, f.codeowners);
      expect(c.tier).toBe("T1");
      const got = fired(c);
      for (const r of f.expect)
        expect([...got], `${f.name}: expected ${r} among ${[...got].join(", ")}`).toContain(r);
    });
  }
});

describe("must-T0 fixtures", () => {
  for (const f of MUST_T0) {
    it(`T0: ${f.name}`, () => {
      const c = classify(f.diff, f.files);
      expect(c.firings, JSON.stringify(c.firings)).toEqual([]);
      expect(c.tier).toBe("T0");
      expect(c.rule).toBeNull();
    });
  }
});

describe("coverage of the rule table", () => {
  it("every rule in RULES has at least one must-T1 fixture that fires it", () => {
    const covered = new Set<RuleId>();
    for (const f of MUST_T1)
      for (const r of fired(classify(f.diff, f.files, f.codeowners))) covered.add(r);
    const missing = (Object.keys(RULES) as RuleId[]).filter((r) => !covered.has(r));
    expect(missing).toEqual([]);
  });

  it("every exclusion category (codeowners, 1–5, fail-closed) has at least one must-T1 fixture", () => {
    const categories: RuleCategory[] = [
      "codeowners",
      "exclusion-1",
      "exclusion-2",
      "exclusion-3",
      "exclusion-4",
      "exclusion-5",
      "fail-closed",
    ];
    const tableCategories = new Set(Object.values(RULES).map((r) => r.category));
    expect([...tableCategories].sort()).toEqual([...categories].sort());
    const covered = new Set<RuleCategory>();
    for (const f of MUST_T1)
      for (const r of fired(classify(f.diff, f.files, f.codeowners)))
        covered.add(RULES[r].category);
    expect([...covered].sort()).toEqual([...categories].sort());
  });

  it("the T1 verdict headlines the most fundamental rule that fired, whatever the diff order", () => {
    const c = classify(
      del("docs/old.md", ["x"]) +
        modify("services/relay/src/fees.ts", ["  return 5;"], ["  return 0;"]),
    );
    expect(c.firings[0]!.rule).toBe("deletion"); // diff order puts the deletion first
    expect(c.rule).toBe("codeowners-owned");
    expect(c.category).toBe("codeowners");
    expect(c.summary).toMatch(
      /^T1 — codeowners-owned \(codeowners\) at services\/relay\/src\/fees\.ts/,
    );
  });
});

describe("the boundary is owned", () => {
  const { rules } = parseCodeowners(CODEOWNERS);
  for (const p of [
    "scripts/classify-autonomy-tier.ts",
    "scripts/autonomy-tier-verdict.ts",
    ".github/workflows/autonomy-tier.yml",
    ".github/CODEOWNERS",
    "scripts/money-identity-path.ts",
    "scripts/lib/codeowners.ts",
  ]) {
    it(`${p} is owned by @hakimlabs`, () => {
      expect(ownersOf(rules, p)).toContain("@hakimlabs");
    });
  }
});

describe("parser", () => {
  it("reads a rename with content changes as both names", () => {
    const [f] = parseUnifiedDiff(
      MUST_T1.find((x) => x.name.startsWith("rename of an unowned doc"))!.diff,
    );
    expect(f).toMatchObject({
      oldPath: "docs/a.md",
      newPath: "docs/b.md",
      renamed: true,
      added: ["new"],
      removed: ["old"],
    });
  });

  it("reads a mode-only change from the diff --git line", () => {
    const [f] = parseUnifiedDiff(
      ["diff --git a/scripts/x.sh b/scripts/x.sh", "old mode 100644", "new mode 100755", ""].join(
        "\n",
      ),
    );
    expect(f).toMatchObject({
      oldPath: "scripts/x.sh",
      newPath: "scripts/x.sh",
      oldMode: "100644",
      newMode: "100755",
    });
  });

  it("reads an empty new file", () => {
    const [f] = parseUnifiedDiff(
      [
        "diff --git a/docs/e.md b/docs/e.md",
        "new file mode 100644",
        "index 0000000..e69de29",
        "",
      ].join("\n"),
    );
    expect(f).toMatchObject({ oldPath: null, newPath: "docs/e.md" });
  });

  it("refuses an unknown extended header", () => {
    expect(() =>
      parseUnifiedDiff(["diff --git a/x.md b/x.md", "weird header", ""].join("\n")),
    ).toThrow(/unrecognised/);
  });

  it("finds every import form a test uses to reach its subject", () => {
    expect(
      importSpecifiers(
        [
          `import { a } from "../a.js";`,
          `import "../side.js";`,
          `const b = await import("../b.js");`,
          `vi.mock("../c.js", () => ({}));`,
          `const d = require("../d.js");`,
          `export { e } from "../e.js";`,
        ].join("\n"),
      ).sort(),
    ).toEqual(["../a.js", "../b.js", "../c.js", "../d.js", "../e.js", "../side.js"]);
  });

  it("finds a test's subject through vi.mock even when it never imports it", () => {
    const p = "services/relay/src/__tests__/mocked.test.ts";
    const c = classify(modify(p, [], ["  expect(1).toBe(1);"]), {
      head: { [p]: `vi.mock("../budget.js", () => ({ check: () => true }));` },
    });
    expect([...fired(c)]).toContain("owned-subject");
  });
});

describe("CLI", () => {
  it("prints a T1 JSON verdict and exits 0 on an unparseable diff (a classification, not an error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "classify-tier-cli-"));
    try {
      const file = join(dir, "x.diff");
      writeFileSync(file, "not a diff\n");
      const writes: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((s: string) => (writes.push(s), true)) as typeof process.stdout.write;
      let code: number;
      try {
        code = main(["--diff", file]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).toBe(0);
      const json = JSON.parse(writes.join("").split("\n")[0]!) as Classification;
      expect(json).toMatchObject({ tier: "T1", rule: "unparseable-diff" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a T1 classifier-error verdict when it cannot run", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (writes.push(s), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = main(["--diff", "/nonexistent/autonomy-tier.diff"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(2);
    expect(JSON.parse(writes.join("").split("\n")[0]!)).toMatchObject({
      tier: "T1",
      rule: "classifier-error",
    });
  });
});

describe("against a real git repository (git diff --find-renames base...head)", () => {
  const dir = mkdtempSync(join(tmpdir(), "classify-tier-git-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, env: cleanEnv(), encoding: "utf-8" },
    ).trim();
  const write = (p: string, s: string): void => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  };

  git("init", "-q", "-b", "main");
  write("services/relay/src/fees.ts", "export const FEE_BPS = 500;\n".repeat(20));
  write("docs/note.md", "# note\n\nhello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  it("judges a rename of an owned file by both names", () => {
    git("checkout", "-q", "-b", "rename", baseSha);
    mkdirSync(join(dir, "services/relay/src/util"), { recursive: true });
    git("mv", "services/relay/src/fees.ts", "services/relay/src/util/fees.ts");
    git("commit", "-q", "-m", "move");
    const c = classifyRevisions(dir, baseSha, git("rev-parse", "HEAD"));
    expect(c.tier).toBe("T1");
    expect([...fired(c)]).toEqual(expect.arrayContaining(["rename", "codeowners-owned"]));
    expect(
      c.firings.some(
        (f) => f.path === "services/relay/src/fees.ts" && f.rule === "codeowners-owned",
      ),
    ).toBe(true);
  });

  it("passes a docs-only branch as T0", () => {
    git("checkout", "-q", "-b", "docs", baseSha);
    write("docs/note.md", "# note\n\nhello, world\n");
    git("commit", "-q", "-am", "docs");
    const c = classifyRevisions(dir, baseSha, git("rev-parse", "HEAD"));
    expect(c.firings).toEqual([]);
    expect(c.tier).toBe("T0");
  });

  it("fails closed when a revision cannot be resolved", () => {
    const c = classifyRevisions(dir, baseSha, "0".repeat(40));
    expect(c).toMatchObject({ tier: "T1", rule: "unparseable-diff" });
  });
});
