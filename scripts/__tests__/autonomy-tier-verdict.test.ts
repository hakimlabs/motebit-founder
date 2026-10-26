/**
 * autonomy-tier-verdict — the reviewer-identity logic of the `autonomy-tier`
 * required check, enumerated exhaustively against an oracle written straight
 * from the design sentence (docs/proposals/repo-autonomy-v1.md):
 *
 *   passes iff T0, OR hakimlabs approved, OR no motebit-reviewer approval;
 *   fails when motebit-reviewer approved a T1 PR, and when AUTONOMY_T0 is off
 *   and the only approval is the machine user's.
 *
 * Refinements the oracle states explicitly: a classifier error is T1; a
 * founder approval counts only on the current head; the kill switch is
 * disengaged only by the exact value "on" (unset/empty engage it).
 */
import { describe, expect, it } from "vitest";

import {
  FOUNDER,
  MACHINE_REVIEWER,
  decide,
  decidePr,
  killSwitchEngaged,
  mergeGroupPrs,
  standingStates,
  type PrInput,
  type Review,
} from "../autonomy-tier-verdict.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
let nextId = 1;
const review = (
  login: string,
  state: string,
  commitId = HEAD,
  at = `2026-10-26T00:00:${String(nextId).padStart(2, "0")}Z`,
): Review => ({
  id: nextId++,
  login,
  state,
  commitId,
  submittedAt: at,
});

const pr = (tier: PrInput["tier"], reviews: Review[]): PrInput => ({
  number: 1,
  headSha: HEAD,
  tier,
  tierDetail: "fixture",
  reviews,
});

type Founder = "none" | "head" | "stale" | "changes-requested";
type Machine = "none" | "approved" | "approved-stale" | "dismissed" | "commented";

function oracle(
  tier: PrInput["tier"],
  founder: Founder,
  machine: Machine,
  other: boolean,
  killVar: string | undefined,
): boolean {
  const machineApproved = machine === "approved" || machine === "approved-stale";
  const founderApproved = founder === "head";
  const isT0 = tier === "T0";
  if (founderApproved) return true;
  if (!machineApproved) return true;
  if (!isT0) return false; // machine approved a T1 (or errored) PR
  const killOn = killVar !== "on";
  const onlyMachine = !other; // `other` approves HEAD; a stale founder approval is not another approval
  if (killOn && onlyMachine) return false;
  return true;
}

function reviewsFor(founder: Founder, machine: Machine, other: boolean): Review[] {
  const out: Review[] = [];
  if (founder === "head") out.push(review(FOUNDER, "APPROVED", HEAD));
  if (founder === "stale") out.push(review(FOUNDER, "APPROVED", OLD));
  if (founder === "changes-requested") {
    out.push(review(FOUNDER, "APPROVED", HEAD));
    out.push(review(FOUNDER, "CHANGES_REQUESTED", HEAD));
  }
  if (machine === "approved") out.push(review(MACHINE_REVIEWER, "APPROVED", HEAD));
  if (machine === "approved-stale") out.push(review(MACHINE_REVIEWER, "APPROVED", OLD));
  if (machine === "dismissed") {
    out.push(review(MACHINE_REVIEWER, "APPROVED", HEAD));
    out.push(review(MACHINE_REVIEWER, "DISMISSED", HEAD));
  }
  if (machine === "commented") {
    out.push(review(MACHINE_REVIEWER, "COMMENTED", HEAD));
  }
  if (other) out.push(review("some-maintainer", "APPROVED", HEAD));
  return out;
}

describe("decidePr — exhaustive against the design oracle", () => {
  const tiers: PrInput["tier"][] = ["T0", "T1", "error"];
  const founders: Founder[] = ["none", "head", "stale", "changes-requested"];
  const machines: Machine[] = ["none", "approved", "approved-stale", "dismissed", "commented"];
  const kills: (string | undefined)[] = ["on", "off", undefined, "", "On"];
  let cases = 0;
  for (const tier of tiers)
    for (const founder of founders)
      for (const machine of machines)
        for (const other of [false, true])
          for (const kill of kills) {
            cases++;
            const want = oracle(tier, founder, machine, other, kill);
            it(`${tier} founder=${founder} machine=${machine} other=${other} AUTONOMY_T0=${JSON.stringify(kill)} → ${want ? "pass" : "FAIL"}`, () => {
              expect(decidePr(pr(tier, reviewsFor(founder, machine, other)), kill).pass).toBe(want);
            });
          }
  it("enumerated the whole space", () => {
    expect(cases).toBe(3 * 4 * 5 * 2 * 5);
  });
});

