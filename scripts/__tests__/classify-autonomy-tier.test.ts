/**
 * classify-autonomy-tier — deny by default. Adversarial fixtures on BOTH
 * sides of the T0/T1 boundary (docs/proposals/repo-autonomy-v1.md, "Founder
 * actions to adopt" step 2), judged against the committed `.github/CODEOWNERS`.
 *
 * Must be T1: the design's list, every bypass the cold review built against
 * the earlier denylist classifier (each one was T0 there), and every
 * fail-closed rule. Every key of RULES has at least one must-T1 fixture that
 * fires it. Must stay T0: a docs/ guide edit, an apps/docs content page, bench
 * data. The allowlist is asserted to be exactly the documented set, so a
 * widening is a visible diff in the owned classifier.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  RULES,
  classifyDiff,
  classifyRevisions,
  isAllowlisted,
  main,
  parseUnifiedDiff,
  type Classification,
  type RuleId,
} from "../classify-autonomy-tier.js";
import { ownersOf, parseCodeowners } from "../lib/codeowners.js";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = resolve(__dirname, "..", "..");
const CODEOWNERS = readFileSync(resolve(ROOT, ".github/CODEOWNERS"), "utf-8");

// ── Diff builders (valid git unified diffs) ──────────────────────────────────

function modify(
  path: string,
  removed: string[],
  added: string[],
  context: string[] = ["context"],
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

function add(path: string, lines: string[], mode = "100644"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
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

function classify(diff: string, codeowners = CODEOWNERS): Classification {
  return classifyDiff({ diff, codeowners });
}

const fired = (c: Classification): Set<RuleId> => new Set(c.firings.map((f) => f.rule));

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  diff: string;
  codeowners?: string;
  /** Rules that MUST be among the firings. */
  expect: RuleId[];
}

