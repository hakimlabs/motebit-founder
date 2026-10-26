# Repo autonomy (design)

**Target invariant:** the repository keeps evolving while no human is at the keyboard, and **no change to who may act or what money may move** lands without the founder's review. Autonomy is granted the way motebit grants authority: scoped, revocable, and receipted, never inferred.

**Degree of freedom to remove:** today every merge waits for the founder's click, including test, CI and doc changes that `CODEOWNERS` already declares "CI-only". The bottleneck is the approval, not the work.

## What the repo already has

- `main-protection` (ruleset 13909292) requires **one approving review** on every PR, plus **code-owner review where `.github/CODEOWNERS` names an owner**. No bypass actors. Squash merges through the merge queue.
- `.github/CODEOWNERS` lists **only authority paths**: constitutional files, the gates that enforce authority, the money/identity packages, and the authority doors outside `packages/`. It deliberately has no catch-all; docs, UI, tests and tooling are "CI-only". `check-codeowners-authority` derives the required set from `scripts/money-identity-path.ts` and fails if an authority path is unowned.
- Three identities: the worker (model, `Co-Authored-By`), the publisher `motebit-agent` (read-only, opens PRs from the founder fork), and the approver `hakimlabs` (the sole code owner). GitHub forbids approving your own PR, so the publisher can never approve.
- `docs/ops/agentic-lanes.md`: parallelize generation, serialize integration. At most two scoped builders, plus read-only reviewers.

So the tiers already exist. They only lack an approver that is not the founder.

## Design

**T0, autonomous:** a PR whose every changed path is **unowned** in `CODEOWNERS` **and** outside the T0 exclusions below. A new machine user, `motebit-reviewer`, with **write** access (not a code owner, never in `CODEOWNERS`), approves and enqueues it when all of the following hold.

**Unowned is not enough.** `CODEOWNERS` deliberately leaves tests unowned (`**/__tests__/`, `**/*.test.ts`), and it does not own CI, dependency manifests or build tooling. A change to any of those can weaken money-path or identity-path enforcement without touching an owned file. Examples:

- deleting an assertion in `services/relay/src/__tests__/`;
- marking a test `.skip`;
- pinning a dependency to a vulnerable version;
- loosening a lint rule;
- editing a workflow so a gate no longer runs.

So T0 also **excludes** every PR that:

1. **Changes a test or fixture whose subject is an owned path.** A test file under an owned directory, or one that imports from one (resolved by `scripts/money-identity-path.ts`).
2. **Changes `.github/**`.** Workflows, actions, Dependabot config.
3. **Changes dependencies or the toolchain.** Any `package.json` dependency or override field, `pnpm-lock.yaml`, `Cargo.toml`/`Cargo.lock`, `.npmrc`, `.nvmrc`, `packageManager`.
4. **Changes enforcement itself.** `scripts/check-*`, `scripts/lib/**`, hook config (`.husky/**`, lint-staged), lint, type and test configuration (`.eslintrc*`, `tsconfig*.json`, `vitest.config*`, `turbo.json`).
5. **Weakens any test, anywhere.** Mechanically:
   - a net loss of `expect(`/`assert` calls in a changed test file;
   - a new `.skip`, `.only`, `.todo`, `it.fails` or `describe.skip`;
   - a deleted test file;
   - a raised timeout or retry count.

These go to T1. The list is a floor: when in doubt, the classifier says T1.

**Fail-closed rules.** The classifier returns T1, never T0, on any of:

- a renamed path, judged by both its old and its new name;
- a deleted file;
- a binary or unrecognised file type;
- a submodule or symlink change;
- a diff it cannot fetch or parse;
- its own error.

It classifies the whole diff (content, not just the file list), so a T0 file can't carry a change to how checks execute.

