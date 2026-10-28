#!/usr/bin/env tsx
/**
 * autonomy-tier-verdict — the `autonomy-tier` required check of the repo
 * autonomy design (docs/proposals/repo-autonomy-v1.md, "Enforced by GitHub,
 * not by the agent's good behaviour").
 *
 * Per PR, with the tier from `scripts/classify-autonomy-tier.ts`:
 *
 *   FAIL  the machine reviewer (`motebit-reviewer`) approved and the PR is
 *         not T0 (T1, or the classifier errored — an error is T1);
 *   FAIL  the machine reviewer approved and the kill switch is engaged (only
 *         a founder approval of the head passes then — the repo is public, so
 *         any other account's approval is no reason to lift it);
 *   PASS  otherwise — T0, the founder (`hakimlabs`) approved the current head,
 *         or no machine approval stands.
 *
 * A founder approval passes even a T1 PR the machine also approved: the founder
 * reviewed it. It counts only on the PR's CURRENT head commit (a stale approval
 * cannot carry later commits) and only with an `author_association` of OWNER,
 * MEMBER or COLLABORATOR. A machine approval binds on ANY commit, whatever
 * its association, for as long as GitHub reports it APPROVED: a later review
 * by the machine login (a change request, a comment, or a review that is
 * itself dismissed) does not un-bind it. Dismissing the approval itself does,
 * by hand or by a push under `dismiss_stale_reviews_on_push`: GitHub rewrites
 * that review's state to DISMISSED, and the original state is not kept. That
 * is not a way past the check: a dismissed approval no longer counts toward
 * GitHub's required approval either (milestone ledger, matrix M6).
 * Fail closed in both directions: what could pass a PR is narrowed, what could
 * fail one never is.
 * A user's standing review state is their latest APPROVED / CHANGES_REQUESTED
 * / DISMISSED review (COMMENTED and PENDING do not change it), as GitHub
 * computes it.
 *
 * Kill switch: repository variable `AUTONOMY_T0`. Only the exact value `on`
 * leaves it disengaged. `off`, unset, empty or anything else engages it — an
 * unset variable reads as `''` in a workflow, and a kill switch that a missing
 * variable silently disarms is not one. During the expand phase (below) the
 * variable was not read at all; in contract (now) it is read.
 *
 * On `merge_group`, every commit in base..head is one queued PR (squash
 * titles end `(#N)`); each is classified on its own commit diff — the exact
 * change the queue builds — and judged with its own PR's reviews. A commit
 * that names no PR, a PR named on more than one commit, or a queue ref
 * naming a PR not in the group, fails.
 *
 * Events and the migration phase (`MIGRATION_PHASE`). The trigger set moves
 * expand → verify → contract, so the required check reports on every PR
 * throughout (a required check whose workflow has no trigger for the PR's own
 * run never reports, and blocks it):
 *
 *   expand    (done) `pull_request`, `pull_request_review`,
 *             `pull_request_target` and `merge_group` are all judged. Every
 *             agent PR comes from a fork, and a fork PR's `pull_request` /
 *             `pull_request_review` run gets no repository variables (seen
 *             live on #1181: `AUTONOMY_T0` read `''`) and runs the PR's own
 *             copy of the workflow. So in expand the kill switch is ENGAGED BY
 *             CONSTRUCTION on every event (`switchForVerdict`): the observed
 *             `AUTONOMY_T0` is logged and ignored. Every event this script
 *             judges then gives the same verdict for the same PR state, and
 *             no run of THIS script can open the switch. (A run whose policy
 *             revision predates expand runs the older script instead.)
 *   contract  (now) only `pull_request_target`
 *             and `merge_group` are judged, and `AUTONOMY_T0` is read.
 *
 * `judgedEvent` refuses every event outside the phase's set (`PHASE_EVENTS`),
 * and autonomy-tier-workflow.test.ts holds the workflow's triggers equal to
 * that set, so a trigger added without the phase moving fails closed.
 *
 * Policy provenance (`provenanceFailures`): a CONSISTENCY SELF-CHECK run by
 * the very policy it checks (so not an authority: a different policy could
 * skip it), catching an honest policy running in the wrong place. This
 * script and the classifier must be the revision the workflow selected for the
 * event from GitHub-set event fields (`EXPECTED_POLICY_SHA`, re-derived here by
 * `eventPolicyRef`), and on the PR events that revision must be on main's
 * history. Otherwise the run FAILS with reason `policy-provenance`. Each run
 * logs one `autonomy-tier: provenance {json}` line with the policy sha, the
 * heads read from the API and the review snapshot judged.
 *
 * PURE core (`decidePr`, `decide`, `standingStates`, `judgedEvent`,
 * `switchForVerdict`); the CLI is I/O only.
 * Any API or git error fails the check (non-zero exit): an unprovable "no
 * machine approval" is not a pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRevisions, type Classification } from "./classify-autonomy-tier.js";
import { cleanEnv } from "./lib/differential-tree.js";

export const MACHINE_REVIEWER = "motebit-reviewer";
export const FOUNDER = "hakimlabs";

export interface Review {
  login: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  commitId: string | null;
  submittedAt: string | null;
  id: number;
  /** The reviews API's `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...). */
  association: string | null;
}