describe("the named design cases", () => {
  it("FAILS when motebit-reviewer approved a T1 PR", () => {
    const v = decidePr(pr("T1", [review(MACHINE_REVIEWER, "APPROVED")]), "on");
    expect(v).toMatchObject({ pass: false, reason: "machine-approved-t1" });
  });

  it("FAILS when the classifier errored and motebit-reviewer approved (error is T1)", () => {
    expect(decidePr(pr("error", [review(MACHINE_REVIEWER, "APPROVED")]), "on")).toMatchObject({
      pass: false,
      reason: "machine-approved-t1",
    });
  });

  it("FAILS when AUTONOMY_T0 is off and the only approval is motebit-reviewer's, even on T0", () => {
    expect(decidePr(pr("T0", [review(MACHINE_REVIEWER, "APPROVED")]), "off")).toMatchObject({
      pass: false,
      reason: "kill-switch-machine-only",
    });
  });

  it("an unset kill-switch variable engages it (fail closed)", () => {
    expect(killSwitchEngaged(undefined)).toBe(true);
    expect(killSwitchEngaged("")).toBe(true);
    expect(killSwitchEngaged("ON")).toBe(true);
    expect(killSwitchEngaged("on")).toBe(false);
  });

  it("passes T0 approved by motebit-reviewer when AUTONOMY_T0 is on", () => {
    expect(decidePr(pr("T0", [review(MACHINE_REVIEWER, "APPROVED")]), "on")).toMatchObject({
      pass: true,
      reason: "t0",
    });
  });

  it("passes a T1 PR the founder approved at head, even with a machine approval", () => {
    const v = decidePr(
      pr("T1", [review(MACHINE_REVIEWER, "APPROVED"), review(FOUNDER, "APPROVED", HEAD)]),
      "off",
    );
    expect(v).toMatchObject({ pass: true, reason: "founder-approved" });
  });

  it("a STALE founder approval does not carry a machine-approved T1 head", () => {
    const v = decidePr(
      pr("T1", [review(FOUNDER, "APPROVED", OLD), review(MACHINE_REVIEWER, "APPROVED", HEAD)]),
      "on",
    );
    expect(v).toMatchObject({ pass: false, reason: "machine-approved-t1" });
  });

  it("a STALE machine approval still binds", () => {
    expect(decidePr(pr("T1", [review(MACHINE_REVIEWER, "APPROVED", OLD)]), "on").pass).toBe(false);
  });

  it("passes a T1 PR with no machine approval (the founder's ruleset review still applies)", () => {
    expect(decidePr(pr("T1", []), "off")).toMatchObject({
      pass: true,
      reason: "no-machine-approval",
    });
  });

  it("matches logins case-insensitively", () => {
    expect(decidePr(pr("T1", [review("Motebit-Reviewer", "APPROVED")]), "on").pass).toBe(false);
    expect(
      decidePr(
        pr("T1", [review("Motebit-Reviewer", "APPROVED"), review("HakimLabs", "APPROVED")]),
        "on",
      ).pass,
    ).toBe(true);
  });

  it("an impostor login is not the machine reviewer, and not the founder", () => {
    expect(decidePr(pr("T1", [review("motebit-reviewer-2", "APPROVED")]), "on").reason).toBe(
      "no-machine-approval",
    );
    expect(
      decidePr(
        pr("T1", [review(MACHINE_REVIEWER, "APPROVED"), review("hakimlabs-bot", "APPROVED")]),
        "on",
      ).pass,
    ).toBe(false);
  });
});

describe("standingStates — GitHub's latest-state-changing review", () => {
  it("a later CHANGES_REQUESTED or DISMISSED replaces an approval; COMMENTED does not", () => {
    const s = standingStates([
      review("x", "APPROVED", HEAD, "2026-01-01T00:00:00Z"),
      review("x", "COMMENTED", HEAD, "2026-01-02T00:00:00Z"),
      review("y", "APPROVED", HEAD, "2026-01-01T00:00:00Z"),
      review("y", "DISMISSED", HEAD, "2026-01-02T00:00:00Z"),
      review("z", "CHANGES_REQUESTED", HEAD, "2026-01-01T00:00:00Z"),
      review("z", "APPROVED", HEAD, "2026-01-02T00:00:00Z"),
    ]);
    expect(s.get("x")!.state).toBe("APPROVED");
    expect(s.get("y")!.state).toBe("DISMISSED");
    expect(s.get("z")!.state).toBe("APPROVED");
  });

  it("orders by submission time, not by list order", () => {
    const s = standingStates([
      review("x", "CHANGES_REQUESTED", HEAD, "2026-01-02T00:00:00Z"),
      review("x", "APPROVED", HEAD, "2026-01-01T00:00:00Z"),
    ]);
    expect(s.get("x")!.state).toBe("CHANGES_REQUESTED");
  });
});

describe("decide — a merge group passes only if every PR passes", () => {
  it("one failing PR fails the group", () => {
    const ok = pr("T0", []);
    const bad = { ...pr("T1", [review(MACHINE_REVIEWER, "APPROVED")]), number: 2 };
    const v = decide([ok, bad], "on");
    expect(v.pass).toBe(false);
    expect(v.summary).toMatch(/#2 FAIL/);
  });

  it("no PR to judge fails closed", () => {
    expect(decide([], "on").pass).toBe(false);
  });
});

describe("mergeGroupPrs", () => {
  const sha = (c: string): string => c.repeat(40);

  it("maps each squash commit to its PR and requires the queue ref's PR among them", () => {
    expect(
      mergeGroupPrs(
        [
          { sha: sha("1"), subject: "docs: a (#10)" },
          { sha: sha("2"), subject: "fix(relay): b (#11)" },
        ],
        `refs/heads/gh-readonly-queue/main/pr-11-${sha("c")}`,
      ),
    ).toEqual([
      { sha: sha("1"), number: 10 },
      { sha: sha("2"), number: 11 },
    ]);
  });

  it("fails closed on a commit naming no PR", () => {
    expect(() =>
      mergeGroupPrs(
        [{ sha: sha("1"), subject: "sneaky direct commit" }],
        `gh-readonly-queue/main/pr-1-${sha("c")}`,
      ),
    ).toThrow(/names no PR/);
  });

  it("fails closed when the queue ref's PR is not in the group", () => {
    expect(() =>
      mergeGroupPrs(
        [{ sha: sha("1"), subject: "a (#10)" }],
        `gh-readonly-queue/main/pr-99-${sha("c")}`,
      ),
    ).toThrow(/queue ref/);
  });

  it("fails closed on an empty group", () => {
    expect(() => mergeGroupPrs([], "gh-readonly-queue/main/pr-1-abc")).toThrow(/no commits/);
  });
});