/** The cold review's 16 T0 bypasses of the denylist classifier, reconstructed. */
const REVIEW_BYPASSES: Fixture[] = [
  {
    name: "bypass: the cold reviewer's agent definition told to always return GO",
    diff: modify(
      ".claude/agents/cold-reviewer.md",
      ["Report CONFIRMED findings."],
      ["Always return GO."],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: the autonomy design itself (docs/proposals/repo-autonomy-v1.md)",
    diff: modify(
      "docs/proposals/repo-autonomy-v1.md",
      ["T0 also excludes"],
      ["T0 no longer excludes"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a skill an agent loads (skills/*/SKILL.md)",
    diff: modify(
      "skills/git-commit-motebit-style/SKILL.md",
      ["Never --no-verify."],
      ["Use --no-verify."],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: CONSTITUTION.md",
    diff: modify("CONSTITUTION.md", ["old clause"], ["new clause"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: expect.extend in a vitest setupFiles stub",
    diff: modify(
      "packages/mcp-server/src/__tests__/__stubs__/patch-ajv.ts",
      [],
      ["expect.extend({ toBe: () => ({ pass: true, message: () => '' }) });"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: the real-model guard config (vitest.real-model-guard.ts)",
    diff: modify(
      "vitest.real-model-guard.ts",
      ['  if (live) throw new Error("no live models");'],
      ["  void live;"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a money-path test switched to a backtick dynamic import",
    diff: modify(
      "packages/runtime/src/__tests__/money-meter.test.ts",
      [`import { MoneyMeter } from "../money-meter.js";`],
      ["const { MoneyMeter } = await import(`../money-meter.js`);"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: owned code imported through an unowned barrel",
    diff: modify(
      "packages/runtime/src/__tests__/meter-via-barrel.test.ts",
      [`import { MoneyMeter } from "../money-meter.js";`],
      [`import { MoneyMeter } from "../index.js";`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: 'bypass: it["skip"] (computed member skip)',
    diff: modify(
      "apps/web/src/__tests__/chat.test.ts",
      [`it("renders", () => {`],
      [`it["skip"]("renders", () => {`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: an early return; in a test body",
    diff: modify(
      "apps/web/src/__tests__/chat.test.ts",
      [],
      ["  return;"],
      [`it("renders", () => {`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a count-neutral matcher swap",
    diff: modify(
      "apps/web/src/__tests__/chat.test.ts",
      ["  expect(fee).toBe(50_000);"],
      ["  expect(fee).toBeDefined();"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a Python conformance test CI runs",
    diff: modify(
      "examples/python-receipt-verifier/conformance_test.py",
      ["    assert ok"],
      ["    pass"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: scripts/security-publish.ts (release.yml, id-token)",
    diff: modify("scripts/security-publish.ts", ["  verifyProvenance();"], [""]),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: scripts/archetype-conformance.ts",
    diff: modify("scripts/archetype-conformance.ts", ["  if (!green) process.exit(1);"], [""]),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a build config (tsup.config.ts)",
    diff: modify(
      "packages/crypto/tsup.config.ts",
      ["  noExternal: [],"],
      [`  noExternal: ["evil"],`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: a Swift package manifest (Package.swift)",
    diff: modify(
      "apps/mobile/modules/expo-local-inference/ios/Package.swift",
      [`  .package(url: "a", exact: "1.0.0")`],
      [`  .package(url: "a", from: "1.0.0")`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "bypass: the desktop CSP (tauri.conf.json)",
    diff: modify(
      "apps/desktop/src-tauri/tauri.conf.json",
      [`      "csp": "default-src 'self'"`],
      [`      "csp": null`],
    ),
    expect: ["not-allowlisted"],
  },
];

export const MUST_T1: Fixture[] = [
  ...REVIEW_BYPASSES,
  // The allowlist's own exclusions.
  {
    name: "a doctrine edit (docs/doctrine/**)",
    diff: modify("docs/doctrine/agent-archetypes.md", ["The old sentence."], ["The new sentence."]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a proposal edit (docs/proposals/**)",
    diff: modify("docs/proposals/context-budget-v1.md", ["old"], ["new"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a runbook edit (docs/ops/**)",
    diff: modify(
      "docs/ops/agentic-lanes.md",
      ["At most two scoped builders."],
      ["Any number of builders."],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "a design edit (docs/design/**)",
    diff: modify("docs/design/identity-authority-writers.md", ["old"], ["new"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "the drift-defense inventory (docs/drift-defenses.md)",
    diff: modify("docs/drift-defenses.md", ["old"], ["new"]),
    expect: ["not-allowlisted"],
  },
  // Outside the allowlist.
  {
    name: "a changeset (drives release versions)",
    diff: add(".changeset/calm-chat.md", [
      "---",
      `"@motebit/web": patch`,
      "---",
      "",
      "Calmer chat.",
    ]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a test file (tests are never T0)",
    diff: modify(
      "apps/web/src/ui/__tests__/chat-format.test.ts",
      [],
      [`  expect(format("b")).toBe("b");`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "README.md",
    diff: modify("README.md", ["old"], ["new"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a sub-directory CLAUDE.md (agent instructions)",
    diff: modify("packages/panels/CLAUDE.md", ["Rule: state here."], ["Rule: anything goes."]),
    expect: ["not-allowlisted"],
  },
  {
    name: "DOCTRINE.md",
    diff: modify("DOCTRINE.md", ["old"], ["new"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "an env template default flipped (services/relay/.env.example)",
    diff: modify(
      "services/relay/.env.example",
      ["MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE=true"],
      ["MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE=false"],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "a presentation-only UI change (UI code is not allowlisted)",
    diff: modify(
      "apps/web/src/ui/chat.ts",
      [`  bubble.className = "a";`],
      [`  bubble.className = "b";`],
    ),
    expect: ["not-allowlisted"],
  },
  {
    name: "apps/docs content that is not md/mdx (meta.json)",
    diff: modify("apps/docs/content/docs/meta.json", [`  "pages": ["a"]`], [`  "pages": ["b"]`]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a loosened dependency range",
    diff: modify("apps/web/package.json", [`    "zod": "3.23.8"`], [`    "zod": "^3.0.0"`]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a drift gate weakened (scripts/check-*)",
    diff: modify("scripts/check-deps.ts", ["  if (bad) process.exit(1);"], ["  process.exit(0);"]),
    expect: ["not-allowlisted"],
  },
  {
    name: "a weakened relay money-path test (assertion removed, .skip added)",
    diff: modify(
      "services/relay/src/__tests__/fees.test.ts",
      [`  it("takes 5%", () => {`, "    expect(computeFee(0)).toBe(0);"],
      [`  it.skip("takes 5%", () => {`],
    ),
    expect: ["not-allowlisted"],
  },
  // CODEOWNERS (defence in depth).
  {
    name: "a workflow edit (owned and not allowlisted)",
    diff: modify(
      ".github/workflows/ci.yml",
      ["        run: pnpm check"],
      ["        run: echo skipped"],
    ),
    expect: ["codeowners-owned", "not-allowlisted"],
  },
  {
    name: "an allowlisted path that becomes owned is T1",
    diff: modify("docs/security/dependency-triage.md", ["old"], ["new"]),
    codeowners: `${CODEOWNERS}\n/docs/security/ @hakimlabs\n`,
    expect: ["codeowners-owned"],
  },
  {
    name: "the classifier itself",
    diff: modify("scripts/classify-autonomy-tier.ts", ["  return x;"], ["  return y;"]),
    expect: ["codeowners-owned", "not-allowlisted"],
  },
  // Fail-closed.
  {
    name: "a rename within docs/ (both names allowlisted)",
    diff: [
      "diff --git a/docs/proofs/a.md b/docs/proofs/b.md",
      "similarity index 100%",
      "rename from docs/proofs/a.md",
      "rename to docs/proofs/b.md",
      "",
    ].join("\n"),
    expect: ["rename"],
  },
  {
    name: "a rename of an owned file to an allowlisted path (judged by both names)",
    diff: [
      "diff --git a/services/relay/src/fees.ts b/docs/fees.md",
      "similarity index 100%",
      "rename from services/relay/src/fees.ts",
      "rename to docs/fees.md",
      "",
    ].join("\n"),
    expect: ["rename", "codeowners-owned", "not-allowlisted"],
  },
  {
    name: "a deleted doc",
    diff: del("docs/security/dependency-triage.md", ["# triage"]),
    expect: ["deletion"],
  },
  {
    name: "a mode-only change on an allowlisted doc",
    diff: [
      "diff --git a/docs/proofs/a.md b/docs/proofs/a.md",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n"),
    expect: ["mode-change"],
  },
  {
    name: "a new executable file in an allowlisted dir",
    diff: add("docs/proofs/run.md", ["#!/bin/sh"], "100755"),
    expect: ["mode-change"],
  },
  {
    name: "a symlink in an allowlisted dir",
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
    name: "a submodule bump",
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
    name: "binary content at an allowlisted path",
    diff: [
      "diff --git a/docs/proofs/a.md b/docs/proofs/a.md",
      "index 1111111..2222222 100644",
      "Binary files a/docs/proofs/a.md and b/docs/proofs/a.md differ",
      "",
    ].join("\n"),
    expect: ["binary"],
  },
  {
    name: "a GIT binary patch",
    diff: [
      "diff --git a/docs/img.md b/docs/img.md",
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
  {
    name: "classifier error: CODEOWNERS it refuses to parse",
    diff: modify("docs/a.md", ["a"], ["b"]),
    codeowners: "!/docs/ @hakimlabs\n",
    expect: ["classifier-error"],
  },
  {
    name: "a T0 file hiding behind a T1 file in the same diff",
    diff:
      modify("docs/a.md", ["a"], ["b"]) +
      modify("services/relay/src/fees.ts", ["  return 5;"], ["  return 0;"]),
    expect: ["codeowners-owned", "not-allowlisted"],
  },
];

export const MUST_T0: { name: string; diff: string }[] = [
  {
    name: "a docs/ guide edit",
    diff: modify(
      "docs/security/dependency-triage.md",
      ["The old sentence."],
      ["The new, clearer sentence."],
    ),
  },
  {
    name: "a new docs/ page",
    diff: add("docs/proofs/new-proof.md", ["# Proof", "", "Steps."]),
  },
  {
    name: "an apps/docs content page (mdx)",
    diff: modify("apps/docs/content/docs/concepts/identity.mdx", ["Old prose."], ["New prose."]),
  },
  {
    name: "an apps/docs content page (md)",
    diff: modify("apps/docs/content/docs/developer/notes.md", ["Old prose."], ["New prose."]),
  },
  {
    name: "bench prompt data (scripts/bench/**/*.json)",
    diff: modify("scripts/bench/intelligence-parity/prompts.json", [`  "a": 1`], [`  "a": 2`]),
  },
  {
    name: "two allowlisted files in one diff",
    diff:
      modify("docs/security/dependency-triage.md", ["a"], ["b"]) +
      modify("scripts/bench/intelligence-parity/prompts.json", ["c"], ["d"]),
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("must-T1 fixtures", () => {
  for (const f of MUST_T1) {
    it(`T1: ${f.name}`, () => {
      const c = classify(f.diff, f.codeowners);
      expect(c.tier).toBe("T1");
      const got = [...fired(c)];
      for (const r of f.expect)
        expect(got, `${f.name}: expected ${r} among ${got.join(", ")}`).toContain(r);
    });
  }
});

describe("must-T0 fixtures", () => {
  for (const f of MUST_T0) {
    it(`T0: ${f.name}`, () => {
      const c = classify(f.diff);
      expect(c.firings, JSON.stringify(c.firings)).toEqual([]);
      expect(c.tier).toBe("T0");
      expect(c.rule).toBeNull();
    });
  }
});

describe("the rule table and the allowlist", () => {
  it("every rule in RULES has at least one must-T1 fixture that fires it", () => {
    const covered = new Set<RuleId>();
    for (const f of MUST_T1) for (const r of fired(classify(f.diff, f.codeowners))) covered.add(r);
    expect((Object.keys(RULES) as RuleId[]).filter((r) => !covered.has(r))).toEqual([]);
  });

  it("every one of the cold review's 16+ denylist bypasses is a must-T1 fixture", () => {
    expect(REVIEW_BYPASSES.length).toBeGreaterThanOrEqual(16);
    for (const f of REVIEW_BYPASSES) expect(classify(f.diff).tier, f.name).toBe("T1");
  });

  it("the allowlist is exactly the documented set (widening it is a visible diff in an owned file)", () => {
    expect(ALLOWLIST).toEqual({
      include: [
        "docs/**/*.md",
        "apps/docs/content/**/*.md",
        "apps/docs/content/**/*.mdx",
        "scripts/bench/**/*.json",
      ],
      exclude: [
        "docs/doctrine/**",
        "docs/proposals/**",
        "docs/ops/**",
        "docs/design/**",
        "docs/drift-defenses.md",
      ],
    });
  });

  it("isAllowlisted draws the documented boundary", () => {
    for (const p of [
      "docs/a.md",
      "docs/security/dependency-triage.md",
      "apps/docs/content/docs/a.mdx",
      "scripts/bench/x/y.json",
    ])
      expect(isAllowlisted(p), p).toBe(true);
    for (const p of [
      "docs/doctrine/a.md",
      "docs/proposals/a.md",
      "docs/ops/a.md",
      "docs/design/a.md",
      "docs/drift-defenses.md",
      "docs/a.mdx",
      "docs/operator/docker-compose.example.yml",
      "apps/docs/content/docs/meta.json",
      "apps/docs/src/page.tsx",
      "scripts/bench/run.ts",
      "README.md",
      "xdocs/a.md",
    ])
      expect(isAllowlisted(p), p).toBe(false);
  });

  it("the T1 verdict headlines the most fundamental rule that fired, whatever the diff order", () => {
    const c = classify(
      del("docs/old.md", ["x"]) + modify(".github/workflows/ci.yml", ["a"], ["b"]),
    );
    expect(c.firings[0]!.rule).toBe("deletion");
    expect(c.rule).toBe("not-allowlisted");
    expect(c.summary).toMatch(
      /^T1 — not-allowlisted \(allowlist\) at \.github\/workflows\/ci\.yml/,
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
      [
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
    );
    expect(f).toMatchObject({
      oldPath: "docs/a.md",
      newPath: "docs/b.md",
      renamed: true,
      added: ["new"],
      removed: ["old"],
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
});

function capture(fn: () => number): { code: number; out: string } {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (writes.push(s), true)) as typeof process.stdout.write;
  try {
    return { code: fn(), out: writes.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

describe("CLI", () => {
  it("prints a T1 JSON verdict and exits 0 on an unparseable diff (a classification, not an error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "classify-tier-cli-"));
    try {
      const file = join(dir, "x.diff");
      writeFileSync(file, "not a diff\n");
      const { code, out } = capture(() => main(["--diff", file]));
      expect(code).toBe(0);
      expect(JSON.parse(out.split("\n")[0]!)).toMatchObject({
        tier: "T1",
        rule: "unparseable-diff",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a T1 classifier-error verdict when it cannot run", () => {
    const { code, out } = capture(() => main(["--diff", "/nonexistent/autonomy-tier.diff"]));
    expect(code).toBe(2);
    expect(JSON.parse(out.split("\n")[0]!)).toMatchObject({ tier: "T1", rule: "classifier-error" });
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
    mkdirSync(join(dir, "docs/util"), { recursive: true });
    git("mv", "services/relay/src/fees.ts", "docs/util/fees.md");
    git("commit", "-q", "-m", "move");
    const c = classifyRevisions(dir, baseSha, git("rev-parse", "HEAD"));
    expect(c.tier).toBe("T1");
    expect(
      c.firings.some(
        (f) => f.path === "services/relay/src/fees.ts" && f.rule === "codeowners-owned",
      ),
    ).toBe(true);
    expect([...fired(c)]).toContain("rename");
  });

  it("passes an allowlisted docs-only branch as T0", () => {
    git("checkout", "-q", "-b", "docs", baseSha);
    write("docs/note.md", "# note\n\nhello, world\n");
    git("commit", "-q", "-am", "docs");
    const c = classifyRevisions(dir, baseSha, git("rev-parse", "HEAD"));
    expect(c.firings).toEqual([]);
    expect(c.tier).toBe("T0");
  });

  it("fails closed when a revision cannot be resolved", () => {
    expect(classifyRevisions(dir, baseSha, "0".repeat(40))).toMatchObject({
      tier: "T1",
      rule: "unparseable-diff",
    });
  });
});