/** Associations whose approval may pass a PR. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export interface PrInput {
  number: number;
  headSha: string;
  /** "T0" | "T1" | "error" (an error is judged as T1). */
  tier: "T0" | "T1" | "error";
  tierDetail: string;
  reviews: readonly Review[];
}

export interface PrVerdict {
  number: number;
  pass: boolean;
  reason:
    | "t0"
    | "founder-approved"
    | "no-machine-approval"
    | "machine-approved-t1"
    | "kill-switch-machine-only";
  detail: string;
}

export interface Verdict {
  pass: boolean;
  prs: PrVerdict[];
  summary: string;
  /** Set when the run failed on its own provenance, whatever the PRs' verdicts (`withProvenance`). */
  reason?: "policy-provenance";
}

const lower = (s: string): string => s.toLowerCase();

/** Each user's standing review: their latest state-changing review. */
export function standingStates(reviews: readonly Review[]): Map<string, Review> {
  const ordered = [...reviews].sort((a, b) => {
    const ta = a.submittedAt ?? "";
    const tb = b.submittedAt ?? "";
    return ta === tb ? a.id - b.id : ta < tb ? -1 : 1;
  });
  const out = new Map<string, Review>();
  for (const r of ordered) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") {
      out.set(lower(r.login), r);
    }
  }
  return out;
}

export function killSwitchEngaged(value: string | undefined): boolean {
  return value !== "on";
}

export function decidePr(pr: PrInput, autonomyT0: string | undefined): PrVerdict {
  const standing = standingStates(pr.reviews);
  const approved = [...standing.entries()].filter(([, r]) => r.state === "APPROVED");
  // A machine review GitHub still reports APPROVED binds: a later review,
  // dismissed review or change request by the same login never un-binds it
  // (only narrowing of what may pass is allowed, never of what fails). A
  // dismissal of this review itself rewrites its state, so it no longer binds.
  const machine = pr.reviews.some(
    (r) => lower(r.login) === lower(MACHINE_REVIEWER) && r.state === "APPROVED",
  );
  const founderAtHead = approved.some(
    ([login, r]) =>
      login === lower(FOUNDER) &&
      r.commitId === pr.headSha &&
      TRUSTED_ASSOCIATIONS.has(r.association ?? ""),
  );
  const v = (pass: boolean, reason: PrVerdict["reason"], detail: string): PrVerdict => ({
    number: pr.number,
    pass,
    reason,
    detail,
  });

  if (founderAtHead)
    return v(true, "founder-approved", `${FOUNDER} approved head ${pr.headSha.slice(0, 12)}`);
  if (!machine)
    return v(
      true,
      "no-machine-approval",
      `no standing ${MACHINE_REVIEWER} approval (tier ${pr.tier})`,
    );
  if (pr.tier !== "T0") {
    return v(
      false,
      "machine-approved-t1",
      `${MACHINE_REVIEWER} approved a PR that is not T0 (${pr.tier}: ${pr.tierDetail}) — only ${FOUNDER} may approve it`,
    );
  }
  if (killSwitchEngaged(autonomyT0)) {
    return v(
      false,
      "kill-switch-machine-only",
      `AUTONOMY_T0 is ${JSON.stringify(autonomyT0 ?? "")} (not "on"): ${MACHINE_REVIEWER} approved and ${FOUNDER} has not approved the head`,
    );
  }
  return v(true, "t0", `T0 (${pr.tierDetail})`);
}

