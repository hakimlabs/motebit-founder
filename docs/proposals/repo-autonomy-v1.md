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

**T0, autonomous:** a PR whose every changed path is **unowned** in `CODEOWNERS`. A new machine user, `motebit-reviewer`, with **write** access (not a code owner, never in `CODEOWNERS`), approves and enqueues it when all of the following hold:

1. Required CI is green on the PR head.
2. The PR body carries the evidence block: red on main and green on the branch for every behavioural claim, or "no behaviour change" stated and checkable; the gates run.
3. A cold review returned IMPLEMENT/GO with no unresolved CONFIRMED finding, for any change beyond docs and dependency patch bumps.
4. The path check is mechanical: `motebit-reviewer` refuses if any changed path matches a `CODEOWNERS` owner. That is the same rule GitHub enforces, checked before approving.
5. The approval body is a **receipt**: what was checked, with the run ids and the review verdict.

**T1, founder only:** any PR touching an owned path (money, identity, authority gates, constitutional files). Agents build, review, verify and publish it; it waits for `hakimlabs`. Unchanged from today.

**Why a machine user and not a GitHub App:** a required review counts only users with write access, and code-owner review counts only users or teams. An App's review cannot satisfy the ruleset. The machine user holds a fine-grained token scoped to `motebit/motebit` with pull-request write only, stored where `motebit-agent`'s is (`~/.config/gh-motebit-reviewer`), and is never exported into builder or reviewer agents.

## Rails

- **Rate limit:** at most 6 T0 merges per day, and at most 2 in the queue at once.
- **Auto-revert:** if `main` goes red within 2 hours of a T0 merge and the failure reproduces on the merge commit but not its parent, the steward opens a revert PR (itself T0), and autonomy pauses until a human looks.
- **Kill switch:** repository variable `AUTONOMY_T0=off`. The steward reads it before every approval.
- **Daily digest:** one comment on a pinned tracking issue listing every autonomous approval and merge, with its receipt. The founder reviews receipts, not keyboards.
- **No self-expansion:** changes to `CODEOWNERS`, `money-identity-path.ts`, this document's rules, or the ruleset are owned paths. Autonomy cannot widen itself.

## Interim (until `motebit-reviewer` exists)

From 2026-10-25 the founder granted Claude a standing delegation to approve T0 PRs **as `hakimlabs`**, with the same rails and a receipt comment on every approval ("approved by Claude under standing delegation (tier 0); evidence: …"). It is revocable by the founder at any time. It is weaker than the target design in one respect: the audit trail shows the founder's account, with only the receipt comment saying an agent decided. That gap is why the machine user is the durable form.

## Founder actions to adopt

1. Create the `motebit-reviewer` GitHub user, give it write access to `motebit/motebit`, and create its fine-grained token. Claude cannot create accounts.
2. Approve the PR that adds the `AUTONOMY_T0` variable check and the digest issue to the steward's runbook.
