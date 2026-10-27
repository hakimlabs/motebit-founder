/**
 * autonomy-tier workflow — the trigger, policy-revision and pwn-request
 * invariants of `.github/workflows/autonomy-tier.yml`, read from the REAL
 * file, and the contract phase of the verdict script end to end.
 *
 * The defect behind the migration (seen live on #1181, 2026-10-27): every
 * agent PR comes from a fork, and GitHub passes no repository variables to a
 * fork PR's `pull_request` / `pull_request_review` run, so `AUTONOMY_T0` read
 * '' there. The fix moves the trigger set expand → verify → contract, never
 * removing the required check. This file pins EXPAND: all four events judged,
 * the kill switch engaged by construction on every one of them, and the policy
 * revision chosen per event from GitHub-set event fields, never from PR code.
 *
 * The authority is the exact workflow shape (EXPECTED_WORKFLOW). Policy
 * provenance (`provenanceFailures`) is a consistency self-check run by the
 * policy it checks: primary self-check first, then a secondary tripwire.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  EXPAND_SWITCH_VALUE,
  eventPolicyRef,
  FOUNDER,
  MACHINE_REVIEWER,
  MIGRATION_PHASE,
  PHASE_EVENTS,
  judgedEvent,
  killSwitchEngaged,
  main,
  provenanceFailures,
  switchForVerdict,
  withProvenance,
  type Provenance,
  type Verdict,
} from "../autonomy-tier-verdict.js";
import { cleanEnv } from "../lib/differential-tree.js";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "autonomy-tier.yml",
);
const source = readFileSync(WORKFLOW, "utf-8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  if?: unknown;
  permissions?: unknown;
  steps: Step[];
}
const wf = parse(source) as {
  on: Record<string, { branches?: string[]; types?: string[] } | null>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = wf.jobs["autonomy-tier"]!;
const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const trusted = checkouts.find((s) => s.with?.path === "trusted");
const fetchStep = job.steps.find((s) => s.name?.startsWith("Fetch the change"));
const verdictStep = job.steps.find((s) => s.run?.includes("scripts/autonomy-tier-verdict.ts"));

// ── A minimal evaluator for the GitHub expressions this workflow uses ────────
// (string literals, context paths, ==, !=, &&, ||, parentheses; GitHub's
// value-returning && / ||, case-insensitive string ==). Anything else throws.

type Ctx = Record<string, unknown>;

function evaluate(expr: string, ctx: Ctx): unknown {
  const tokens = expr.match(/'[^']*'|==|!=|&&|\|\||[()]|[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const next = (): string => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of ${expr}`);
    return t;
  };
  const truthy = (v: unknown): boolean =>
    v !== null && v !== undefined && v !== "" && v !== false && v !== 0;
  const lookup = (path: string): unknown => {
    let v: unknown = ctx;
    for (const k of path.split(".")) {
      v = v !== null && typeof v === "object" ? (v as Ctx)[k] : undefined;
    }
    return v ?? null;
  };
  const primary = (): unknown => {
    const t = next();
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error(`unbalanced ( in ${expr}`);
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`unsupported token ${t} in ${expr}`);
  };
  const eq = (): unknown => {
    const l = primary();
    const op = peek();
    if (op === "==" || op === "!=") {
      next();
      const r = primary();
      const same =
        typeof l === "string" && typeof r === "string"
          ? l.toLowerCase() === r.toLowerCase()
          : l === r;
      return op === "==" ? same : !same;
    }
    return l;
  };
  const and = (): unknown => {
    let v = eq();
    while (peek() === "&&") {
      next();
      const r = eq();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): unknown => {
    let v = and();
    while (peek() === "||") {
      next();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${expr}`);
  return v;
}

/** `${{ }}` interpolation into a string, as the runner does it (null → ''). */
function interpolate(template: string, ctx: Ctx): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, e: string) => {
    const v = evaluate(e.trim(), ctx);
    return v === null || v === undefined ? "" : String(v);
  });
}

const S = (c: string): string => c.repeat(40);
const PR_BASE = S("b");
const PR_HEAD = S("e");
const MERGE_COMMIT = S("d"); // github.sha on pull_request(_review): PR code included
const BASE_TIP = S("a"); // github.sha on pull_request_target
const MG_BASE = S("1");
const MG_HEAD = S("2"); // github.sha on merge_group: PR code included

function ctxFor(event: string): Ctx {
  const pull_request = { number: 7, base: { sha: PR_BASE }, head: { sha: PR_HEAD } };
  switch (event) {
    case "pull_request":
    case "pull_request_review":
      return { github: { event_name: event, sha: MERGE_COMMIT, event: { pull_request } } };
    case "pull_request_target":
      return { github: { event_name: event, sha: BASE_TIP, event: { pull_request } } };
    case "merge_group":
      return {
        github: {
          event_name: event,
          sha: MG_HEAD,
          event: { merge_group: { base_sha: MG_BASE, head_sha: MG_HEAD } },
        },
      };
    default:
      return { github: { event_name: event, sha: S("9"), event: {} } };
  }
}

// ── The exact shape (the authority) ──────────────────────────────────────────

/** The per-event policy revision: one expression, used by the checkout and passed to the verdict. */
const POLICY_REF =
  "${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event_name == 'pull_request_target' && github.sha || (github.event_name == 'pull_request' || github.event_name == 'pull_request_review') && github.event.pull_request.base.sha || 'no-policy-revision-for-this-event' }}";