export function decide(prs: readonly PrInput[], autonomyT0: string | undefined): Verdict {
  if (prs.length === 0)
    return { pass: false, prs: [], summary: "autonomy-tier: no PR to judge — failing closed" };
  const verdicts = prs.map((p) => decidePr(p, autonomyT0));
  const pass = verdicts.every((v) => v.pass);
  const summary =
    `autonomy-tier: ${pass ? "PASS" : "FAIL"} — ` +
    verdicts
      .map((v) => `#${v.number} ${v.pass ? "pass" : "FAIL"} (${v.reason}: ${v.detail})`)
      .join("; ");
  return { pass, prs: verdicts, summary };
}

/** The PR numbers of a merge group: one `(#N)` squash title per commit, plus the queue ref's PR. */
export function mergeGroupPrs(
  commits: readonly { sha: string; subject: string }[],
  headRef: string,
): { sha: string; number: number }[] {
  if (commits.length === 0) throw new Error("merge group has no commits");
  const out = commits.map((c) => {
    const m = /\(#(\d+)\)$/.exec(c.subject.trim());
    if (!m)
      throw new Error(
        `merge-group commit ${c.sha.slice(0, 12)} '${c.subject}' names no PR (expected a squash title ending '(#N)')`,
      );
    return { sha: c.sha, number: Number(m[1]) };
  });
  // Exactly one commit per PR: a PR named twice means a commit whose diff
  // another PR's reviews would be judged against.
  const seen = new Set<number>();
  for (const c of out) {
    if (seen.has(c.number)) {
      throw new Error(
        `merge group names PR #${c.number} on more than one commit — expected exactly one squash commit per PR`,
      );
    }
    seen.add(c.number);
  }
  const last = /\/pr-(\d+)-[0-9a-f]+$/.exec(headRef);
  if (!last || !out.some((c) => c.number === Number(last[1]))) {
    throw new Error(
      `queue ref '${headRef}' names no PR among the group's commits (${out.map((c) => `#${c.number}`).join(", ")})`,
    );
  }
  return out;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

const tierOf = (c: Classification): { tier: PrInput["tier"]; tierDetail: string } => ({
  tier: c.rule === "classifier-error" ? "error" : c.tier,
  tierDetail: c.summary,
});

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface ApiReview {
  id: number;
  user: { login: string } | null;
  state: string;
  commit_id: string | null;
  submitted_at: string | null;
  author_association?: string;
}

async function fetchReviews(repo: string, n: number, token: string): Promise<Review[]> {
  const out: Review[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh<ApiReview[]>(
      `repos/${repo}/pulls/${n}/reviews?per_page=100&page=${page}`,
      token,
    );
    for (const r of batch) {
      if (r.user === null) continue; // a deleted account cannot be the machine reviewer by login
      out.push({
        id: r.id,
        login: r.user.login,
        state: r.state,
        commitId: r.commit_id,
        submittedAt: r.submitted_at,
        association: r.author_association ?? null,
      });
    }
    if (batch.length < 100) return out;
  }
  throw new Error(`PR #${n}: more than 3000 reviews — refusing to judge a partial list`);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: cleanEnv(), encoding: "utf-8" });
}

export interface EventPayload {
  pull_request?: { number: number; head: { sha: string }; base: { sha: string } };
  merge_group?: { base_sha: string; head_sha: string; head_ref: string };
}

/** The step of the trigger migration (expand → verify → contract) this script judges in. */
export type MigrationPhase = "expand" | "contract";

/**
 * THE phase. Flipped to "contract" by the contract PR, in the same commit as
 * the workflow's trigger set (autonomy-tier-workflow.test.ts holds the
 * workflow's `on:` keys equal to `PHASE_EVENTS[MIGRATION_PHASE]`).
 */
export const MIGRATION_PHASE: MigrationPhase = "contract";

/** The events each phase judges: exactly the workflow's triggers in that phase. */
export const PHASE_EVENTS: Readonly<Record<MigrationPhase, readonly string[]>> = {
  expand: ["merge_group", "pull_request", "pull_request_review", "pull_request_target"],
  contract: ["merge_group", "pull_request_target"],
};

/**
 * The events whose runs may judge in `phase`, and how each is judged. Any
 * other event throws (fail closed): in contract, `pull_request` and
 * `pull_request_review` above all, which from a fork carry no variables and
 * run the PR's own copy of the workflow.
 */
export function judgedEvent(
  eventName: string,
  phase: MigrationPhase = MIGRATION_PHASE,
): "pull-request" | "merge-group" {
  const events = PHASE_EVENTS[phase] as readonly string[] | undefined;
  if (events === undefined) throw new Error(`unknown migration phase '${String(phase)}'`);
  if (!events.includes(eventName)) {
    throw new Error(
      `unsupported event '${eventName}': in the ${phase} phase the autonomy-tier verdict is computed only on ${events.join(", ")}`,
    );
  }
  return eventName === "merge_group" ? "merge-group" : "pull-request";
}

