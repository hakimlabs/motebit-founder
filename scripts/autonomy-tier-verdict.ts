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
 *   FAIL  the machine reviewer approved, the kill switch is engaged, and no
 *         other approval stands;
 *   PASS  otherwise — T0, the founder (`hakimlabs`) approved the current head,
 *         or no machine approval stands.
 *
 * A founder approval passes even a T1 PR the machine also approved: the founder
 * reviewed it. A founder approval counts only on the PR's CURRENT head commit,
 * so a stale approval cannot carry later commits (the same holds for the
 * "another approval" that keeps an engaged kill switch from failing a T0 PR);
 * a machine approval counts on
 * ANY commit, so a stale one still binds (fail closed in both directions).
 * A user's standing review state is their latest APPROVED / CHANGES_REQUESTED
 * / DISMISSED review (COMMENTED and PENDING do not change it), as GitHub
 * computes it.
 *
 * Kill switch: repository variable `AUTONOMY_T0`. Only the exact value `on`
 * leaves it disengaged. `off`, unset, empty or anything else engages it — an
 * unset variable reads as `''` in a workflow, and a kill switch that a missing
 * variable silently disarms is not one.
 *
 * On `merge_group`, every commit in base..head is one queued PR (squash
 * titles end `(#N)`); each is classified on its own commit diff — the exact
 * change the queue builds — and judged with its own PR's reviews. A commit
 * that names no PR, a PR named on more than one commit, or a queue ref
 * naming a PR not in the group, fails.
 *
 * PURE core (`decidePr`, `decide`, `standingStates`); the CLI is I/O only.
 * Any API or git error fails the check (non-zero exit): an unprovable "no
 * machine approval" is not a pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
}

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
  const machine = approved.some(([login]) => login === lower(MACHINE_REVIEWER));
  const founderAtHead = approved.some(
    ([login, r]) => login === lower(FOUNDER) && r.commitId === pr.headSha,
  );
  // Another approval of the CURRENT head (a stale one does not lift the kill switch).
  const others = approved
    .filter(([login, r]) => login !== lower(MACHINE_REVIEWER) && r.commitId === pr.headSha)
    .map(([login]) => login);
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
  if (killSwitchEngaged(autonomyT0) && others.length === 0) {
    return v(
      false,
      "kill-switch-machine-only",
      `AUTONOMY_T0 is ${JSON.stringify(autonomyT0 ?? "")} (not "on") and the only approval is ${MACHINE_REVIEWER}'s`,
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
      });
    }
    if (batch.length < 100) return out;
  }
  throw new Error(`PR #${n}: more than 3000 reviews — refusing to judge a partial list`);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: cleanEnv(), encoding: "utf-8" });
}

interface EventPayload {
  pull_request?: { number: number; head: { sha: string }; base: { sha: string } };
  merge_group?: { base_sha: string; head_sha: string; head_ref: string };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const eventName = argValue(argv, "--event-name");
  const eventPath = argValue(argv, "--event-path");
  const repoName = argValue(argv, "--repository");
  const subject = argValue(argv, "--subject");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!eventName || !eventPath || !repoName || !subject || !token) {
    process.stderr.write(
      "usage: autonomy-tier-verdict --event-name <e> --event-path <file> --repository <owner/name> --subject <git dir> (GH_TOKEN set)\n",
    );
    return 2;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf-8")) as EventPayload;
  const prs: PrInput[] = [];

  if (eventName === "pull_request" || eventName === "pull_request_review") {
    const pr = event.pull_request;
    if (!pr) throw new Error(`${eventName} event has no pull_request`);
    const c = classifyRevisions(subject, pr.base.sha, pr.head.sha);
    process.stdout.write(`#${pr.number} ${JSON.stringify(c)}\n`);
    // Judge the PR's current head from the API, not the (possibly older) event payload.
    const live = await gh<{ head: { sha: string } }>(`repos/${repoName}/pulls/${pr.number}`, token);
    if (live.head.sha !== pr.head.sha) {
      throw new Error(
        `PR #${pr.number} head moved (${pr.head.sha.slice(0, 12)} → ${live.head.sha.slice(0, 12)}); the newer run judges it`,
      );
    }
    prs.push({
      number: pr.number,
      headSha: pr.head.sha,
      ...tierOf(c),
      reviews: await fetchReviews(repoName, pr.number, token),
    });
  } else if (eventName === "merge_group") {
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
      if (pr.state !== "open" || pr.base.ref !== "main") {
        throw new Error(
          `PR #${number} is '${pr.state}' against '${pr.base.ref}' — not a queued PR into main`,
        );
      }
      prs.push({
        number,
        headSha: pr.head.sha,
        ...tierOf(c),
        reviews: await fetchReviews(repoName, number, token),
      });
    }
  } else {
    throw new Error(`unsupported event ${eventName}`);
  }

  const verdict = decide(prs, env.AUTONOMY_T0);
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