const HEAD_REF = "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}";
const BASE_REF = "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}";
/** The bare object store the change is fetched into (no working tree). */
const STORE = '"$GITHUB_WORKSPACE/subject.git"';
/** The change's commits, as git objects, from THIS repository (never the fork). */
const FETCH_RUN =
  `git init --quiet --bare ${STORE} &&` +
  ` git -C ${STORE} fetch --quiet --no-tags` +
  ' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"' +
  ' "+$EVENT_BASE_SHA:refs/autonomy-tier/base"' +
  ' "+$EVENT_HEAD_SHA:refs/autonomy-tier/head"';
const PR_TYPES = ["opened", "synchronize", "reopened", "ready_for_review", "edited"];

/**
 * THE AUTHORITY: the workflow's exact shape, deny by default (the same
 * pattern as the classifier's T0 ALLOWLIST). A text scan cannot close a
 * bypass assembled at run time (`cd ../${d}ject`, a line appended to
 * $GITHUB_ENV or $GITHUB_PATH, `NODE_OPTIONS` in a step env, an npm config
 * variable, `|| true` after the verdict). An exact shape does: every key and
 * value of the parsed workflow must equal this, `run:` bodies compared after
 * trimming trailing whitespace only. The semantic tests below stay for their
 * readable failures; this one decides.
 */
const EXPECTED_WORKFLOW = {
  name: "Autonomy tier",
  on: {
    pull_request_target: { branches: ["main"], types: PR_TYPES },
    merge_group: { types: ["checks_requested"] },
  },
  concurrency: {
    group:
      "autonomy-tier-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.merge_group.head_sha }}",
    "cancel-in-progress": true,
  },
  permissions: { contents: "read", "pull-requests": "read" },
  jobs: {
    "autonomy-tier": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      steps: [
        {
          name: "Check out the policy revision (the classifier and CODEOWNERS that judge)",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: {
            ref: POLICY_REF,
            path: "trusted",
            "fetch-depth": 0,
            "persist-credentials": false,
          },
        },
        {
          name: "Fetch the change as git objects only (no working tree, never executed)",
          "working-directory": "trusted",
          env: { EVENT_BASE_SHA: BASE_REF, EVENT_HEAD_SHA: HEAD_REF },
          run: FETCH_RUN,
        },
        {
          uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
          with: { package_json_file: "trusted/package.json" },
        },
        {
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "22", "package-manager-cache": false },
        },
        {
          name: "Install the policy revision's dependencies (uncached)",
          "working-directory": "trusted",
          run: "pnpm install --frozen-lockfile",
        },
        {
          name: "Classify and decide",
          "working-directory": "trusted",
          env: {
            GH_TOKEN: "${{ github.token }}",
            AUTONOMY_T0: "${{ vars.AUTONOMY_T0 }}",
            EXPECTED_POLICY_SHA: POLICY_REF,
            EVENT_HEAD_SHA: HEAD_REF,
          },
          run:
            "pnpm exec tsx scripts/autonomy-tier-verdict.ts" +
            ' --event-name "$GITHUB_EVENT_NAME"' +
            ' --event-path "$GITHUB_EVENT_PATH"' +
            ' --repository "$GITHUB_REPOSITORY"' +
            ` --subject ${STORE}`,
        },
      ],
    },
  },
};

/** Trailing whitespace of `run:` bodies is the only normalization. */
function normalized(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalized);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === "run" && typeof x === "string" ? x.trimEnd() : normalized(x),
      ]),
    );
  }
  return v;
}

describe("the autonomy-tier workflow's exact shape (the authority)", () => {
  it("equals the expected shape exactly: every key, every step, every value", () => {
    expect(
      normalized(wf),
      "autonomy-tier.yml differs from EXPECTED_WORKFLOW in scripts/__tests__/autonomy-tier-workflow.test.ts, " +
        "the canonical shape of this workflow (deny by default). Fix: if the change is " +
        "unintended, revert it; if it is intended, update EXPECTED_WORKFLOW in the same commit, under founder " +
        "review (the workflow is CODEOWNERS-owned), and re-check that no PR-head code can run.",
    ).toEqual(EXPECTED_WORKFLOW);
  });
});

// ── The migration phase ──────────────────────────────────────────────────────

describe("judgedEvent: the phase's events are judged, nothing else", () => {
  it("expand judges all four events: pull_request, pull_request_review and pull_request_target as a PR, merge_group as a queue group", () => {
    expect(judgedEvent("pull_request", "expand")).toBe("pull-request");
    expect(judgedEvent("pull_request_review", "expand")).toBe("pull-request");
    expect(judgedEvent("pull_request_target", "expand")).toBe("pull-request");
    expect(judgedEvent("merge_group", "expand")).toBe("merge-group");
  });

  it("contract judges pull_request_target and merge_group only", () => {
    expect(judgedEvent("pull_request_target", "contract")).toBe("pull-request");
    expect(judgedEvent("merge_group", "contract")).toBe("merge-group");
    expect(() => judgedEvent("pull_request", "contract")).toThrow(
      /unsupported event 'pull_request'/,
    );
    expect(() => judgedEvent("pull_request_review", "contract")).toThrow(
      /unsupported event 'pull_request_review'/,
    );
  });

  it("refuses any other event, and an empty name, in either phase", () => {
    for (const phase of ["expand", "contract"] as const) {
      for (const e of [
        "workflow_run",
        "issue_comment",
        "push",
        "workflow_dispatch",
        "",
        "Merge_Group",
      ]) {
        expect(() => judgedEvent(e, phase)).toThrow(/unsupported event/);
      }
    }
  });

  it("the default phase is MIGRATION_PHASE, which is contract", () => {
    expect(MIGRATION_PHASE).toBe("contract");
    expect(() => judgedEvent("pull_request")).toThrow(/unsupported event/);
    expect(() => judgedEvent("pull_request_review")).toThrow(/unsupported event/);
  });
});