/** The kill-switch value judged with during expand. Anything but "on" engages the switch. */
export const EXPAND_SWITCH_VALUE = "<expand phase: engaged>";

/**
 * The kill-switch value to judge with, and the log line naming what was
 * observed. In expand the observed `AUTONOMY_T0` (non-secret) is logged and
 * IGNORED: the switch is engaged whatever it reads, on every event. In
 * contract it is judged as read.
 */
export function switchForVerdict(
  observed: string | undefined,
  phase: MigrationPhase = MIGRATION_PHASE,
): { value: string | undefined; log: string } {
  const seen = observed === undefined ? "(unset)" : JSON.stringify(observed);
  if (phase === "expand") {
    return {
      value: EXPAND_SWITCH_VALUE,
      log: `autonomy-tier: AUTONOMY_T0 observed ${seen} (expand phase: ignored, switch engaged)`,
    };
  }
  if (phase === "contract") {
    return {
      value: observed,
      log: `autonomy-tier: AUTONOMY_T0 observed ${seen} (contract phase: read)`,
    };
  }
  throw new Error(`unknown migration phase '${String(phase)}'`);
}

// ── Policy provenance ────────────────────────────────────────────────────────

/** The repository root this script runs from: the trusted checkout, whose HEAD is the policy. */
const POLICY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FULL_SHA = /^[0-9a-f]{40}$/;

/** One review as the verdict saw it (enough to tell, after the fact, a run that judged a stale set). */
export interface ReviewSnapshot {
  id: number;
  login: string;
  state: string;
  commit_id: string | null;
  submitted_at: string | null;
}

/**
 * What a run judged with, logged once per run as
 * `autonomy-tier: provenance {json}` and checked by `provenanceFailures`.
 */
export interface Provenance {
  event: string;
  phase: MigrationPhase;
  /** `git rev-parse HEAD` of the checkout this script runs from. */
  policy_sha: string | null;
  /** The per-event trusted ref the workflow passed in (`EXPECTED_POLICY_SHA`). */
  expected_policy_sha: string | null;
  /** The same ref, re-derived by this script from the event (`eventPolicyRef`). */
  event_policy_ref: string | null;
  /** `git merge-base --is-ancestor policy_sha origin/main`; null when not checked (merge_group). */
  policy_on_main: boolean | null;
  /** The head the workflow saw (`EVENT_HEAD_SHA`). */
  event_head_sha: string | null;
  /** The head in the event payload. */
  payload_head_sha: string | null;
  /** Each judged PR's head, read from the API when the verdict ran. */
  evaluated_head_shas: string[];
  merge_group_sha: string | null;
  merge_group_base_sha: string | null;
  /** The reviews each PR was judged with. */
  reviews: { pr: number; head_sha: string; reviews: ReviewSnapshot[] }[];
  decision: "pass" | "fail" | "error" | null;
  detail?: string;
}

/**
 * The trusted ref each event must check out as the policy, re-derived from
 * the event (independently of the workflow's expression, which it must
 * equal): pull_request / pull_request_review → the PR's base sha (there
 * GITHUB_SHA is the PR merge commit, PR code included); pull_request_target →
 * GITHUB_SHA (the base branch's tip); merge_group → the group's base sha.
 * Anything missing is null, which fails `provenanceFailures`.
 */
export function eventPolicyRef(
  eventName: string,
  event: EventPayload,
  githubSha: string | undefined,
): string | null {
  switch (eventName) {
    case "pull_request":
    case "pull_request_review":
      return event.pull_request?.base?.sha ?? null;
    case "pull_request_target":
      return githubSha ?? null;
    case "merge_group":
      return event.merge_group?.base_sha ?? null;
    default:
      return null;
  }
}

/** The events whose policy commit must already be on main (`policy_on_main`). */
export const ANCESTRY_CHECKED_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_target",
]);

