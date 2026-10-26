/**
 * The kept-claim law (#1152 M3; design `docs/proposals/dispute-money-path-v1.md`
 * §M3, §M5 "the one operator door", PR 1).
 *
 * A claimed-but-unsettled answer (`settling` set, `settled` not) is money
 * still owed a decision: a worker answered with a valid signed receipt and the
 * relay claimed that receipt's settlement, but the settlement step has not
 * completed (a crash, a failed step, or the step still awaiting). Such a claim
 * is KEPT until it settles:
 *
 *   - its three replay stores are kept with no time limit: the queue entry
 *     (`TaskQueue.cleanup` / `evict`), the archived answer and the task's
 *     route (`cleanupTaskRoutes`) — `holdsUnsettledClaim` reads both stores;
 *   - the stale sweep / task-cleanup (`releaseStaleAllocations`) never
 *     refunds its escrow to the delegator over the valid receipt (the
 *     retry-exhaustion refund is not stopped by an unsettled claim: a
 *     federated origin's claim settles BY the forward whose exhaustion proves
 *     it was never delivered). That also closes a race
 *     with no dispute in it: once `answerTask` wrote the receipt the "granted
 *     and unanswered" protection ended, and a sweep tick landing while the
 *     settlement step awaited refunded the delegator first;
 *   - the operator can record a claim that can never settle UNRECOVERABLE
 *     (`claim_unrecoverable_at`, with evidence). That is a durable marker the
 *     stale sweep AND the retry-exhaustion refund skip on (on a `locked`
 *     allocation), so the escrow STAYS held: releasing it to the
 *     hold payer over a valid signed receipt would be a substituted refund.
 *     The authorized exit for such a claim is a pre-settlement dispute.
 *
 * `settlement_blocked_at` is set after 12 consecutive failed recovery replays
 * of the claim. It is VISIBILITY ONLY (admin health): no money path reads it,
 * and recovery keeps retrying with no cap.
 */
import type { Hono } from "hono";
import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { holdsUnsettledClaim } from "./task-queue.js";

const logger = createLogger({ service: "relay", module: "claim-settlement" });

/** Consecutive failed replays of one claim after which it is shown blocked. */
export const SETTLEMENT_BLOCKED_AFTER_FAILURES = 12;

/** The longest evidence string `record-unrecoverable` keeps. */
export const CLAIM_EVIDENCE_MAX_CHARS = 2000;

/**
 * Count one recovery replay of `taskId`'s claim on its allocation (there is
 * at most one: `relay_allocations.task_id` is UNIQUE). A settled replay
 * clears the count and the blocked mark; a failed one adds one, and the
 * twelfth consecutive failure stamps `settlement_blocked_at`. A replay on an
 * allocation under dispute is not counted: the dispute, not the claim, holds
 * the money. Never throws (a count is an observation, never a gate).
 */