describe("the kill switch during expand", () => {
  it("is engaged whatever AUTONOMY_T0 reads, and the observed value is logged", () => {
    for (const v of ["on", "off", "", "ON", undefined]) {
      const s = switchForVerdict(v, "expand");
      expect(s.value).toBe(EXPAND_SWITCH_VALUE);
      expect(killSwitchEngaged(s.value)).toBe(true);
      expect(s.log).toBe(
        `autonomy-tier: AUTONOMY_T0 observed ${v === undefined ? "(unset)" : JSON.stringify(v)} (expand phase: ignored, switch engaged)`,
      );
    }
  });

  it("contract judges the value as read", () => {
    expect(switchForVerdict("on", "contract").value).toBe("on");
    expect(switchForVerdict(undefined, "contract").value).toBeUndefined();
    expect(switchForVerdict("on").log).toBe(
      'autonomy-tier: AUTONOMY_T0 observed "on" (contract phase: read)',
    );
  });
});

describe("the autonomy-tier workflow's triggers", () => {
  it("triggers on exactly the contract set: pull_request_target and merge_group", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["merge_group", "pull_request_target"]);
  });

  it("the triggers are exactly the current phase's judged events (PHASE_EVENTS[MIGRATION_PHASE])", () => {
    expect(Object.keys(wf.on).sort()).toEqual([...PHASE_EVENTS[MIGRATION_PHASE]].sort());
  });

  it("pull_request_target covers every PR-side change into main; the queue is judged", () => {
    expect(wf.on.pull_request_target).toEqual({ branches: ["main"], types: PR_TYPES });
    expect(wf.on.merge_group).toEqual({ types: ["checks_requested"] });
  });

  it("every trigger is an event the verdict script judges", () => {
    for (const e of Object.keys(wf.on)) expect(() => judgedEvent(e)).not.toThrow();
  });

  it("is one job named autonomy-tier with no job-level if (a skipped job reports success)", () => {
    expect(Object.keys(wf.jobs)).toEqual(["autonomy-tier"]);
    expect(job.if).toBeUndefined();
  });

  it("passes the repository variable and the policy and head refs to the verdict step", () => {
    const verdict = job.steps.filter((s) => s.run?.includes("scripts/autonomy-tier-verdict.ts"));
    expect(verdict).toHaveLength(1);
    expect(verdict[0]!.env?.AUTONOMY_T0).toBe("${{ vars.AUTONOMY_T0 }}");
    expect(verdict[0]!.env?.EXPECTED_POLICY_SHA).toBe(trusted!.with?.ref);
    expect(verdict[0]!.env?.EVENT_HEAD_SHA).toBe(HEAD_REF);
    expect(fetchStep?.env?.EVENT_HEAD_SHA).toBe(HEAD_REF);
  });

  it("one event's run never shares a concurrency group with (or cancels) another event's run on the same PR", () => {
    const events = ["pull_request", "pull_request_review", "pull_request_target"];
    const groups = events.map((e) => interpolate(wf.concurrency.group, ctxFor(e)));
    expect(new Set(groups).size).toBe(events.length);
    for (const g of groups) expect(g).toMatch(/-7$/);
    expect(interpolate(wf.concurrency.group, ctxFor("merge_group"))).toBe(
      `autonomy-tier-merge_group-${MG_HEAD}`,
    );
  });
});

describe("the policy revision, evaluated per event", () => {
  const ref = (e: string): unknown =>
    evaluate(String(trusted!.with?.ref).slice(3, -2).trim(), ctxFor(e));

  it("pull_request and pull_request_review take the PR's base sha, never github.sha (the merge commit)", () => {
    expect(ref("pull_request")).toBe(PR_BASE);
    expect(ref("pull_request_review")).toBe(PR_BASE);
  });

  it("pull_request_target takes github.sha (the base tip) and merge_group its base sha", () => {
    expect(ref("pull_request_target")).toBe(BASE_TIP);
    expect(ref("merge_group")).toBe(MG_BASE);
  });

  it("no event takes a head: never the PR head, the merge commit or the queue commit", () => {
    for (const e of [...PHASE_EVENTS.expand, "push"]) {
      expect([PR_HEAD, MERGE_COMMIT, MG_HEAD]).not.toContain(ref(e));
    }
  });

  it("any other event resolves to no revision (the checkout fails closed)", () => {
    expect(ref("push")).toBe("no-policy-revision-for-this-event");
  });
});

