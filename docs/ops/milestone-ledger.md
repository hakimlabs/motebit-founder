# Milestone ledger: verifiable agent authority

The one durable record of the founder-authorized engineering program toward motebit's NIST-aligned end state (direction of 2026-10-27; standards map in [`docs/doctrine/nist-alignment.md`](../doctrine/nist-alignment.md)). Each milestone lists its owner, dependencies, acceptance tests, the evidence so far, its GO/NO-GO and the next task. Every change to this file is a reviewed PR. Evidence cites a commit, PR or run id, with the decisive log values copied inline, because GitHub deletes run logs after their retention period.

**Stopping condition.** An independent verifier can establish which agent acted, under whose authority, within what limits, with what outcome, and whether revocation worked.

## Evidence levels

Every piece of evidence carries exactly one level, the strongest it has reached. A claim is never stated above its level. Independent verification and operational demonstration are separate axes: a live observation by the operator is demonstrated but not independently verified.

| Level                          | Meaning                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **implemented**                | The code or configuration is on `main`.                                                                                                                                    |
| **tested internally**          | A test, tamper suite or review run by the motebit operator shows it. Unbriefed cold reviews count here: the reviewer is still the operator's agent.                        |
| **independently verified**     | Checked by a party outside the motebit operator, without privileged access. None yet; milestone F creates the first.                                                       |
| **operationally demonstrated** | Observed live in the real environment, with real accounts and real enforcement (for milestone A: GitHub's ruleset, merge queue and identities), and recorded with run ids. |

## Guarantees and their limits

The repository autonomy properties hold **only while the configured GitHub protections and the privileged accounts are intact**. They are enforced by GitHub's ruleset and identity controls, not by motebit's own protocol; motebit-native enforcement is milestone B. With those protections intact:

- A machine-only approval cannot authorize a T1 change.
- A T0 change can merge on a machine-only approval only while the founder-controlled switch `AUTONOMY_T0` is exactly `on`.
- The agent's operating credentials cannot change repository protections or approve the agent's own work.
- After the contract step (#1184), the `merge_group` run is the **deciding** authorization check: it judges the final integration commit against the approvals that exist when the queue builds it. A PR-level `autonomy-tier` result reflects the PR as of its last open, push or edit, and can be stale.

## Milestones

Order: A → B → C → D → E. F has the same priority as B and starts when B produces a reproducible artifact; looking for candidates can start earlier.

| Id  | Milestone                                                                                                                                                                                 | Owner                                         | Depends on | Status                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- | ---------------------------------- |
| A   | Repository autonomy, enforced outside the agent                                                                                                                                           | agent lead (engineering); founder (authority) | none       | in progress                        |
| B   | First complete motebit-governed DevSecOps execution: identity, scoped delegation, exact revision, policy decision, external enforcement, signed receipts, provider independence           | agent lead; founder                           | A          | not started                        |
| C   | Denial, revocation (including cascade revocation and continuous authorization), tampering, restart and offline verification; what survives a compromised agent                            | agent lead                                    | B          | not started                        |
| D   | Minimum standards interoperability profile (OAuth/OIDC; evaluate SPIFFE) as adapters; motebit keeps its own identity root                                                                 | agent lead                                    | B          | not started                        |
| E   | Reproducible evidence package for NCCoE feedback: implemented, demonstrated, limitations and gaps, kept apart                                                                             | agent lead; founder                           | B, C, D    | not started                        |
| F   | Independent third-party integration: an unrelated operator installs, runs the demo and verifies the evidence without privileged access. agency.computer is first-party and does not count | founder (selection); agent lead               | B          | not started (candidates: none yet) |

## A. Repository autonomy

**Goal.** Agents develop, review and, for T0 changes only, merge without the founder approving each one, while GitHub refuses anything beyond their tier.

**Mechanism.**

- Classifier [`scripts/classify-autonomy-tier.ts`](../../scripts/classify-autonomy-tier.ts): deny by default. T0 is a closed allowlist of reader-facing docs and bench prompts with no CODEOWNERS owner; everything else is T1.
- Required check `autonomy-tier` ([`.github/workflows/autonomy-tier.yml`](../../.github/workflows/autonomy-tier.yml), [`scripts/autonomy-tier-verdict.ts`](../../scripts/autonomy-tier-verdict.ts)). It is pinned to GitHub Actions (app 15368) in ruleset `main-protection` (13909292).
- The ruleset requires the merge queue ([`merge-queue.md`](merge-queue.md)), has an empty bypass list, requires code-owner review, and dismisses stale reviews on push.
- Identities ([`agent-identity-boundary.md`](agent-identity-boundary.md)):
  - `motebit-agent` publishes PRs.
  - `motebit-reviewer` is the machine reviewer. It has Write access and 2FA, and its token has the scopes `public_repo` and `read:org`. Only the founder holds that token.
  - The founder (`hakimlabs`) is the code owner.
- Verdict rules:
  - A founder approval counts only on the PR's current head.
  - A machine approval binds on any commit and for good, which only ever narrows what passes.
  - Separately, GitHub's stale-review dismissal removes an approval from GitHub's own required-approval count when a new commit is pushed.

**Evidence.**

| Claim                                                                                                              | Level                      | Evidence                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classifier and required check exist, deny by default                                                               | implemented                | #1177, `5b666da8a`                                                                                                                                                                                                                                      |
| Expand step on main (four triggers, switch engaged by construction, git-objects-only fetch, provenance self-check) | implemented                | #1183, merged 2026-10-27T08:08:24Z as `8a1406809`                                                                                                                                                                                                       |
| Contract step (`pull_request_target` and `merge_group` only; the switch is read)                                   | implemented: pending merge | #1184, head `3101d2f6f`                                                                                                                                                                                                                                 |
| Each tamper (a planted defect) turns a test red                                                                    | tested internally          | 106/106 on `3101d2f6f`, isolated run 2026-10-27 10:09Z                                                                                                                                                                                                  |
| Cold review                                                                                                        | tested internally          | NO-GO on `7cfd33a39` (an `actions/checkout` fork guard, reproduced); GO on expand `875cb2815` and contract `057107c2d`                                                                                                                                  |
| Fork-PR `pull_request` runs get no repository variables                                                            | operationally demonstrated | #1181: `AUTONOMY_T0` read `""` with the variable set                                                                                                                                                                                                    |
| E1: the expand PR got a reporting check from main's script                                                         | operationally demonstrated | run 40464716142, `pull_request`; policy `bca7acb7e` = expected; head `875cb2815`; PASS `no-machine-approval`                                                                                                                                            |
| E2: `merge_group` runs see repository variables; the queue commit is fetchable by sha                              | operationally demonstrated | run 40468252807 on queue commit `8a1406809`; policy `bca7acb7e`; `AUTONOMY_T0` = `off`; PASS `founder-approved`                                                                                                                                         |
| E3/E4: machine-only approvals are refused on every event                                                           | operationally demonstrated | #1180 (T1): runs 40471516236, 40471516254, FAIL `machine-approved-t1`. #1181 (T0, switch off): runs 40471520964, 40471521562, FAIL `kill-switch-machine-only`. Both PRs BLOCKED. `pull_request_target` policy `8a1406809`, provenance consistent        |
| E5: any failing run blocks the required check; a later pass does not mask it                                       | operationally demonstrated | #1181: pass 40471802588 after earlier failures, still BLOCKED. Recovery = re-run each failing run (re-runs of pre-expand runs one at a time: they share a concurrency group)                                                                            |
| Withdrawing the founder approval re-blocks a PR                                                                    | operationally demonstrated | #1181: review 5663895514 dismissed; run 40485811871 (`pull_request_review`) FAIL `kill-switch-machine-only`; BLOCKED. Informal: before contract, not the matrix test                                                                                    |
| C1: on the contract PR only `pull_request_target` reports, with policy from main                                   | operationally demonstrated | #1184: runs 40487025318, 40492777381; check 122131268246 (app 15368) on `3101d2f6f`; policy `8a1406809`, `policy_on_main: true`; PASS `no-machine-approval`                                                                                             |
| The contract PR's queue run judged the founder approval on the exact head                                          | operationally demonstrated | run 40500847926 on queue commit `6e73f089e`; policy `8a1406809` (queue base); evaluated head `3101d2f6f`; review snapshot: `hakimlabs` APPROVED `3101d2f6f`; PASS `founder-approved`. The expand script ran, so the switch was logged `off` and ignored |
| A T0 change merges on a machine-only approval with the switch on                                                   | none yet                   | matrix M3                                                                                                                                                                                                                                               |
| Revocation (credential, approval, authority) is effective                                                          | none yet                   | matrix M5–M7, R1–R3                                                                                                                                                                                                                                     |

**Acceptance: the contract-phase live matrix.** Run after #1184 merges. Only the founder changes the switch, enqueues, or uses the reviewer token. Each row records:

- the merge-queue sha and policy sha (with provenance);
- the evaluated head and the review snapshot;
- the switch value read;
- the verdict, and whether the PR left the queue.

Supersedes the provisional list in #1184's description.

| Test                | Setup                                                                                                   | Expected                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M1                  | T1 PR, machine-only approval, switch `off`; an edit re-judges the PR                                    | PR-level FAIL `machine-approved-t1`                                                                                          |
| M2                  | T0 PR, machine-only approval, switch `off`, queued                                                      | `merge_group` FAIL `kill-switch-machine-only`; removed from the queue                                                        |
| M3                  | switch `on`; throwaway T0 docs PR, machine-only approval, queued                                        | merges through the queue; reverted afterwards by a founder-approved PR                                                       |
| M4                  | T1 PR, machine-only approval, switch `on`, queued                                                       | `merge_group` FAIL `machine-approved-t1`                                                                                     |
| M5 (stale pass)     | T1 PR whose PR-level check passed with no reviews; then the reviewer approves; queued                   | `merge_group` FAIL `machine-approved-t1`; the earlier PR-level pass does not help                                            |
| M6 (stale approval) | a new commit is pushed after the reviewer's approval                                                    | GitHub dismisses the approval and the PR cannot be queued without a fresh one; the verdict still counts the machine approval |
| M7                  | the reviewer loses repository access, then a T0 machine-only approval is attempted with the switch `on` | no approval can be recorded; nothing merges; access is restored afterwards                                                   |
| R1 (credential)     | the founder deletes the reviewer token                                                                  | an approval with the deleted token is refused by GitHub (401)                                                                |
| R2 (approval)       | founder approval plus machine approval; the founder dismisses their approval; queued                    | `merge_group` FAIL; the machine approval alone does not authorize                                                            |
| R3 (authority)      | T0 PR approved by the machine while the switch was `on`; the founder sets it `off`; queued              | a fresh `merge_group` run FAILs `kill-switch-machine-only`; the historical approval carries no authority                     |
| End                 |                                                                                                         | switch `off` until #1163 merges and the founder decides                                                                      |

**GO/NO-GO.** NO-GO for standing T0 autonomy. `AUTONOMY_T0` stays `off` until every row passes.

**Next.** #1184 merges; run the matrix; then revise and merge #1163 (the design proposal), which closes A.

## B–F

Not started. Each section gains its goal, mechanism, evidence table and acceptance tests when it starts. Scope fixed by the founder:

- **Protocol-first.** Enterprise IAM, OAuth/OIDC and SPIFFE are interop adapters, never the identity root (D).
- **No new layers without evidence.** No new platform layer or enterprise feature without evidence that the core protocol needs it.
- **Exact public claims.** Each claim states what is measured and what is demonstrated. Revocation stays "not yet demonstrated" until A's R1–R3 and C pass. Third-party integration stays "absent" until F.

## Out of scope for A

The measured repository audit of 2026-10-27 (gate cost, CI red causes, doctrine and package consolidation candidates) is recorded for later review and does not expand milestone A.