/** Every reason the policy that judged cannot be shown to be the authorized base (empty: provenance holds). */
export function provenanceFailures(p: Provenance): string[] {
  const out: string[] = [];
  const policy = p.policy_sha;

  // ── PRIMARY self-check: provenance (run by the policy it checks, so it
  // catches misplacement, not a hostile policy). The executable policy is the
  // revision selected for this event from GitHub-set event fields, whatever
  // the PR contains.
  if (policy === null || !FULL_SHA.test(policy)) {
    out.push(`policy_sha ${JSON.stringify(policy)} is not a commit sha`);
  }
  if (p.expected_policy_sha === null || !FULL_SHA.test(p.expected_policy_sha)) {
    out.push(`expected_policy_sha ${JSON.stringify(p.expected_policy_sha)} is not a commit sha`);
  }
  if (policy !== p.expected_policy_sha) {
    out.push(
      `policy_sha ${String(policy)} != expected_policy_sha ${String(p.expected_policy_sha)}`,
    );
  }
  // The workflow's expression and this script's own reading of the event must
  // select the same revision.
  if (p.event_policy_ref === null || p.expected_policy_sha !== p.event_policy_ref) {
    out.push(
      `expected_policy_sha ${String(p.expected_policy_sha)} is not the ${p.event} event's trusted ref ${String(p.event_policy_ref)}`,
    );
  }
  // PR events: the policy commit is on main's history. merge_group is not
  // checked: its base can be the previous queue entry, not yet on main.
  if (ANCESTRY_CHECKED_EVENTS.has(p.event) && p.policy_on_main !== true) {
    out.push(
      `policy_sha ${String(policy)} is not an ancestor of origin/main (${p.policy_on_main === null ? "not checked" : "not on main"})`,
    );
  }

  // ── SECONDARY tripwire. Legitimate equality cannot
  // occur: an open PR's head always has commits beyond its base, and a merge
  // group's head is always a new commit on top of its base. So equality
  // means the policy IS the change under judgement.
  if (p.event_head_sha === null || p.event_head_sha !== p.payload_head_sha) {
    out.push(
      `event_head_sha ${String(p.event_head_sha)} != the payload's head ${String(p.payload_head_sha)}`,
    );
  }
  const heads = new Set<string>(p.evaluated_head_shas);
  if (p.payload_head_sha !== null) heads.add(p.payload_head_sha);
  if (p.merge_group_sha !== null) heads.add(p.merge_group_sha);
  if (policy !== null && heads.has(policy)) {
    out.push(`policy_sha ${policy} is a head under judgement (the policy is the change itself)`);
  }
  if (p.event === "merge_group") {
    if (p.merge_group_sha === null || p.merge_group_base_sha === null) {
      out.push("merge group without a base or head sha");
    } else if (p.merge_group_sha === p.merge_group_base_sha) {
      out.push(`merge group base_sha == head_sha (${p.merge_group_sha})`);
    }
  }
  return out;
}

/** The run's verdict once provenance is checked: any failure fails it, with its own reason. */
export function withProvenance(verdict: Verdict, failures: readonly string[]): Verdict {
  if (failures.length === 0) return verdict;
  return {
    pass: false,
    prs: verdict.prs,
    reason: "policy-provenance",
    summary: `autonomy-tier: FAIL — policy-provenance: ${failures.join("; ")}`,
  };
}

