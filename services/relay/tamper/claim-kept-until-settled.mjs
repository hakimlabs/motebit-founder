#!/usr/bin/env node
/**
 * Tamper checks for the kept-claim law (#1152 M3, services/relay/CLAUDE.md
 * rule 34). Each entry is (file, text to revert, test expected red), run by
 * the shared runner (scripts/lib/tamper-runner.ts) in an isolated copy of the
 * tree:
 *
 *   - the queue's `heldClaim` gets its 7-day `expires_at` floor back — the
 *     cleanup and the eviction cases go red;
 *   - `cleanupTaskRoutes` deletes the route / the archived answer of an
 *     unsettled claim — the route / archive cases go red;
 *   - the stale sweep's claim skip removed — the race (a) and the sweep-skip
 *     cases go red; `holdsUnsettledClaim` reading only the queue — the
 *     archive-read case goes red;
 *   - retry exhaustion's `claim_unrecoverable_at` skip removed — the
 *     record-unrecoverable case goes red (the sweep's marker skip is today
 *     subsumed by its unsettled-claim skip, so it has no entry of its own);
 *   - F1: a settled claim not clearing its markers, and retry exhaustion
 *     holding on a marker whose claim already settled — the forward probe
 *     and the stale-marker cases go red; the settle erasing the operator's
 *     evidence or not stamping `claim_unrecoverable_cleared_at` — the forward
 *     probe goes red;
 *   - the 12-failure mark never set, or a disputed replay counted — the
 *     visibility cases go red;
 *   - the door's disputed refusal removed — the disputed case goes red;
 *   - the door's bearerAuth registration removed — check-admin-route-auth
 *     goes red.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/claim-kept-until-settled.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const QUEUE = "services/relay/src/task-queue.ts";
const ROUTING = "services/relay/src/task-routing.ts";
const INDEX = "services/relay/src/index.ts";
const CLAIM = "services/relay/src/claim-settlement.ts";
const MIDDLEWARE = "services/relay/src/middleware.ts";
const TEST = "src/__tests__/claim-kept-until-settled.test.ts";

// Run as commands with a red marker, written while vitest entries could not
// run (#1062; see services/relay/tamper/federation-recipient-binding.mjs).
// Vitest entries work again since the runner names its own reporter; command
// mode remains valid. `-t`, anchored to the exact full name, narrows
// each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const only = (red) => ({
  command: [
    "pnpm",
    "--filter",
    "@motebit/relay",
    "exec",
    "vitest",
    "run",
    TEST,
    "-t",
    `^${escapeRegExp(red)}$`,
  ],
  redMarker: "Test Files  1 failed",
});

const RACE =
  "kept claim: the race (a) a task-cleanup tick that lands while the settlement step awaits never refunds the delegator; the worker is paid once";
const H = "kept claim: the 8-day horizon (b)";
const CLEANUP = `${H} queue cleanup keeps a claimed, unsettled entry 8 days past its expiry`;
const EVICT = `${H} queue eviction keeps a claimed, unsettled entry 8 days past its expiry`;
const ARCHIVE = `${H} the answer archive keeps a claimed, unsettled answer 8 days on, even with no queue entry`;
const ROUTE = `${H} the task route of a claimed, unsettled answer is kept 8 days on`;
const SK = "kept claim: the refund doors skip it";
const SWEEP_SKIP = `${SK} the stale sweep skips an allocation whose task holds a claimed, unsettled answer`;
const SWEEP_ARCHIVE = `${SK} the stale sweep reads the claim from the archive when the queue entry is gone`;
const V = "kept claim: settlement_blocked_at (visibility only)";
const BLOCKED = `${V} is set after 12 consecutive failed replays; retries continue and the claim still settles`;
const DISPUTED_COUNT = `${V} a replay on a disputed allocation is not counted as a failure`;
const D = "kept claim: the operator door (resolve-blocked)";
const UNRECOVERABLE = `${D} record-unrecoverable moves no money, keeps the escrow held, and no sweep or retry refund ever refunds it`;
const PROBE = `${D} a claim recorded unrecoverable that then settles by a forward, which exhausts, is refunded as on main and the marker is cleared`;
const STALE_MARKER = `${D} a marker left on a claim that has settled never holds the escrow against retry exhaustion`;
const DOOR_DISPUTED = `${D} refuses both claim actions while the allocation is disputed`;

const FLOOR_FROM = "    const heldClaim = UNSETTLED_CLAIM_IN_QUEUE;";
const FLOOR_TO =
  "    const heldClaim = `(${UNSETTLED_CLAIM_IN_QUEUE} AND expires_at >= ${Date.now() - 7 * 24 * 60 * 60 * 1000})`;";
const SWEEP_FROM = "        if (holdsUnsettledClaim(db, alloc.task_id)) {";
const SWEEP_TO = "        if ((false as boolean) && holdsUnsettledClaim(db, alloc.task_id)) {";

const TAMPERS = [
  {
    name: "heldClaim's expires_at floor restored (queue cleanup)",
    edits: [{ file: QUEUE, from: FLOOR_FROM, to: FLOOR_TO }],
    ...only(CLEANUP),
  },
  {
    name: "heldClaim's expires_at floor restored (queue eviction)",
    edits: [{ file: QUEUE, from: FLOOR_FROM, to: FLOOR_TO }],
    ...only(EVICT),
  },
  {
    name: "cleanupTaskRoutes deletes an unsettled claim's route",
    edits: [
      {
        file: ROUTING,
        from: "      `DELETE FROM relay_task_routes WHERE created_at < ?\n         AND task_id NOT IN (${UNSETTLED_CLAIM_TASK_IDS})`,",
        to: "      `DELETE FROM relay_task_routes WHERE created_at < ?`,",
      },
    ],
    ...only(ROUTE),
  },
  {
    name: "cleanupTaskRoutes deletes an unsettled claim's archived answer",
    edits: [
      {
        file: ROUTING,
        from: "         AND NOT ${UNSETTLED_CLAIM_IN_ARCHIVE}\n",
        to: "",
      },
    ],
    ...only(ARCHIVE),
  },
  {
    name: "the stale sweep's unsettled-claim skip removed (the race)",
    edits: [{ file: INDEX, from: SWEEP_FROM, to: SWEEP_TO }],
    ...only(RACE),
  },
  {
    name: "the stale sweep's unsettled-claim skip removed (sweep)",
    edits: [{ file: INDEX, from: SWEEP_FROM, to: SWEEP_TO }],
    ...only(SWEEP_SKIP),
  },
  {
    name: "holdsUnsettledClaim reads only the queue",
    edits: [
      {
        file: QUEUE,
        from: "         UNION ALL\n         SELECT 1 FROM relay_task_answers WHERE task_id = ? AND ${UNSETTLED_CLAIM_IN_ARCHIVE}\n",
        to: "         UNION ALL\n         SELECT 1 FROM relay_task_answers WHERE task_id = ? AND 0\n",
      },
    ],
    ...only(SWEEP_ARCHIVE),
  },
  {
    name: "retry exhaustion's claim_unrecoverable_at skip removed",
    edits: [
      {
        file: INDEX,
        from: '      alloc.status === "locked" &&\n      alloc.claim_unrecoverable_at != null &&\n',
        to: "      (false as boolean) &&\n      alloc.claim_unrecoverable_at != null &&\n",
      },
    ],
    ...only(UNRECOVERABLE),
  },
  {
    name: "a settled claim no longer clears its allocation's markers (F1a)",
    edits: [
      {
        file: QUEUE,
        from: "      if (current.settled === true) this.clearClaimMarkers(taskId);",
        to: "      if ((false as boolean) && current.settled === true) this.clearClaimMarkers(taskId);",
      },
    ],
    ...only(PROBE),
  },
  {
    name: "retry exhaustion holds on a marker whose claim already settled (F1b)",
    edits: [
      {
        file: INDEX,
        from: "      alloc.claim_unrecoverable_at != null &&\n      holdsUnsettledClaim(db, retry.task_id);",
        to: "      alloc.claim_unrecoverable_at != null;",
      },
    ],
    ...only(STALE_MARKER),
  },
  {
    name: "a settled claim erases the operator's evidence (audit trail)",
    edits: [
      {
        file: QUEUE,
        from: "                claim_unrecoverable_at = NULL,\n                settlement_blocked_at = NULL, settlement_replay_failures = 0",
        to: "                claim_unrecoverable_at = NULL, claim_unrecoverable_evidence = NULL,\n                settlement_blocked_at = NULL, settlement_replay_failures = 0",
      },
    ],
    ...only(PROBE),
  },
  {
    name: "a settled claim records no claim_unrecoverable_cleared_at (audit trail)",
    edits: [
      {
        file: QUEUE,
        from: "            SET claim_unrecoverable_cleared_at = CASE WHEN claim_unrecoverable_at IS NOT NULL\n                  THEN ? ELSE claim_unrecoverable_cleared_at END,",
        to: "            SET claim_unrecoverable_cleared_at = CASE WHEN claim_unrecoverable_at IS NOT NULL AND ? IS NULL\n                  THEN 1 ELSE claim_unrecoverable_cleared_at END,",
      },
    ],
    ...only(PROBE),
  },
  {
    name: "settlement_blocked_at never set",
    edits: [
      {
        file: CLAIM,
        from: "WHEN settlement_blocked_at IS NULL AND settlement_replay_failures + 1 >= ? THEN ?",
        to: "WHEN 0 AND settlement_replay_failures + 1 >= ? THEN ?",
      },
    ],
    ...only(BLOCKED),
  },
  {
    name: "a replay on a disputed allocation counted as a failure",
    edits: [
      {
        file: CLAIM,
        from: "        WHERE task_id = ? AND status <> 'disputed'`,",
        to: "        WHERE task_id = ?`,",
      },
    ],
    ...only(DISPUTED_COUNT),
  },
  {
    name: "the door's disputed refusal removed",
    edits: [
      {
        file: CLAIM,
        from: '    if (alloc.status === "disputed") {',
        to: '    if ((false as boolean) && alloc.status === "disputed") {',
      },
    ],
    ...only(DOOR_DISPUTED),
  },
  {
    name: "the door's bearerAuth registration removed",
    edits: [
      {
        file: MIDDLEWARE,
        from: '  app.use("/api/v1/admin/allocations/*", bearerAuth({ token: apiToken }));\n',
        to: "",
      },
    ],
    command: ["pnpm", "exec", "tsx", "scripts/check-admin-route-auth.ts"],
    redMarker: "no bearerAuth coverage",
  },
];

await runTampers(TAMPERS, { root: ROOT });