describe("the autonomy-tier workflow's pull_request_target safety", () => {
  it("has a read-only token: contents and pull-requests read, nothing else, no job override", () => {
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(job.permissions).toBeUndefined();
  });

  it("references no secrets", () => {
    expect(source).not.toMatch(/\$\{\{[^}]*secrets\./);
  });

  it("checks out exactly one tree, the policy revision, without persisting credentials", () => {
    expect(checkouts).toHaveLength(1);
    expect(trusted).toBeDefined();
    for (const c of checkouts) expect(c.with?.["persist-credentials"]).toBe(false);
  });

  it("the trusted checkout is the base, never the PR head", () => {
    const ref = String(trusted!.with?.ref);
    expect(ref).not.toMatch(/head/);
    expect(ref).toBe(POLICY_REF);
  });

  it("every run step works in trusted/, never in the PR head", () => {
    const runs = job.steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) expect(s["working-directory"]).toBe("trusted");
  });

  it("interpolates no expression into a run script (event fields reach it only by file)", () => {
    for (const s of job.steps) if (s.run !== undefined) expect(s.run).not.toContain("${{");
  });

  it("no step is conditional or allowed to fail (a skipped or tolerated step reports success)", () => {
    expect(Object.keys(job)).not.toContain("continue-on-error");
    for (const s of job.steps) {
      expect(Object.keys(s)).not.toContain("if");
      expect(Object.keys(s)).not.toContain("continue-on-error");
    }
  });

  it("every action is a remote action pinned to a full commit sha (no local ./ action)", () => {
    const uses = job.steps.filter((s) => s.uses !== undefined).map((s) => s.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u.startsWith("./")).toBe(false);
      expect(u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
    }
  });

  it("nothing in the whole workflow names subject but the fetch step's store and the verdict's --subject argument", () => {
    // Every string and key in the WHOLE parsed workflow (top-level env and
    // defaults, the job, every step, every run body), with exactly two
    // exceptions matched by step identity: the store path, twice, in the
    // fetch step's run body, and once in the verdict's `--subject` argument.
    const SUBJECT_ARG = `--subject ${STORE}`;
    expect(verdictStep).toBeDefined();
    expect(fetchStep).toBeDefined();
    expect(verdictStep!.run!.split(SUBJECT_ARG)).toHaveLength(2);
    expect(fetchStep!.run!.split(STORE)).toHaveLength(3);
    const hits: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") {
        if (/subject/i.test(v)) hits.push(at);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${at}[${i}]`));
      } else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (/subject/i.test(k)) hits.push(`${at}.<key ${k}>`);
          if (v === verdictStep && k === "run" && typeof x === "string") {
            walk(x.replace(SUBJECT_ARG, ""), `${at}.run`);
            continue;
          }
          if (v === fetchStep && k === "run" && typeof x === "string") {
            walk(x.split(STORE).join(""), `${at}.run`);
            continue;
          }
          walk(x, `${at}.${k}`);
        }
      }
    };
    walk(wf, "workflow");
    expect(hits).toEqual([]);
  });

  it("sets no shell or shell start-up file anywhere (BASH_ENV / ENV / shell: would run a file first)", () => {
    const hits: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "shell" || k === "BASH_ENV" || k === "ENV") hits.push(`${at}.${k}`);
          walk(x, `${at}.${k}`);
        }
      } else if (typeof v === "string" && /\bBASH_ENV\b/.test(v)) hits.push(at);
    };
    walk(wf, "workflow");
    expect(hits).toEqual([]);
  });

  it("takes the package manager from the base and keeps the dependency cache off", () => {
    const pnpm = job.steps.find((s) => s.uses?.startsWith("pnpm/action-setup@"));
    expect(pnpm?.with?.package_json_file).toBe("trusted/package.json");
    const node = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with?.["package-manager-cache"]).toBe(false);
    expect(node?.with?.cache).toBeUndefined();
  });
});

// ── A fork PR on pull_request_target (head.repo.id != repository.id) ───────

/** The event context of a FORK PR: the head lives in another repository. */
function forkCtx(event: string): Ctx {
  const c = ctxFor(event) as { github: Record<string, unknown> };
  const ev = c.github.event as Record<string, unknown>;
  const pr = ev.pull_request as Record<string, unknown> | undefined;
  if (pr !== undefined) {
    pr.head = {
      sha: PR_HEAD,
      ref: "agent-branch",
      repo: { id: 2, full_name: "fork/motebit" },
    };
    pr.base = { sha: PR_BASE, ref: "main", repo: { id: 1, full_name: "o/r" } };
  }
  ev.repository = { id: 1, full_name: "o/r" };
  c.github.repository = "o/r";
  return c;
}

/**
 * actions/checkout v7's `assertSafePrCheckout`, as its contract reads: on
 * pull_request_target it refuses a ref naming the PR's head (sha, branch, or
 * refs/pull/N/head|merge) when the head repository is not the base one,
 * unless `allow-unsafe-pr-checkout` is set. Mirrored conservatively here.
 */
function wouldTripUnsafeCheckoutGuard(step: Step, ctx: Ctx): boolean {
  const g = (ctx as { github: { event_name: string; event: Record<string, unknown> } }).github;
  if (g.event_name !== "pull_request_target") return false;
  const pr = g.event.pull_request as
    { number: number; head: { sha: string; ref: string; repo: { id: number } } } | undefined;
  const repo = g.event.repository as { id: number } | undefined;
  if (pr === undefined || repo === undefined || pr.head.repo.id === repo.id) return false;
  const raw = String(step.with?.ref ?? "");
  const ref = raw.startsWith("${{") ? String(evaluate(raw.slice(3, -2).trim(), ctx)) : raw;
  return [
    pr.head.sha,
    pr.head.ref,
    `refs/heads/${pr.head.ref}`,
    `refs/pull/${pr.number}/head`,
    `refs/pull/${pr.number}/merge`,
  ].includes(ref);
}

describe("a fork PR on pull_request_target (head.repo.id != repository.id)", () => {
  it("no checkout step checks out PR code, so actions/checkout's unsafe-PR guard never fires, and no step disables it", () => {
    for (const e of PHASE_EVENTS[MIGRATION_PHASE]) {
      for (const c of checkouts) {
        expect(wouldTripUnsafeCheckoutGuard(c, forkCtx(e)), `${e} ${c.name}`).toBe(false);
        const ref = evaluate(String(c.with?.ref).slice(3, -2).trim(), forkCtx(e));
        expect([PR_HEAD, MERGE_COMMIT, MG_HEAD], `${e} ${c.name}`).not.toContain(ref);
        expect(c.with?.repository, "a checkout of another repository").toBeUndefined();
      }
    }
    // Parsed, not the source text: the header names the flag to explain its absence.
    expect(JSON.stringify(wf)).not.toMatch(/allow-unsafe-pr-checkout/);
  });

  it("the change is fetched as git objects into a bare store, from this repository, never the fork", () => {
    expect(fetchStep).toBeDefined();
    expect(fetchStep!.uses).toBeUndefined();
    expect(fetchStep!.run).toBe(FETCH_RUN);
    expect(fetchStep!.run).toMatch(/^git init --quiet --bare /);
    expect(fetchStep!.run).toContain('"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"');
    expect(JSON.stringify(fetchStep)).not.toMatch(/head\.repo|head_repo|full_name/);
    expect(
      interpolate(String(fetchStep!.env?.EVENT_BASE_SHA), forkCtx("pull_request_target")),
    ).toBe(PR_BASE);
    expect(
      interpolate(String(fetchStep!.env?.EVENT_HEAD_SHA), forkCtx("pull_request_target")),
    ).toBe(PR_HEAD);
    expect(interpolate(String(fetchStep!.env?.EVENT_BASE_SHA), forkCtx("merge_group"))).toBe(
      MG_BASE,
    );
    expect(interpolate(String(fetchStep!.env?.EVENT_HEAD_SHA), forkCtx("merge_group"))).toBe(
      MG_HEAD,
    );
  });
});

// ── Policy provenance (pure) ─────────────────────────────────────────────────

const POLICY = S("c");
function prov(over: Partial<Provenance> = {}): Provenance {
  return {
    event: "pull_request",
    phase: "expand",
    policy_sha: POLICY,
    expected_policy_sha: POLICY,
    event_policy_ref: POLICY,
    policy_on_main: true,
    event_head_sha: PR_HEAD,
    payload_head_sha: PR_HEAD,
    evaluated_head_shas: [PR_HEAD],
    merge_group_sha: null,
    merge_group_base_sha: null,
    reviews: [],
    decision: null,
    ...over,
  };
}
const passing: Verdict = { pass: true, prs: [], summary: "autonomy-tier: PASS — ok" };

describe("policy provenance (the primary self-check): the policy that ran is the revision selected for the event", () => {
  it("eventPolicyRef derives each event's authorized revision from GitHub-set event fields, as the workflow does", () => {
    const pull_request = { number: 7, base: { sha: PR_BASE }, head: { sha: PR_HEAD } };
    const merge_group = { base_sha: MG_BASE, head_sha: MG_HEAD, head_ref: "r" };
    expect(eventPolicyRef("pull_request", { pull_request }, MERGE_COMMIT)).toBe(PR_BASE);
    expect(eventPolicyRef("pull_request_review", { pull_request }, MERGE_COMMIT)).toBe(PR_BASE);
    expect(eventPolicyRef("pull_request_target", { pull_request }, BASE_TIP)).toBe(BASE_TIP);
    expect(eventPolicyRef("merge_group", { merge_group }, MG_HEAD)).toBe(MG_BASE);
    expect(eventPolicyRef("push", {}, S("9"))).toBeNull();
    expect(eventPolicyRef("pull_request", {}, MERGE_COMMIT)).toBeNull();
    // The same answer as the workflow's own expression, event by event.
    for (const e of PHASE_EVENTS.expand) {
      const c = ctxFor(e) as { github: { sha: string; event: Record<string, never> } };
      expect(eventPolicyRef(e, c.github.event, c.github.sha), e).toBe(
        evaluate(POLICY_REF.slice(3, -2).trim(), ctxFor(e)),
      );
    }
  });

  it("holds when the policy is the event's authorized revision, on main", () => {
    for (const event of ["pull_request", "pull_request_review", "pull_request_target"]) {
      expect(provenanceFailures(prov({ event }))).toEqual([]);
    }
    expect(
      provenanceFailures(
        prov({
          event: "merge_group",
          policy_on_main: null,
          event_head_sha: MG_HEAD,
          payload_head_sha: MG_HEAD,
          merge_group_sha: MG_HEAD,
          merge_group_base_sha: POLICY,
        }),
      ),
    ).toEqual([]);
  });

  it("fails when the policy checkout is not the expected revision", () => {
    expect(provenanceFailures(prov({ policy_sha: S("f") })).join()).toMatch(
      /policy_sha f+ != expected_policy_sha c+/,
    );
  });

  it("fails when the workflow's expected revision is not the event's own trusted ref", () => {
    expect(provenanceFailures(prov({ event_policy_ref: PR_BASE })).join()).toMatch(
      /is not the pull_request event's trusted ref/,
    );
    expect(provenanceFailures(prov({ event_policy_ref: null }))).not.toEqual([]);
  });

  it("fails on a PR event when the policy is not on main, or was not checked; merge_group skips the ancestry check", () => {
    for (const event of ["pull_request", "pull_request_review", "pull_request_target"]) {
      expect(provenanceFailures(prov({ event, policy_on_main: false })).join()).toMatch(
        /not an ancestor of origin\/main/,
      );
      expect(provenanceFailures(prov({ event, policy_on_main: null }))).not.toEqual([]);
    }
    const mg = prov({
      event: "merge_group",
      policy_on_main: false,
      event_head_sha: MG_HEAD,
      payload_head_sha: MG_HEAD,
      merge_group_sha: MG_HEAD,
      merge_group_base_sha: POLICY,
    });
    expect(provenanceFailures(mg)).toEqual([]);
  });

  it("fails when the policy or the expected sha is not a commit sha", () => {
    expect(provenanceFailures(prov({ policy_sha: null, expected_policy_sha: null }))).not.toEqual(
      [],
    );
    const bad = "no-policy-revision-for-this-event";
    expect(
      provenanceFailures(
        prov({ policy_sha: bad, expected_policy_sha: bad, event_policy_ref: bad }),
      ),
    ).not.toEqual([]);
  });

  it("withProvenance fails the run with reason policy-provenance, whatever the PRs' verdicts", () => {
    expect(withProvenance(passing, [])).toBe(passing);
    const v = withProvenance(passing, ["x"]);
    expect(v).toMatchObject({ pass: false, reason: "policy-provenance" });
    expect(v.summary).toBe("autonomy-tier: FAIL — policy-provenance: x");
  });
});

describe("policy provenance: the secondary tripwire", () => {
  it("fails when the policy is a head under judgement", () => {
    for (const h of ["evaluated_head_shas", "payload_head_sha", "merge_group_sha"] as const) {
      const p = prov({
        policy_sha: PR_HEAD,
        expected_policy_sha: PR_HEAD,
        event_policy_ref: PR_HEAD,
        payload_head_sha: h === "payload_head_sha" ? PR_HEAD : null,
        event_head_sha: h === "payload_head_sha" ? PR_HEAD : null,
        evaluated_head_shas: h === "evaluated_head_shas" ? [PR_HEAD] : [],
        merge_group_sha: h === "merge_group_sha" ? PR_HEAD : null,
      });
      expect(provenanceFailures(p).join(), h).toMatch(/is a head under judgement/);
    }
  });

  it("fails when a merge group's base is its head", () => {
    const p = prov({
      event: "merge_group",
      policy_on_main: null,
      event_head_sha: MG_HEAD,
      payload_head_sha: MG_HEAD,
      merge_group_sha: MG_HEAD,
      merge_group_base_sha: MG_HEAD,
    });
    expect(provenanceFailures(p).join()).toMatch(/base_sha == head_sha/);
  });

  it("fails when the workflow's head differs from the payload's", () => {
    expect(provenanceFailures(prov({ event_head_sha: S("0") })).join()).toMatch(
      /event_head_sha 0+ != the payload's head/,
    );
  });
});

// ── End to end: main() across the four events, with a stubbed API ────────────

let fixture: {
  subject: string;
  policy: string;
  offMain: string;
  base: string;
  head: Record<7 | 8, string>;
  dir: string;
  /** A bare "base repository" where the PR heads exist only as refs/pull/N/head (fork PRs). */
  upstream: string;
};

/** Generous: a loaded machine (the tamper runner runs several copies at once) is slow, never wrong. */
const E2E_TIMEOUT = 180_000;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
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
    { cwd, env: cleanEnv(), encoding: "utf-8" },
  ).trim();
}

beforeAll(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "autonomy-tier-expand-")));
  const subjectDir = join(dir, "subject");
  mkdirSync(join(subjectDir, "docs"), { recursive: true });
  mkdirSync(join(subjectDir, "src"), { recursive: true });
  gitIn(subjectDir, "init", "-q", "-b", "main");
  writeFileSync(join(subjectDir, "docs/note.md"), "# note\n");
  writeFileSync(join(subjectDir, "src/x.ts"), "export const x = 1;\n");
  gitIn(subjectDir, "add", ".");
  gitIn(subjectDir, "commit", "-q", "-m", "base");
  const base = gitIn(subjectDir, "rev-parse", "HEAD");
  // PR #7: a docs-only change (T0). PR #8: a code change (T1).
  gitIn(subjectDir, "checkout", "-q", "-b", "pr7", base);
  writeFileSync(join(subjectDir, "docs/note.md"), "# note\n\nhello, world\n");
  gitIn(subjectDir, "commit", "-q", "-am", "docs: a note (#7)");
  const h7 = gitIn(subjectDir, "rev-parse", "HEAD");
  gitIn(subjectDir, "checkout", "-q", "-b", "pr8", base);
  writeFileSync(join(subjectDir, "src/x.ts"), "export const x = 2;\n");
  gitIn(subjectDir, "commit", "-q", "-am", "feat: x (#8)");
  const h8 = gitIn(subjectDir, "rev-parse", "HEAD");
  gitIn(subjectDir, "checkout", "-q", "main");
  // The policy checkout: main's tip, with origin/main as fetched.
  gitIn(dir, "clone", "-q", subjectDir, "policy");
  // A policy checkout whose HEAD is NOT on origin/main.
  gitIn(dir, "clone", "-q", subjectDir, "off-main");
  gitIn(join(dir, "off-main"), "commit", "-q", "--allow-empty", "-m", "unmerged");
  // The base repository as GitHub serves a fork PR: its head commits are on no
  // branch of the base repository, only under refs/pull/N/head.
  gitIn(dir, "clone", "-q", "--bare", subjectDir, "upstream.git");
  const upstream = join(dir, "upstream.git");
  gitIn(upstream, "update-ref", "refs/pull/7/head", h7);
  gitIn(upstream, "update-ref", "refs/pull/8/head", h8);
  gitIn(upstream, "branch", "-q", "-D", "pr7", "pr8");
  fixture = {
    subject: subjectDir,
    policy: join(dir, "policy"),
    offMain: join(dir, "off-main"),
    base,
    head: { 7: h7, 8: h8 },
    dir,
    upstream,
  };
}, E2E_TIMEOUT);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type ReviewState = "machine-only" | "founder-at-head" | "none";

function apiReviews(state: ReviewState, head: string): unknown[] {
  const machine = {
    id: 1,
    user: { login: MACHINE_REVIEWER },
    state: "APPROVED",
    commit_id: head,
    submitted_at: "2026-10-26T00:00:00Z",
    author_association: "NONE",
  };
  const founder = {
    id: 2,
    user: { login: FOUNDER },
    state: "APPROVED",
    commit_id: head,
    submitted_at: "2026-10-26T00:01:00Z",
    author_association: "OWNER",
  };
  return state === "none" ? [] : state === "machine-only" ? [machine] : [machine, founder];
}

interface Run {
  code: number;
  verdict: Verdict;
  lines: string[];
}

async function run(
  event: string,
  pr: 7 | 8,
  state: ReviewState,
  opts: {
    autonomyT0?: string;
    policyRoot?: string;
    expected?: string;
    githubSha?: string;
    subject?: string;
  } = {},
): Promise<Run> {
  const head = fixture.head[pr];
  const payload =
    event === "merge_group"
      ? {
          merge_group: {
            base_sha: fixture.base,
            head_sha: head,
            head_ref: `refs/heads/gh-readonly-queue/main/pr-${pr}-${fixture.base}`,
          },
        }
      : { pull_request: { number: pr, head: { sha: head }, base: { sha: fixture.base } } };
  const eventPath = join(fixture.dir, `event-${event}-${pr}.json`);
  writeFileSync(eventPath, JSON.stringify(payload));
  vi.stubGlobal("fetch", (url: string) => {
    const m = /\/repos\/o\/r\/pulls\/(\d+)(\/reviews)?/.exec(url);
    if (!m || Number(m[1]) !== pr) return Promise.resolve({ ok: false, status: 404 });
    const body = m[2]
      ? apiReviews(state, head)
      : { head: { sha: head }, state: "open", base: { ref: "main" } };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  const env: NodeJS.ProcessEnv = {
    GH_TOKEN: "t",
    EXPECTED_POLICY_SHA: opts.expected ?? fixture.base,
    EVENT_HEAD_SHA: head,
    GITHUB_SHA: opts.githubSha ?? (event === "pull_request_target" ? fixture.base : S("d")),
  };
  if (opts.autonomyT0 !== undefined) env.AUTONOMY_T0 = opts.autonomyT0;
  const code = await main(
    [
      "--event-name",
      event,
      "--event-path",
      eventPath,
      "--repository",
      "o/r",
      "--subject",
      opts.subject ?? fixture.subject,
    ],
    env,
    opts.policyRoot ?? fixture.policy,
  );
  vi.restoreAllMocks();
  const lines = out.join("").split("\n");
  const json = lines.find((l) => l.startsWith('{"pass"'));
  if (json === undefined) throw new Error(`no verdict in:\n${out.join("")}`);
  return { code, verdict: JSON.parse(json) as Verdict, lines };
}

describe("the contract script end to end: every event it judges, the same verdict", () => {
  it(
    "every event the contract script judges gives the same verdict for the same PR state and AUTONOMY_T0; only the exact value on opens the switch",
    async () => {
      const cases: {
        pr: 7 | 8;
        state: ReviewState;
        autonomyT0: string | undefined;
        pass: boolean;
        reason: string;
      }[] = [
        { pr: 7, state: "machine-only", autonomyT0: "on", pass: true, reason: "t0" },
        {
          pr: 7,
          state: "machine-only",
          autonomyT0: "",
          pass: false,
          reason: "kill-switch-machine-only",
        },
        {
          pr: 7,
          state: "machine-only",
          autonomyT0: undefined,
          pass: false,
          reason: "kill-switch-machine-only",
        },
        {
          pr: 7,
          state: "machine-only",
          autonomyT0: "ON",
          pass: false,
          reason: "kill-switch-machine-only",
        },
        {
          pr: 8,
          state: "machine-only",
          autonomyT0: "on",
          pass: false,
          reason: "machine-approved-t1",
        },
        { pr: 7, state: "founder-at-head", autonomyT0: "", pass: true, reason: "founder-approved" },
        {
          pr: 8,
          state: "founder-at-head",
          autonomyT0: "on",
          pass: true,
          reason: "founder-approved",
        },
        { pr: 7, state: "none", autonomyT0: "", pass: true, reason: "no-machine-approval" },
      ];
      for (const c of cases) {
        for (const event of PHASE_EVENTS[MIGRATION_PHASE]) {
          const r = await run(event, c.pr, c.state, { autonomyT0: c.autonomyT0 });
          const label = `${event} #${c.pr} ${c.state} AUTONOMY_T0=${String(c.autonomyT0)}`;
          expect(r.verdict.reason, label).toBeUndefined();
          expect(
            r.verdict.prs.map((v) => [v.pass, v.reason]),
            label,
          ).toEqual([[c.pass, c.reason]]);
          expect(r.code, label).toBe(c.pass ? 0 : 1);
        }
      }
    },
    E2E_TIMEOUT,
  );

  it(
    "logs the observed AUTONOMY_T0 and that it is read",
    async () => {
      const r = await run("pull_request_target", 7, "none", { autonomyT0: "on" });
      expect(r.lines).toContain('autonomy-tier: AUTONOMY_T0 observed "on" (contract phase: read)');
    },
    E2E_TIMEOUT,
  );

  it(
    "logs one provenance line: the policy sha, the API head and the review snapshot judged",
    async () => {
      const r = await run("pull_request_target", 7, "machine-only");
      const p = r.lines.filter((l) => l.startsWith("autonomy-tier: provenance "));
      expect(p).toHaveLength(1);
      const logged = JSON.parse(p[0]!.slice("autonomy-tier: provenance ".length)) as Provenance;
      expect(logged).toMatchObject({
        event: "pull_request_target",
        phase: "contract",
        policy_sha: fixture.base,
        expected_policy_sha: fixture.base,
        policy_on_main: true,
        evaluated_head_shas: [fixture.head[7]],
        merge_group_sha: null,
        decision: "fail",
      });
      expect(logged.reviews).toEqual([
        {
          pr: 7,
          head_sha: fixture.head[7],
          reviews: [
            {
              id: 1,
              login: MACHINE_REVIEWER,
              state: "APPROVED",
              commit_id: fixture.head[7],
              submitted_at: "2026-10-26T00:00:00Z",
            },
          ],
        },
      ]);
    },
    E2E_TIMEOUT,
  );

  it(
    "fails policy-provenance when the policy checkout is not the expected revision",
    async () => {
      for (const event of PHASE_EVENTS[MIGRATION_PHASE]) {
        const r = await run(event, 7, "none", { expected: fixture.head[7] });
        expect(r.verdict, event).toMatchObject({ pass: false, reason: "policy-provenance" });
        expect(r.code).toBe(1);
      }
    },
    E2E_TIMEOUT,
  );

  it(
    "fails policy-provenance on a PR event when the policy commit is not on main",
    async () => {
      const offMain = gitIn(fixture.offMain, "rev-parse", "HEAD");
      const r = await run("pull_request_target", 7, "none", {
        policyRoot: fixture.offMain,
        expected: offMain,
        githubSha: offMain,
      });
      expect(r.verdict).toMatchObject({ pass: false, reason: "policy-provenance" });
      expect(r.verdict.summary).toMatch(/not an ancestor of origin\/main/);
    },
    E2E_TIMEOUT,
  );

  it(
    "the fetch step, run as written, takes a fork PR's head from the base repository's refs/pull/N/head into a bare store the verdict judges from",
    async () => {
      // The fork case: the head commits are on no branch of the base repository.
      expect(gitIn(fixture.upstream, "branch", "--contains", fixture.head[7])).toBe("");
      for (const event of ["pull_request_target", "merge_group"]) {
        const ws = realpathSync(mkdtempSync(join(fixture.dir, "ws-")));
        mkdirSync(join(ws, "trusted"));
        for (const pr of [7, 8] as const) {
          execFileSync("bash", ["-e", "-c", fetchStep!.run!], {
            cwd: join(ws, "trusted"),
            env: cleanEnv(process.env, {
              GITHUB_WORKSPACE: ws,
              GITHUB_SERVER_URL: `file://${fixture.dir}`,
              GITHUB_REPOSITORY: "upstream.git",
              EVENT_BASE_SHA: fixture.base,
              EVENT_HEAD_SHA: fixture.head[pr],
            }),
            stdio: "pipe",
          });
          const store = join(ws, "subject.git");
          expect(gitIn(store, "rev-parse", "--is-bare-repository")).toBe("true");
          expect(gitIn(store, "rev-parse", "refs/autonomy-tier/head")).toBe(fixture.head[pr]);
          expect(gitIn(store, "rev-parse", "refs/autonomy-tier/base")).toBe(fixture.base);
          const r = await run(event, pr, "machine-only", { subject: store });
          expect(r.verdict.reason, `${event} #${pr}`).toBeUndefined();
          expect(
            r.verdict.prs.map((v) => v.reason),
            `${event} #${pr}`,
          ).toEqual([pr === 7 ? "kill-switch-machine-only" : "machine-approved-t1"]);
        }
      }
    },
    E2E_TIMEOUT,
  );
});
