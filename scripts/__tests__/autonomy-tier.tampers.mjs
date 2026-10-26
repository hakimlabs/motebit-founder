#!/usr/bin/env node
// Tamper check for classify-autonomy-tier.test.ts and autonomy-tier-verdict.test.ts.
//
// Each entry reverts (part of) one rule of the autonomy boundary and names the
// test expected to go red. The shared runner (scripts/lib/tamper-runner.ts)
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

const TAMPERS = [
  {
    // The owned-ancestor rule and the subject-by-name rule overlap for every
    // carve-out CODEOWNERS has today (`__tests__/`, `*.test.ts`), so either
    // one alone still catches the fixture; both are removed together.
    name: "exclusion 1: a test under an owned directory is not caught",
    edits: [
      {
        file: CLASSIFIER,
        from: "        if (anc !== null) fire(",
        to: "        if ((false as boolean) && anc !== null) fire(",
      },
      {
        file: CLASSIFIER,
        from: "          if (subj !== p) {",
        to: "          if ((false as boolean) && subj !== p) {",
      },
    ],
    red: T1("fixture under an owned package dir"),
  },
  {
    name: "exclusion 1: a test's relative imports are not resolved",
    file: CLASSIFIER,
    text: '              if (spec.startsWith(".")) {',
    replacement: '              if ((false as boolean) && spec.startsWith(".")) {',
    red: "parser finds a test's subject through vi.mock even when it never imports it",
  },
  {
    name: "exclusion 2: .github/ is not an exclusion",
    file: CLASSIFIER,
    text: '        if (p.startsWith(".github/")) fire(',
    replacement: '        if ((false as boolean) && p.startsWith(".github/")) fire(',
    red: T1("dependabot config"),
  },
  {
    name: "exclusion 3: package.json dependency fields are not compared",
    file: CLASSIFIER,
    text: "            if (changed.length > 0)\n",
    replacement: "            if ((false as boolean) && changed.length > 0)\n",
    red: T1("loosened dependency range in an unowned app"),
  },
  {
    // The fixture's `.example` extension is unrecognised, so the fail-close
    // would still catch it; the tamper also recognises the extension, which is
    // exactly the later change the explicit rule exists to survive.
    name: "exclusion 3: an env template is T1 only by the unrecognised-extension close",
    edits: [
      {
        file: CLASSIFIER,
        from: '        if (isEnvTemplatePath(p)) fire("env-template"',
        to: '        if ((false as boolean) && isEnvTemplatePath(p)) fire("env-template"',
      },
      { file: CLASSIFIER, from: '  "kt",\n]);', to: '  "kt",\n  "example",\n]);' },
    ],
    red: T1("env template default flipped (services/relay/.env.example)"),
  },
  {
    name: "self-expansion: a sub-directory CLAUDE.md is T0",
    file: CLASSIFIER,
    text: "        if (isAgentInstructionsPath(p))\n",
    replacement: "        if ((false as boolean) && isAgentInstructionsPath(p))\n",
    red: T1("sub-directory CLAUDE.md (packages/panels/CLAUDE.md)"),
  },
  {
    name: "exclusion 4: an added suppression directive is not caught",
    file: CLASSIFIER,
    text: "        if (sup.length > 0)\n",
    replacement: "        if ((false as boolean) && sup.length > 0)\n",
    red: T1("a T0-looking file carries @ts-ignore"),
  },
  {
    name: "exclusion 5: a net assertion loss is not caught",
    file: CLASSIFIER,
    text: "        if (lostAsserts > 0)\n",
    replacement: "        if ((false as boolean) && lostAsserts > 0)\n",
    red: T1("unowned test: assertion swapped for a no-op (exclusion 5 alone)"),
  },
  {
    name: "exclusion 5: a new .only is not caught",
    file: CLASSIFIER,
    text: "        if (skips.length > 0)\n",
    replacement: "        if ((false as boolean) && skips.length > 0)\n",
    red: T1("unowned test: it.only added"),
  },
  {
    name: "fail-closed: a rename is judged by its names only",
    file: CLASSIFIER,
    text: '      if (f.renamed) fire("rename"',
    replacement: '      if ((false as boolean) && f.renamed) fire("rename"',
    red: T1("rename of an unowned doc (fail-closed: a rename is T1)"),
  },
  {
    name: "fail-closed: binary content is accepted",
    file: CLASSIFIER,
    text: '      if (f.binary) fire("binary"',
    replacement: '      if ((false as boolean) && f.binary) fire("binary"',
    red: T1("binary file"),
  },
  {
    name: "verdict: a machine approval of a T1 PR passes",
    file: VERDICT,
    text: '  if (pr.tier !== "T0") {',
    replacement: '  if ((false as boolean) && pr.tier !== "T0") {',
    red: "the named design cases FAILS when motebit-reviewer approved a T1 PR",
    test: VERDICT_TEST,
  },
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
    name: "verdict: a merge group whose queue ref names an outside PR is accepted",
    file: VERDICT,
    text: "  if (!last || !out.some((c) => c.number === Number(last[1]))) {",
    replacement:
      "  if ((false as boolean) && (!last || !out.some((c) => c.number === Number(last[1])))) {",
    red: "mergeGroupPrs fails closed when the queue ref's PR is not in the group",
    test: VERDICT_TEST,
  },
];

// Run as a command with a red marker; `-t`, anchored to the exact full name,
// narrows each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name,
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
