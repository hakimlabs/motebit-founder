#!/usr/bin/env node
// Tamper check for classify-autonomy-tier.test.ts, autonomy-tier-verdict.test.ts
// and autonomy-tier-workflow.test.ts.
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
const WORKFLOW = ".github/workflows/autonomy-tier.yml";
const WORKFLOW_TEST = "scripts/__tests__/autonomy-tier-workflow.test.ts";

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
  {
    name: "allowlist: docs/operator/** is not excluded",
    ...dropLine('    "docs/operator/**",'),
    red: T1("an operator doc's image pin (docs/operator/self-host.md)"),
  },
  // Agent-instruction exclusions (each also holds under docs/).
  {
    name: "allowlist: **/CLAUDE.md is not excluded",
    ...dropLine('    "**/CLAUDE.md",'),
    red: T1("docs/CLAUDE.md (agent instructions under docs/)"),
  },
  {
    name: "allowlist: **/AGENTS.md is not excluded",
    ...dropLine('    "**/AGENTS.md",'),
    red: T1("docs/AGENTS.md"),
  },
  {
    name: "allowlist: **/.claude/** is not excluded",
    ...dropLine('    "**/.claude/**",'),
    red: T1("docs/.claude/agents/reviewer.md"),
  },
  {
    name: "allowlist: **/SKILL.md is not excluded",
    ...dropLine('    "**/SKILL.md",'),
    red: T1("docs/guides/SKILL.md (a skill outside .claude/)"),
  },
  // Widening.
  {
    name: "allowlist re-admits apps/docs content (mdx)",
    file: CLASSIFIER,
    text: '  include: ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement:
      '  include: ["docs/**/*.md", "apps/docs/content/**/*.mdx", "scripts/bench/*/prompts.json"],',
    red: T1("the docs quickstart's runnable block exfiltrates CI env (check-docs-quickstart-runs)"),
  },
  {
    name: "allowlist re-admits apps/docs content (md)",
    file: CLASSIFIER,
    text: '  include: ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement:
      '  include: ["docs/**/*.md", "apps/docs/content/**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("an apps/docs markdown page (same pipeline as MDX)"),
  },
  {
    name: "allowlist widened to **/*.md (README becomes T0)",
    file: CLASSIFIER,
    text: '  include: ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  include: ["**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("README.md"),
  },
  {
    name: "allowlist widened to **/*.md (DOCTRINE.md becomes T0)",
    file: CLASSIFIER,
    text: '  include: ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  include: ["**/*.md", "scripts/bench/*/prompts.json"],',
    red: T1("DOCTRINE.md"),
  },
  {
    name: "allowlist widened back to scripts/bench/**/*.json (bench tool config becomes T0)",
    file: CLASSIFIER,
    text: '  include: ["docs/**/*.md", "scripts/bench/*/prompts.json"],',
    replacement: '  include: ["docs/**/*.md", "scripts/bench/**/*.json"],',
    red: T1("bench tool config: package.json (flips the bench's module format)"),
  },
  {
    name: "an include covers a directory named like its file",
    file: CLASSIFIER,
    text: "    src.endsWith(DESCENT_SUFFIX) ? `${src.slice(0, -DESCENT_SUFFIX.length)}$` : src,",
    replacement: "    src,",
    red: T1(
      "a directory named prompts.json (an include names files, never a directory's contents)",
    ),
  },
  {
    name: "allowlist: docs/security/** is not excluded",
    ...dropLine('    "docs/security/**",'),
    red: T1("docs/security/** (the accepted-CVE ledger)"),
  },
  {
    name: "allowlist: **/GEMINI.md is not excluded",
    ...dropLine('    "**/GEMINI.md",'),
    red: T1("docs/GEMINI.md"),
  },
  {
    name: "allowlist: **/CLAUDE.local.md is not excluded",
    ...dropLine('    "**/CLAUDE.local.md",'),
    red: T1("docs/CLAUDE.local.md"),
  },
  {
    name: "allowlist: **/copilot-instructions.md is not excluded",
    ...dropLine('    "**/copilot-instructions.md",'),
    red: T1("docs/copilot-instructions.md"),
  },
  {
    name: "allowlist: **/.agents/** is not excluded",
    ...dropLine('    "**/.agents/**",'),
    red: T1("docs/.agents/x.md"),
  },
  {
    name: "allowlist: **/.cursor/** is not excluded",
    ...dropLine('    "**/.cursor/**",'),
    red: T1("docs/.cursor/rules/x.md"),
  },
  // Case.
  {
    name: "case: exclusions match case-sensitively",
    file: CLASSIFIER,
    text: 'const EXCLUDE_ANY_CASE = EXCLUDE.map((r) => new RegExp(r.source, "i"));',
    replacement: "const EXCLUDE_ANY_CASE = EXCLUDE;",
    red: T1("a lower-case claude.md (exclusions hold whatever the case)"),
  },
  off(
    '        if (collision !== null) fire("case-collision"',
    T1("docs/Proofs/live-sovereign-migration.md (case of a tracked directory)"),
  ),
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
    name: "verdict: any other approval lifts an engaged kill switch (the public-repo bypass)",
    file: VERDICT,
    text: "  if (killSwitchEngaged(autonomyT0)) {",
    replacement:
      "  if (killSwitchEngaged(autonomyT0) && !approved.some(([l]) => l !== lower(MACHINE_REVIEWER))) {",
    red: "the named design cases an outsider's approval beside the machine's does not lift an engaged kill switch",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a founder approval counts whatever its author_association",
    file: VERDICT,
    text: '      r.commitId === pr.headSha &&\n      TRUSTED_ASSOCIATIONS.has(r.association ?? ""),',
    replacement: "      r.commitId === pr.headSha,",
    red: "the named design cases a founder-login approval without a trusted association does not count",
    test: VERDICT_TEST,
  },
  {
    name: "verdict: a later machine review un-binds an earlier machine approval",
    file: VERDICT,
    text: '    (r) => lower(r.login) === lower(MACHINE_REVIEWER) && r.state === "APPROVED",\n  );',
    replacement:
      '    (r) => lower(r.login) === lower(MACHINE_REVIEWER) && r.state === "APPROVED" && standing.get(lower(MACHINE_REVIEWER)) === r,\n  );',
    red: "the named design cases a machine approval binds for good, even after a later dismissed machine review",
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
    text: "      r.commitId === pr.headSha &&\n      TRUSTED_ASSOCIATIONS",
    replacement: "      TRUSTED_ASSOCIATIONS",
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

  // The trigger defect (#1181, 2026-10-27): a fork PR's pull_request /
  // pull_request_review run gets no repository variables, so the kill switch
  // read '' and could never be off. And the pull_request_target safety rules.
  {
    name: "verdict: a pull_request run is judged again",
    file: VERDICT,
    text: '  if (eventName === "pull_request_target") return "pull-request";',
    replacement:
      '  if (eventName === "pull_request_target" || eventName === "pull_request") return "pull-request";',
    red: "judgedEvent: only events that see the repository variables are judged refuses pull_request and pull_request_review (fork runs carry no variables)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: back on pull_request (fork runs get no variables)",
    file: WORKFLOW,
    text: "  pull_request_target:\n    branches: [main]",
    replacement: "  pull_request:\n    branches: [main]",
    red: "the autonomy-tier workflow's triggers triggers on pull_request_target and merge_group only",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the pull_request_review trigger is back",
    file: WORKFLOW,
    text: "  merge_group:\n    types: [checks_requested]\n",
    replacement:
      "  merge_group:\n    types: [checks_requested]\n  pull_request_review:\n    types: [submitted, edited, dismissed]\n",
    red: "the autonomy-tier workflow's triggers triggers on pull_request_target and merge_group only",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a push is no longer re-judged",
    file: WORKFLOW,
    text: "types: [opened, synchronize, reopened, ready_for_review, edited]",
    replacement: "types: [opened, reopened, ready_for_review, edited]",
    red: "the autonomy-tier workflow's triggers pull_request_target covers every PR-side change into main",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the job is skipped on some event (a skip reports success)",
    file: WORKFLOW,
    text: "    runs-on: ubuntu-latest\n",
    replacement: "    if: github.event_name != 'pull_request_review'\n    runs-on: ubuntu-latest\n",
    red: "the autonomy-tier workflow's triggers is one job named autonomy-tier with no job-level if (a skipped job reports success)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the kill switch is no longer read from the variable",
    file: WORKFLOW,
    text: "          AUTONOMY_T0: ${{ vars.AUTONOMY_T0 }}\n",
    replacement: "          AUTONOMY_T0: on\n",
    red: "the autonomy-tier workflow's triggers reads the kill switch from the repository variable on the verdict step",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the token gains a write scope",
    file: WORKFLOW,
    text: "  pull-requests: read\n",
    replacement: "  pull-requests: read\n  actions: write\n",
    red: "the autonomy-tier workflow's pull_request_target safety has a read-only token: contents and pull-requests read, nothing else, no job override",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a secret is referenced",
    file: WORKFLOW,
    text: "          GH_TOKEN: ${{ github.token }}\n",
    replacement: "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    red: "the autonomy-tier workflow's pull_request_target safety references no secrets",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the head checkout persists the token",
    file: WORKFLOW,
    text: "          path: subject\n          # The three-dot diff needs the merge base; the merge group needs base..head.\n          fetch-depth: 0\n          persist-credentials: false\n",
    replacement:
      "          path: subject\n          # The three-dot diff needs the merge base; the merge group needs base..head.\n          fetch-depth: 0\n          persist-credentials: true\n",
    red: "the autonomy-tier workflow's pull_request_target safety checks out exactly the base and the head, neither persisting credentials",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the trusted checkout is the PR head (the pwn request)",
    file: WORKFLOW,
    text: "|| github.sha }}\n          path: trusted",
    replacement: "|| github.event.pull_request.head.sha }}\n          path: trusted",
    red: "the autonomy-tier workflow's pull_request_target safety the trusted checkout is the base, never the PR head",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: a script runs in the PR head",
    file: WORKFLOW,
    text: "      - name: Install the base's dependencies (uncached)\n        working-directory: trusted\n",
    replacement:
      "      - name: Install the base's dependencies (uncached)\n        working-directory: subject\n",
    red: "the autonomy-tier workflow's pull_request_target safety every run step works in trusted/, never in the PR head",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: an event field is interpolated into the script",
    file: WORKFLOW,
    text: '          --event-name "$GITHUB_EVENT_NAME"\n',
    replacement:
      '          --event-name "$GITHUB_EVENT_NAME" # ${{ github.event.pull_request.title }}\n',
    red: "the autonomy-tier workflow's pull_request_target safety interpolates no expression into a run script (event fields reach it only by file)",
    test: WORKFLOW_TEST,
  },
  {
    name: "workflow: the dependency cache is switched back on",
    file: WORKFLOW,
    text: "          package-manager-cache: false\n",
    replacement: "          package-manager-cache: false\n          cache: pnpm\n",
    red: "the autonomy-tier workflow's pull_request_target safety takes the package manager from the base and keeps the dependency cache off",
    test: WORKFLOW_TEST,
  },
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