1. Required CI is green on the PR head.
2. The PR body carries the evidence block: red on main and green on the branch for every behavioural claim, or "no behaviour change" stated and checkable; the gates run.
3. A cold review returned IMPLEMENT/GO with no unresolved CONFIRMED finding, for any change beyond docs.
4. The tier is decided by a deterministic classifier, not by the reviewing agent. It's a committed script, `scripts/classify-autonomy-tier.ts`, which is itself an owned path. It reads the PR's diff and prints `T0` or `T1` with the rule that fired, and it covers `CODEOWNERS` ownership plus exclusions 1–5. `motebit-reviewer` refuses to approve unless it prints `T0`.
5. The approval body is a **receipt**: what was checked, with the run ids and the review verdict.

**Enforced by GitHub, not by the agent's good behaviour.** A required status check, `autonomy-tier`, runs the same classifier in CI on every PR **and on the `merge_group` event**, so it is judged against the exact commit the merge queue builds, not only the PR head. The check passes in three cases:

- the PR classifies as T0;
- `hakimlabs` has approved it;
- no approval from `motebit-reviewer` is present.

It **fails** when `motebit-reviewer` has approved a PR that classifies as T1, and when `AUTONOMY_T0` is `off` and the only approval is the machine user's. A compromised or mistaken reviewer session therefore cannot merge a T1 change: the ruleset blocks the merge, not the agent. The check's workflow and the classifier are owned paths, so the boundary cannot be moved by a T0 change.

**T1, founder only:** any PR touching an owned path (money, identity, authority gates, constitutional files). Agents build, review, verify and publish it; it waits for `hakimlabs`. Unchanged from today.

**Why a machine user and not a GitHub App:** a required review counts only users with write access, and code-owner review counts only users or teams. An App's review cannot satisfy the ruleset. The machine user holds a fine-grained token scoped to `motebit/motebit` with pull-request write only, stored where `motebit-agent`'s is (`~/.config/gh-motebit-reviewer`), and is never exported into builder or reviewer agents.

## Rails

- **Rate limit:** at most 6 T0 merges per day, and at most 2 in the queue at once.
- **Auto-revert:** if `main` goes red within 2 hours of a T0 merge and the failure reproduces on the merge commit but not its parent, the steward opens a revert PR (itself T0), and autonomy pauses until a human looks.
- **Kill switch:** repository variable `AUTONOMY_T0=off`. The steward reads it before every approval, and the required `autonomy-tier` check enforces it, so it holds even if the steward ignores it.
- **Daily digest:** one comment on a pinned tracking issue listing every autonomous approval and merge, with its receipt. The founder reviews receipts, not keyboards.
- **No self-expansion:** changes to `CODEOWNERS`, `money-identity-path.ts`, this document's rules, or the ruleset are owned paths. Autonomy cannot widen itself.

**Status: autonomous merging is not authorized.** It becomes authorized only when `motebit-reviewer` exists with the scoped token, the `autonomy-tier` check is required in `main-protection`, and the adversarial fixtures and the live blocked-merge check have passed.

## No interim delegation

An earlier draft let Claude approve T0 PRs **as `hakimlabs`** under a standing delegation recorded in the agent's memory. That is withdrawn.

A grant written in an agent's notes is an instruction, not an authorization. It isn't verifiable, scoped or revocable by anything GitHub enforces, and the audit trail would show the founder's account. The Claude Code harness refused the first such approval as self-approval, and none was ever made.

Until `motebit-reviewer` and the `autonomy-tier` check exist, every merge has the founder's own approval.

## Founder actions to adopt

1. Create the `motebit-reviewer` GitHub user, give it write access to `motebit/motebit`, and create its fine-grained token. Claude cannot create accounts.
2. Approve the PR that adds `scripts/classify-autonomy-tier.ts`, the required `autonomy-tier` check (added to `main-protection`), the `AUTONOMY_T0` variable, and the digest issue. The classifier ships with adversarial fixtures that test both sides of the boundary:

- **Must be T1:** a weakened relay money-path test (assertion removed, `.skip` added), a workflow edit, a loosened dependency range, a drift-gate config change, a rename of an owned file to an unowned path, and an unparseable diff.
- **Must stay T0:** a docs-only change and a presentation-only UI change.

Acceptance needs every fixture green, and then a live check that a T1 PR approved only by `motebit-reviewer` is blocked by the ruleset on GitHub, not just reported red.
