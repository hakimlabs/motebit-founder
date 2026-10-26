#!/usr/bin/env node
// Tamper check for classify-autonomy-tier.test.ts and autonomy-tier-verdict.test.ts.
//
// Each entry reverts (part of) one rule of the autonomy boundary — an
// allowlist exclusion, a widening of the allowlist, a fail-closed rule, the
// CODEOWNERS defence in depth, or a verdict rule — and names the test
// expected to go red. The shared runner (scripts/lib/tamper-runner.ts)
// applies each tamper in an isolated copy of the tree.
//
//   node scripts/__tests__/autonomy-tier.tampers.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../lib/tamper-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLASSIFIER = "scripts/classify-autonomy-tier.ts";
const VERDICT = "scripts/autonomy-tier-verdict.ts";
const CLASSIFIER_TEST = "scripts/__tests__/classify-autonomy-tier.test.ts";
const VERDICT_TEST = "scripts/__tests__/autonomy-tier-verdict.test.ts";

const T1 = (name) => `must-T1 fixtures T1: ${name}`;
const OFF = (text) => text.replace(/^(\s*(?:else )?)if \(/, "$1if ((false as boolean) && ");
const off = (text, red, test) => ({
  file: test === VERDICT_TEST ? VERDICT : CLASSIFIER,
  text,
  replacement: OFF(text),
  red,
  test,
});
const dropLine = (line) => ({ file: CLASSIFIER, text: `${line}\n`, replacement: "" });

const TAMPERS = [
  // One per allowlist exclusion.
  {
    name: "allowlist: docs/doctrine/** is not excluded",
    ...dropLine('    "docs/doctrine/**",'),
    red: T1("a doctrine edit (docs/doctrine/**)"),
  },
  {
    name: "allowlist: docs/proposals/** is not excluded",
    ...dropLine('    "docs/proposals/**",'),
    red: T1("a proposal edit (docs/proposals/**)"),
  },
  {
    name: "allowlist: docs/ops/** is not excluded",
    ...dropLine('    "docs/ops/**",'),
    red: T1("a runbook edit (docs/ops/**)"),
  },
  {
    name: "allowlist: docs/design/** is not excluded",
    ...dropLine('    "docs/design/**",'),
    red: T1("a design edit (docs/design/**)"),
  },
  {
    name: "allowlist: docs/drift-defenses.md is not excluded",
    ...dropLine('    "docs/drift-defenses.md",'),
    red: T1("the drift-defense inventory (docs/drift-defenses.md)"),
  },
  // Widening.
  {
    name: "allowlist widened to **/*.md (agent instructions become T0)",
    file: CLASSIFIER,
    text: '    "docs/**/*.md",\n',
    replacement: '    "**/*.md",\n',
    red: T1("a sub-directory CLAUDE.md (agent instructions)"),
  },
  {
    name: "allowlist widened to **/*.md (the autonomy design's sibling doctrine root)",
    file: CLASSIFIER,
    text: '    "docs/**/*.md",\n',
    replacement: '    "**/*.md",\n',
    red: T1("DOCTRINE.md"),
  },
  // Fail-closed.
  off('      if (f.renamed) fire("rename"', T1("a rename within docs/ (both names allowlisted)")),
  off('      if (f.newPath === null) fire("deletion"', T1("a deleted doc")),
  off('      if (f.binary) fire("binary"', T1("binary content at an allowlisted path")),
  {
    name: "fail-closed: a mode change is accepted",
    edits: [
      {
        file: CLASSIFIER,
        from: '        else fire("mode-change", label, `file mode ${mode}`);',
        to: "        else void mode;",
      },
      {
        file: CLASSIFIER,
        from: "      if (f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {",
        to: "      if ((false as boolean) && f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) {",
      },
    ],
    red: T1("a mode-only change on an allowlisted doc"),
  },
  off('    if (input.diff.trim() === "") {', T1("empty diff")),
  // Defence in depth.
  off(
    "        if (r && r.owners.length > 0) {",
    T1("an allowlisted path that becomes owned is T1"),
  ),
  // Verdict.
  off(
    '  if (pr.tier !== "T0") {',
    "the named design cases FAILS when motebit-reviewer approved a T1 PR",
    VERDICT_TEST,
  ),
  {
    name: "verdict: an unset kill-switch variable leaves autonomy on",
    file: VERDICT,
    text: '  return value !== "on";',
    replacement: '  return value === "off";',
    red: "the named design cases an unset kill-switch variable engages it (fail closed)",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a stale founder approval carries a later head",
    file: VERDICT,
    text: "login === lower(FOUNDER) && r.commitId === pr.headSha,",
    replacement: "login === lower(FOUNDER),",
    red: "the named design cases a STALE founder approval does not carry a machine-approved T1 head",
    test: VERDICT_TEST,
  },
  {
    // Parenthesized so `last` keeps its narrowing and the edit type-checks.
    name: "verdict: a merge group whose queue ref names an outside PR is accepted",
    file: VERDICT,
    text: "  if (!last || !out.some((c) => c.number === Number(last[1]))) {",
    replacement:
      "  if ((false as boolean) && (!last || !out.some((c) => c.number === Number(last[1])))) {",
    red: "mergeGroupPrs fails closed when the queue ref's PR is not in the group",
    test: VERDICT_TEST,
  },
  off(
    "    if (seen.has(c.number)) {",
    "mergeGroupPrs fails closed when one PR is named on more than one commit",
    VERDICT_TEST,
  ),
];

// Run as a command with a red marker; `-t`, anchored to the exact full name,
// narrows each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name ?? `${t.file === VERDICT ? "verdict" : "classifier"}: ${t.red} — rule removed`,
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      t.test ?? CLASSIFIER_TEST,
      "-t",
      `^${escapeRegExp(t.red)}$`,
    ],
    redMarker: "Test Files  1 failed",
    edits: t.edits ?? [{ file: t.file, from: t.text, to: t.replacement }],
  })),
  { root: ROOT },
);
