#!/usr/bin/env node
/**
 * Tamper checks for "who may write dispute state" (PR 2 of
 * docs/proposals/dispute-money-path-v1.md, M6). Each entry is (file, text to
 * revert, test expected red), run by the shared runner
 * (scripts/lib/tamper-runner.ts) in an isolated copy of the tree, the named
 * test alone (`only`: vitest `-t` anchored to its exact full name):
 *
 *   - the round-1 state guard removed — a `final` dispute is flipped back to
 *     `resolved`, and a dispute that left adjudication mid-/resolve is
 *     resolved anyway;
 *   - both one-winner layers removed (the state guard and the UNIQUE
 *     backstop, by `INSERT OR REPLACE`) — two racing round-1 commits both
 *     report persisted;
 *   - the round-1-only refusal removed — a round-2 call no longer throws;
 *   - `/resolve`'s `persisted` check removed — single-relay and synchronous
 *     federation both answer 200 on a verdict they did not commit;
 *   - the worker's round-2 re-point removed — a due round-2 row goes through
 *     the round-1 writer and the appeal's fund action never runs.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/dispute-write-guards.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const ORCH = "services/relay/src/dispute-orchestration.ts";
const DISPUTES = "services/relay/src/disputes.ts";
// Run as commands with a red marker, not as vitest entries: the repo's vitest
// config pins the JSON reporter's outputFile (vitest.shared.ts
// TEST_RESULTS_FILE, #1062), so the runner's own JSON report is never written
// and a vitest entry reads "BASELINE NOT GREEN". Each command runs the named
// test alone (`-t`, anchored to its exact full name); vitest prints
// "Test Files  1 failed" only when that test fails, and a name that matches
// nothing skips the file (no marker), so a stale name reads GREEN, never RED.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const only = (red) => ({
  command: [
    "pnpm",
    "--filter",
    "@motebit/relay",
    "exec",
    "vitest",
    "run",
    "src/__tests__/dispute-write-guards.test.ts",
    "-t",
    `^${escapeRegExp(red)}$`,
  ],
  redMarker: "Test Files  1 failed",
});

const FINALIZE = "finalizeFederationResolution: round 1 commits only from evidence or arbitration";
const RESOLVE = "/resolve answers 409 with the standing record when its verdict did not commit";
const WORKER = "the deferred worker's round 2 commits through commitRound2Verdict";

const STATE_GUARD = {
  file: ORCH,
  from: "           WHERE dispute_id = ? AND state IN ('evidence', 'arbitration')`,",
  to: "           WHERE dispute_id = ?`,",
};
const PERSISTED_CHECK = {
  file: DISPUTES,
  from: '      if (!committed.persisted) {\n        logger.warn("dispute.resolve.not_committed", {',
  to: '      if ((false as boolean) && !committed.persisted) {\n        logger.warn("dispute.resolve.not_committed", {',
};

const TAMPERS = [
  {
    name: "the round-1 state guard removed (a final dispute)",
    edits: [STATE_GUARD],
    ...only(
      `${FINALIZE} a final dispute with no round-1 row stays final: nothing is written and the standing record is reported`,
    ),
  },
  {
    name: "the round-1 state guard removed (a resolved dispute)",
    edits: [STATE_GUARD],
    ...only(
      `${FINALIZE} a resolved dispute with no round-1 row stays resolved: nothing is written and the standing record is reported`,
    ),
  },
  {
    name: "the round-1 state guard removed (a dispute that left adjudication during /resolve)",
    edits: [STATE_GUARD],
    ...only(
      `${RESOLVE} single-relay: a dispute that left evidence/arbitration during the resolve is 409 and keeps its state`,
    ),
  },
  {
    name: "both one-winner layers removed (state guard + UNIQUE backstop)",
    edits: [
      STATE_GUARD,
      {
        file: ORCH,
        from: "        `INSERT INTO relay_dispute_resolutions\n           (resolution_id, dispute_id, round,",
        to: "        `INSERT OR REPLACE INTO relay_dispute_resolutions\n           (resolution_id, dispute_id, round,",
      },
    ],
    ...only(
      `${FINALIZE} two round-1 commits racing write one resolution, and the loser reports the standing record`,
    ),
  },
  {
    name: "the round-1-only refusal removed",
    edits: [
      {
        file: ORCH,
        from: "  if (args.round !== 1) {",
        to: "  if ((false as boolean) && args.round !== 1) {",
      },
    ],
    ...only(
      `${FINALIZE} round 2 can no longer be written through it: an appealed dispute keeps its state and gains no round-2 row`,
    ),
  },
  {
    name: "/resolve's persisted check removed (single-relay)",
    edits: [PERSISTED_CHECK],
    ...only(
      `${RESOLVE} single-relay: a round-1 commit that lost the race to another process's commit is 409, not 200`,
    ),
  },
  {
    name: "/resolve's persisted check removed (synchronous federation)",
    edits: [PERSISTED_CHECK],
    ...only(
      `${RESOLVE} synchronous federation: a round-1 commit that lost the race to the worker's commit during the fan-out is 409, not 200`,
    ),
  },
  {
    name: "the worker's round-2 re-point removed (round 2 through the round-1 writer)",
    edits: [
      {
        file: DISPUTES,
        from: "        if (item.round === 2) {\n          // Round 2 has one writer",
        to: "        if ((false as boolean) && item.round === 2) {\n          // Round 2 has one writer",
      },
    ],
    ...only(
      `${WORKER} a due round-2 row finalizes the appeal AND executes its fund action in the same commit`,
    ),
  },
];

await runTampers(TAMPERS, { root: ROOT });