const snapshot = (reviews: readonly Review[]): ReviewSnapshot[] =>
  reviews.map((r) => ({
    id: r.id,
    login: r.login,
    state: r.state,
    commit_id: r.commitId,
    submitted_at: r.submittedAt,
  }));

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True iff `sha` is on `origin/main` in `root` (exit 0 of `merge-base --is-ancestor`); any error is false. */
function onMain(root: string, sha: string | null): boolean {
  if (sha === null || !FULL_SHA.test(sha)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], {
      cwd: root,
      env: cleanEnv(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The CLI. `policyRoot` is the checkout whose HEAD is the policy and whose
 * `origin/main` it must descend from; the CLI never passes it (it is this
 * script's own checkout, `trusted/`), tests point it at a fixture repo.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  policyRoot: string = POLICY_ROOT,
): Promise<number> {
  const eventName = argValue(argv, "--event-name");
  const eventPath = argValue(argv, "--event-path");
  const repoName = argValue(argv, "--repository");
  const subject = argValue(argv, "--subject");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!eventName || !eventPath || !repoName || !subject || !token) {
    process.stderr.write(
      "usage: autonomy-tier-verdict --event-name <e> --event-path <file> --repository <owner/name> --subject <git dir> (GH_TOKEN, EXPECTED_POLICY_SHA, EVENT_HEAD_SHA set)\n",
    );
    return 2;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf-8")) as EventPayload;
  const prs: PrInput[] = [];

  const kind = judgedEvent(eventName);
  const killSwitch = switchForVerdict(env.AUTONOMY_T0);
  process.stdout.write(`${killSwitch.log}\n`);

  let policySha: string | null = null;
  try {
    policySha = git(policyRoot, ["rev-parse", "HEAD"]).trim();
  } catch {
    policySha = null; // unreadable: provenanceFailures fails it
  }
  const prov: Provenance = {
    event: eventName,
    phase: MIGRATION_PHASE,
    policy_sha: policySha,
    expected_policy_sha: env.EXPECTED_POLICY_SHA ?? null,
    event_policy_ref: eventPolicyRef(eventName, event, env.GITHUB_SHA),
    policy_on_main: ANCESTRY_CHECKED_EVENTS.has(eventName) ? onMain(policyRoot, policySha) : null,
    event_head_sha: env.EVENT_HEAD_SHA ?? null,
    payload_head_sha: event.pull_request?.head?.sha ?? event.merge_group?.head_sha ?? null,
    evaluated_head_shas: [],
    merge_group_sha: event.merge_group?.head_sha ?? null,
    merge_group_base_sha: event.merge_group?.base_sha ?? null,
    reviews: [],
    decision: null,
  };
  const logProvenance = (): void => {
    process.stdout.write(`autonomy-tier: provenance ${JSON.stringify(prov)}\n`);
  };

  try {
    if (kind === "pull-request") {
      const pr = event.pull_request;
      if (!pr) throw new Error(`${eventName} event has no pull_request`);
      const c = classifyRevisions(subject, pr.base.sha, pr.head.sha);
      process.stdout.write(`#${pr.number} ${JSON.stringify(c)}\n`);
      // Judge the PR's current head from the API, not the (possibly older) event payload.
      const live = await gh<{ head: { sha: string } }>(
        `repos/${repoName}/pulls/${pr.number}`,
        token,
      );
      prov.evaluated_head_shas.push(live.head.sha);
      if (live.head.sha !== pr.head.sha) {
        throw new Error(
          `PR #${pr.number} head moved (${pr.head.sha.slice(0, 12)} → ${live.head.sha.slice(0, 12)}); the newer run judges it`,
        );
      }
      const reviews = await fetchReviews(repoName, pr.number, token);
      prov.reviews.push({ pr: pr.number, head_sha: live.head.sha, reviews: snapshot(reviews) });
      prs.push({ number: pr.number, headSha: live.head.sha, ...tierOf(c), reviews });
    } else {
      const mg = event.merge_group;
      if (!mg) throw new Error("merge_group event has no merge_group");
      const shas = git(subject, [
        "rev-list",
        "--reverse",
        "--first-parent",
        `${mg.base_sha}..${mg.head_sha}`,
      ])
        .split("\n")
        .filter((s) => s !== "");
      const commits = shas.map((sha) => ({
        sha,
        subject: git(subject, ["log", "-1", "--format=%s", sha]).trim(),
      }));
      for (const { sha, number } of mergeGroupPrs(commits, mg.head_ref)) {
        const c = classifyRevisions(subject, `${sha}^`, sha, false);
        process.stdout.write(`#${number} @${sha.slice(0, 12)} ${JSON.stringify(c)}\n`);
        const pr = await gh<{ head: { sha: string }; state: string; base: { ref: string } }>(
          `repos/${repoName}/pulls/${number}`,
          token,
        );
        prov.evaluated_head_shas.push(pr.head.sha);
        if (pr.state !== "open" || pr.base.ref !== "main") {
          throw new Error(
            `PR #${number} is '${pr.state}' against '${pr.base.ref}' — not a queued PR into main`,
          );
        }
        const reviews = await fetchReviews(repoName, number, token);
        prov.reviews.push({ pr: number, head_sha: pr.head.sha, reviews: snapshot(reviews) });
        prs.push({ number, headSha: pr.head.sha, ...tierOf(c), reviews });
      }
    }
  } catch (err) {
    prov.decision = "error";
    prov.detail = err instanceof Error ? err.message : String(err);
    logProvenance();
    throw err;
  }

  const verdict = withProvenance(decide(prs, killSwitch.value), provenanceFailures(prov));
  prov.decision = verdict.pass ? "pass" : "fail";
  if (verdict.reason !== undefined) prov.detail = verdict.summary;
  logProvenance();
  process.stdout.write(`${JSON.stringify(verdict)}\n${verdict.summary}\n`);
  return verdict.pass ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stdout.write(
        `autonomy-tier: FAIL — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