export function noteClaimReplay(db: DatabaseDriver, taskId: string, settled: boolean): void {
  try {
    if (settled) {
      db.prepare(
        `UPDATE relay_allocations SET settlement_replay_failures = 0, settlement_blocked_at = NULL
          WHERE task_id = ? AND (settlement_replay_failures <> 0 OR settlement_blocked_at IS NOT NULL)`,
      ).run(taskId);
      return;
    }
    db.prepare(
      `UPDATE relay_allocations
          SET settlement_replay_failures = settlement_replay_failures + 1,
              settlement_blocked_at = CASE
                WHEN settlement_blocked_at IS NULL AND settlement_replay_failures + 1 >= ? THEN ?
                ELSE settlement_blocked_at END
        WHERE task_id = ? AND status <> 'disputed'`,
    ).run(SETTLEMENT_BLOCKED_AFTER_FAILURES, Date.now(), taskId);
  } catch (err) {
    logger.warn("settlement.claim_replay_count_failed", {
      correlationId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Admin health: the claims recovery could not settle, and the ones recorded unrecoverable. */
export function settlementClaimHealth(db: DatabaseDriver): {
  blocked: number;
  unrecoverable: number;
  allocations: Array<{
    allocation_id: string;
    task_id: string;
    status: string;
    settlement_blocked_at: number | null;
    settlement_replay_failures: number;
    claim_unrecoverable_at: number | null;
  }>;
} | null {
  try {
    const counts = db
      .prepare(
        `SELECT COALESCE(SUM(settlement_blocked_at IS NOT NULL), 0) AS blocked,
                COALESCE(SUM(claim_unrecoverable_at IS NOT NULL), 0) AS unrecoverable
           FROM relay_allocations`,
      )
      .get() as { blocked: number; unrecoverable: number };
    const allocations = db
      .prepare(
        `SELECT allocation_id, task_id, status, settlement_blocked_at, settlement_replay_failures,
                claim_unrecoverable_at
           FROM relay_allocations
          WHERE settlement_blocked_at IS NOT NULL OR claim_unrecoverable_at IS NOT NULL
          ORDER BY COALESCE(settlement_blocked_at, claim_unrecoverable_at) DESC
          LIMIT 50`,
      )
      .all() as Array<{
      allocation_id: string;
      task_id: string;
      status: string;
      settlement_blocked_at: number | null;
      settlement_replay_failures: number;
      claim_unrecoverable_at: number | null;
    }>;
    return { blocked: counts.blocked, unrecoverable: counts.unrecoverable, allocations };
  } catch (err) {
    logger.warn("settlement.claim_health_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ClaimResolveRouteDeps {
  app: Hono;
  db: DatabaseDriver;
  /**
   * Replay the task's claimed receipt through recovery's own door
   * (`replayClaim` in settlement-recovery.ts, over the relay's recovery deps).
   */
  replayClaim(taskId: string): Promise<"not_claimed" | "settled" | "unsettled">;
}

type ResolveAction = "re-attempt" | "record-unrecoverable";

/**
 * The operator door, PR-1 actions only: `POST /api/v1/admin/allocations/:id/
 * resolve-blocked`. Master token only (middleware.ts `bearerAuth`, recorded in
 * `relay_auth_events` by the /api/v1 catch-all). Both actions act on the
 * allocation's claimed-but-unsettled settlement and are refused while the
 * allocation is `disputed` (the dispute governs it then):
 *
 *   - `re-attempt`: replay the claimed receipt through recovery's own door —
 *     never another payee, never a refund.
 *   - `record-unrecoverable` (`evidence` required): write
 *     `claim_unrecoverable_at`. Moves NO money: the escrow stays held.
 */
export function registerClaimResolveRoutes(deps: ClaimResolveRouteDeps): void {
  const { app, db } = deps;

  /** @internal */
  app.post("/api/v1/admin/allocations/:allocationId/resolve-blocked", async (c) => {
    const allocationId = c.req.param("allocationId");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON", code: "INVALID_BODY" }, 400);
    }
    const body: { action?: unknown; evidence?: unknown } =
      raw !== null && typeof raw === "object" ? raw : {};
    const action = body.action;
    if (action !== "re-attempt" && action !== "record-unrecoverable") {
      return c.json(
        { error: "action must be re-attempt or record-unrecoverable", code: "INVALID_ACTION" },
        400,
      );
    }
    const evidence = typeof body.evidence === "string" ? body.evidence.trim() : "";
    if (action === "record-unrecoverable" && evidence === "") {
      return c.json(
        { error: "record-unrecoverable needs an evidence string", code: "EVIDENCE_REQUIRED" },
        400,
      );
    }
    if (evidence.length > CLAIM_EVIDENCE_MAX_CHARS) {
      return c.json(
        {
          error: `evidence is at most ${CLAIM_EVIDENCE_MAX_CHARS} characters`,
          code: "INVALID_BODY",
        },
        400,
      );
    }

    const alloc = db
      .prepare(
        "SELECT allocation_id, task_id, status, claim_unrecoverable_at FROM relay_allocations WHERE allocation_id = ?",
      )
      .get(allocationId) as
      | {
          allocation_id: string;
          task_id: string;
          status: string;
          claim_unrecoverable_at: number | null;
        }
      | undefined;
    if (alloc == null) return c.json({ error: "no such allocation", code: "NOT_FOUND" }, 404);
    if (alloc.status === "disputed") {
      return c.json(
        {
          error:
            "the allocation is under dispute: its verdict governs it, not the settlement claim",
          code: "ALLOCATION_DISPUTED",
        },
        409,
      );
    }
    if (!holdsUnsettledClaim(db, alloc.task_id)) {
      return c.json(
        {
          error: "the allocation's task holds no claimed, unsettled answer",
          code: "NO_UNSETTLED_CLAIM",
        },
        409,
      );
    }
    const act: ResolveAction = action;

    if (act === "re-attempt") {
      const outcome = await deps.replayClaim(alloc.task_id);
      if (outcome === "not_claimed") {
        return c.json(
          {
            error: "the claim is not in the queue, so recovery's door cannot replay it",
            code: "CLAIM_NOT_REPLAYABLE",
          },
          409,
        );
      }
      logger.info("allocation.claim_reattempted", {
        allocationId,
        taskId: alloc.task_id,
        outcome,
      });
      return c.json({
        allocation_id: allocationId,
        task_id: alloc.task_id,
        action: act,
        settled: outcome === "settled",
      });
    }

    // record-unrecoverable: a marker, never a money move.
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE relay_allocations SET claim_unrecoverable_at = ?, claim_unrecoverable_evidence = ?
          WHERE allocation_id = ? AND claim_unrecoverable_at IS NULL AND status <> 'disputed'`,
      )
      .run(now, evidence, allocationId).changes;
    const row = db
      .prepare(
        "SELECT claim_unrecoverable_at, claim_unrecoverable_evidence FROM relay_allocations WHERE allocation_id = ?",
      )
      .get(allocationId) as {
      claim_unrecoverable_at: number | null;
      claim_unrecoverable_evidence: string | null;
    };
    logger.warn("allocation.claim_recorded_unrecoverable", {
      allocationId,
      taskId: alloc.task_id,
      alreadyRecorded: changed === 0,
    });
    return c.json({
      allocation_id: allocationId,
      task_id: alloc.task_id,
      action: act,
      already_recorded: changed === 0,
      claim_unrecoverable_at: row.claim_unrecoverable_at,
      evidence: row.claim_unrecoverable_evidence,
    });
  });
}
