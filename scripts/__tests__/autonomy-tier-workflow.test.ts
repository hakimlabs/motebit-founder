/**
 * autonomy-tier workflow — the trigger and pwn-request invariants of
 * `.github/workflows/autonomy-tier.yml`, read from the REAL file.
 *
 * The defect this pins (seen live on #1181, 2026-10-27): every agent PR comes
 * from a fork, and GitHub passes no repository variables to a fork PR's
 * `pull_request` / `pull_request_review` run, so `AUTONOMY_T0` read '' and the
 * kill switch could never be off. The check now runs on `pull_request_target`
 * and `merge_group` only (both see the variables), which makes the second half
 * load-bearing: under `pull_request_target` no PR-head code may run, the token
 * stays read-only, and no event field reaches a script.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { judgedEvent } from "../autonomy-tier-verdict.js";

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
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = wf.jobs["autonomy-tier"]!;
const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const trusted = checkouts.find((s) => s.with?.path === "trusted");
const subject = checkouts.find((s) => s.with?.path === "subject");

describe("judgedEvent: only events that see the repository variables are judged", () => {
  it("judges pull_request_target as a PR and merge_group as a queue group", () => {
    expect(judgedEvent("pull_request_target")).toBe("pull-request");
    expect(judgedEvent("merge_group")).toBe("merge-group");
  });

  it("refuses pull_request and pull_request_review (fork runs carry no variables)", () => {
    expect(() => judgedEvent("pull_request")).toThrow(/unsupported event 'pull_request'/);
    expect(() => judgedEvent("pull_request_review")).toThrow(
      /unsupported event 'pull_request_review'/,
    );
  });

  it("refuses any other event, and an empty name", () => {
    for (const e of ["workflow_run", "issue_comment", "push", "workflow_dispatch", ""]) {
      expect(() => judgedEvent(e)).toThrow(/unsupported event/);
    }
  });
});

describe("the autonomy-tier workflow's triggers", () => {
  it("triggers on pull_request_target and merge_group only", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["merge_group", "pull_request_target"]);
  });

  it("pull_request_target covers every PR-side change into main", () => {
    expect(wf.on.pull_request_target).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review", "edited"],
    });
    expect(wf.on.merge_group).toEqual({ types: ["checks_requested"] });
  });

  it("every trigger is an event the verdict script judges", () => {
    for (const e of Object.keys(wf.on)) expect(() => judgedEvent(e)).not.toThrow();
  });

  it("is one job named autonomy-tier with no job-level if (a skipped job reports success)", () => {
    expect(Object.keys(wf.jobs)).toEqual(["autonomy-tier"]);
    expect(job.if).toBeUndefined();
  });

  it("reads the kill switch from the repository variable on the verdict step", () => {
    const verdict = job.steps.filter((s) => s.run?.includes("scripts/autonomy-tier-verdict.ts"));
    expect(verdict).toHaveLength(1);
    expect(verdict[0]!.env?.AUTONOMY_T0).toBe("${{ vars.AUTONOMY_T0 }}");
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

  it("checks out exactly the base and the head, neither persisting credentials", () => {
    expect(checkouts).toHaveLength(2);
    expect(trusted).toBeDefined();
    expect(subject).toBeDefined();
    for (const c of checkouts) expect(c.with?.["persist-credentials"]).toBe(false);
  });

  it("the trusted checkout is the base, never the PR head", () => {
    const ref = String(trusted!.with?.ref);
    expect(ref).not.toMatch(/head/);
    expect(ref).toBe(
      "${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.sha }}",
    );
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

  it("nothing in the whole workflow names subject/ but the head checkout's path and the verdict's --subject argument", () => {
    // Every string and key in the WHOLE parsed workflow (top-level env and
    // defaults, the job, every step, every run body), with exactly two
    // exceptions matched by step identity: `with.path` of the head checkout
    // step, and the one `--subject "$GITHUB_WORKSPACE/subject"` argument of
    // the verdict step's run body.
    const SUBJECT_ARG = '--subject "$GITHUB_WORKSPACE/subject"';
    const verdictStep = job.steps.find((s) => s.run?.includes("scripts/autonomy-tier-verdict.ts"));
    expect(verdictStep).toBeDefined();
    expect(verdictStep!.run!.split(SUBJECT_ARG)).toHaveLength(2);
    const hits: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") {
        if (/subject/i.test(v)) hits.push(at);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${at}[${i}]`));
      } else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (/subject/i.test(k)) hits.push(`${at}.<key ${k}>`);
          if (v === subject?.with && k === "path" && x === "subject") continue;
          if (v === verdictStep && k === "run" && typeof x === "string") {
            walk(x.replace(SUBJECT_ARG, ""), `${at}.run`);
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
