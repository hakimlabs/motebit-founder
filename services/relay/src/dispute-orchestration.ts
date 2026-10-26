/**
 * §6.2 federation orchestrator — deferred retry-within-72h driver.
 *
 * Wraps the one-shot `orchestrateFederationResolution` (in `disputes.ts`)
 * with persistence + retry policy so a single peer hiccup at fan-out
 * time no longer becomes a permanently-lost vote. The §6.6 72h
 * adjudication window is now the orchestrator's actual attempt window;
 * the per-request 10s timeout governs ONE attempt, not the deadline.
 *
 * State machine per (dispute_id, round) in `relay_dispute_orchestrations`:
 *
 *   absent → in_progress → done       (quorum reached; resolution persisted)
 *                        → timed_out  (72h deadline; §6.6 fallback applies)
 *
 * Per-attempt retry policy: exponential backoff capped at 30 minutes —
 * `min(10s * 2^attempt, 30min)`. Caps the worst-case poll rate while
 * keeping the early-attempt cadence tight enough to catch transient
 * peer flakiness within the first few minutes.
 *
 * The driver is restart-resumable by construction: the table is the
 * single source of truth, the worker (`runDeferredOrchestrationCycle`)
 * picks up `in_progress` rows on every poll regardless of process
 * identity. Cross-process concurrency is bounded by:
 *   - the round-1 commit is guarded `WHERE state IN ('evidence',
 *     'arbitration')`, and `relay_dispute_resolutions UNIQUE(dispute_id,
 *     round)` backs it: a duplicate finalize race has one winner, and the
 *     loser rolls back and reports the standing record.
 *   - `relay_dispute_votes UNIQUE(dispute_id, round, peer_id) ON CONFLICT
 *     DO UPDATE` makes parallel fan-outs to the same peer idempotent.
 *
 * See `memory/section_6_2_orchestrator_async_deferral` for the
 * deferred-trade-off the v1 sync orchestrator left open; this module
 * closes it.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { AdjudicatorVote, DisputeFundAction, DisputeOutcome } from "@motebit/protocol";
import { signDisputeResolution } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "dispute-orchestration" });

/** §6.6 adjudication window — the orchestrator's deferred attempt deadline. */
export const ORCHESTRATION_DEADLINE_MS = 72 * 60 * 60 * 1000;

/** Backoff cap — no single inter-attempt gap exceeds this. */
const ORCHESTRATION_BACKOFF_CAP_MS = 30 * 60 * 1000;

/** Worker poll cadence — how often `runDeferredOrchestrationCycle` fires. */
export const ORCHESTRATION_WORKER_INTERVAL_MS = 60_000;

/**
 * Compute the next-attempt timestamp from attempt count.
 * `min(10s * 2^attempt, 30min)`. Attempt 0 → 10s; 1 → 20s; ... 8 → 30min.
 */
export function computeNextAttemptAt(attemptCount: number, now: number): number {
  const baseDelayMs = 10_000 * Math.pow(2, Math.max(0, attemptCount));
  const delayMs = Math.min(baseDelayMs, ORCHESTRATION_BACKOFF_CAP_MS);
  return now + delayMs;
}

export interface OrchestrationRow {
  dispute_id: string;
  round: number;
  status: "in_progress" | "done" | "timed_out";
  started_at: number;
  last_attempt_at: number;
  next_attempt_at: number | null;
  attempt_count: number;
  deadline_at: number;
}

/**
 * Read orchestration state for a (dispute, round). Returns null if no
 * attempt has been made yet.
 */
export function getOrchestrationState(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
): OrchestrationRow | null {
  const row = db
    .prepare(
      `SELECT dispute_id, round, status, started_at, last_attempt_at, next_attempt_at,
              attempt_count, deadline_at
       FROM relay_dispute_orchestrations WHERE dispute_id = ? AND round = ?`,
    )
    .get(disputeId, round) as OrchestrationRow | undefined;
  return row ?? null;
}

/**
 * Insert an in_progress orchestration row at the start of the first
 * attempt. Idempotent: re-running on existing row is a no-op (the row
 * already carries the started_at + deadline).
 */
export function initOrchestration(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
  now: number,
): OrchestrationRow {
  const existing = getOrchestrationState(db, disputeId, round);
  if (existing) return existing;
  const deadlineAt = now + ORCHESTRATION_DEADLINE_MS;
  db.prepare(
    `INSERT INTO relay_dispute_orchestrations
       (dispute_id, round, status, started_at, last_attempt_at, next_attempt_at, attempt_count, deadline_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, 0, ?)`,
  ).run(disputeId, round, now, now, computeNextAttemptAt(0, now), deadlineAt);
  return getOrchestrationState(db, disputeId, round)!;
}

/**
 * Update an orchestration row after one attempt: bump attempt_count,
 * update last_attempt_at, set next_attempt_at per backoff. Status
 * stays `in_progress` — finalization (done / timed_out) is a separate
 * call site at the attempt-or-finalize boundary.
 */
export function recordOrchestrationAttempt(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
  now: number,
): OrchestrationRow {
  const current = getOrchestrationState(db, disputeId, round);
  if (!current)
    throw new Error(`Cannot record attempt on missing orchestration row ${disputeId}:${round}`);
  const newAttemptCount = current.attempt_count + 1;
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?
       WHERE dispute_id = ? AND round = ?`,
  ).run(newAttemptCount, now, computeNextAttemptAt(newAttemptCount, now), disputeId, round);
  return getOrchestrationState(db, disputeId, round)!;
}

/** Mark orchestration done (quorum reached). next_attempt_at cleared. */
export function markOrchestrationDone(db: DatabaseDriver, disputeId: string, round: number): void {
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET status = 'done', next_attempt_at = NULL
       WHERE dispute_id = ? AND round = ?`,
  ).run(disputeId, round);
}

/** Mark orchestration timed_out (72h deadline elapsed). next_attempt_at cleared. */
export function markOrchestrationTimedOut(
  db: DatabaseDriver,
  disputeId: string,
  round: number,
): void {
  db.prepare(
    `UPDATE relay_dispute_orchestrations
       SET status = 'timed_out', next_attempt_at = NULL
       WHERE dispute_id = ? AND round = ?`,
  ).run(disputeId, round);
}

/**
 * Enumerate orchestrations whose next_attempt_at <= now and status is
 * `in_progress`. Used by the background worker to drive retries.
 */
export function getDueOrchestrations(
  db: DatabaseDriver,
  now: number,
  limit = 50,
): Array<{ dispute_id: string; round: number }> {
  return db
    .prepare(
      `SELECT dispute_id, round
       FROM relay_dispute_orchestrations
       WHERE status = 'in_progress' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
    )
    .all(now, limit) as Array<{ dispute_id: string; round: number }>;
}

/**
 * Sign + persist a ROUND-1 DisputeResolution row and transition the dispute
 * `evidence | arbitration → resolved`, atomically. Used by both the
 * synchronous /resolve paths (single-relay, and federation quorum on the
 * first attempt) and the deferred worker's quorum-on-a-later-attempt path.
 *
 * Round 1 only. Round 2 commits through `commitRound2Verdict` (disputes.ts),
 * guarded on `appealed`, with its fund action in the same transaction. This
 * function's former round-2 branch moved a dispute to `final` without running
 * the fund action.
 *
 * Guarded on state (docs/proposals/dispute-money-path-v1.md M6, "Who may
 * write dispute state"): the transition is `WHERE state IN ('evidence',
 * 'arbitration')`, so a dispute that is already `resolved`, `appealed`,
 * `final` or `expired` is never moved back. The resolution row is written
 * only when that transition happened, in the same transaction.
 *
 * Cross-process safety: the state guard and `relay_dispute_resolutions
 * UNIQUE (dispute_id, round)` both catch a concurrent finalize. One writer
 * wins; the other rolls back and writes nothing. Returns `{ persisted: true }`
 * when this call committed, else `{ persisted: false, standing }`: the record
 * that stands (the dispute's state now, and its round-1 resolution if any).
 * A caller never reports its own verdict when `persisted` is false.
 */
export interface FinalizeArgs {
  disputeId: string;
  /** Round 1 only: round 2 commits through `commitRound2Verdict`. */
  round: 1;
  resolution: DisputeOutcome;
  rationale: string;
  fund_action: DisputeFundAction;
  split_ratio: number;
  adjudicator_votes: AdjudicatorVote[];
  resolvedAt: number;
}

export interface FinalizeDeps {
  db: DatabaseDriver;
  relayIdentity: RelayIdentity;
}

/** A round-1 resolution as it stands in `relay_dispute_resolutions`. */
export interface StandingResolution {
  round: number;
  resolution: DisputeOutcome;
  rationale: string;
  fund_action: DisputeFundAction;
  split_ratio: number;
  adjudicator_votes: AdjudicatorVote[];
  resolved_at: number;
}

/** What stands for a dispute when a verdict did not commit. */
export interface StandingRecord {
  /** The dispute's state now; null if the row is gone. */
  state: string | null;
  /** Its round-1 resolution, if one was committed. */
  resolution: StandingResolution | null;
}

export type FinalizeResult =
  | { persisted: true; signature: string }
  | { persisted: false; signature: string; standing: StandingRecord };

/** Read the standing record (state + round-1 resolution) for a dispute. */
export function readStandingRecord(db: DatabaseDriver, disputeId: string): StandingRecord {
  const dispute = db
    .prepare("SELECT state FROM relay_disputes WHERE dispute_id = ?")
    .get(disputeId) as { state: string } | undefined;
  const row = db
    .prepare(
      `SELECT round, resolution, rationale, fund_action, split_ratio, adjudicator_votes, resolved_at
       FROM relay_dispute_resolutions WHERE dispute_id = ? AND round = 1`,
    )
    .get(disputeId) as
    | (Omit<StandingResolution, "adjudicator_votes"> & { adjudicator_votes: string | null })
    | undefined;
  return {
    state: dispute?.state ?? null,
    resolution: row
      ? {
          ...row,
          adjudicator_votes: row.adjudicator_votes
            ? (JSON.parse(row.adjudicator_votes) as AdjudicatorVote[])
            : [],
        }
      : null,
  };
}

export async function finalizeFederationResolution(
  args: FinalizeArgs,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  const { db, relayIdentity } = deps;
  if (args.round !== 1) {
    // Unreachable through the type; a cast or a JS caller lands here. Round 2
    // has exactly one writer, `commitRound2Verdict`.
    throw new Error(
      `finalizeFederationResolution commits round 1 only (got round ${String(args.round)}); round 2 commits through commitRound2Verdict`,
    );
  }
  const signed = await signDisputeResolution(
    {
      dispute_id: args.disputeId,
      resolution: args.resolution,
      rationale: args.rationale,
      fund_action: args.fund_action,
      split_ratio: args.split_ratio,
      adjudicator: relayIdentity.relayMotebitId,
      adjudicator_votes: args.adjudicator_votes,
      resolved_at: args.resolvedAt,
    },
    relayIdentity.privateKey,
  );
  const resolutionId = `res-${args.resolvedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const notPersisted = (reason: string): FinalizeResult => {
    const standing = readStandingRecord(db, args.disputeId);
    logger.info("dispute.finalize.not_committed", {
      disputeId: args.disputeId,
      reason,
      state: standing.state,
      standingResolution: standing.resolution?.resolution ?? null,
    });
    return { persisted: false, signature: signed.signature, standing };
  };

  // One transaction: the guarded state move, then the resolution row. The
  // UPDATE re-reads the state itself, after the signing await; whatever the
  // caller read before that await may be stale.
  db.exec("BEGIN");
  try {
    const moved = db
      .prepare(
        `UPDATE relay_disputes
           SET state = 'resolved', resolution = ?, rationale = ?, fund_action = ?,
               split_ratio = ?, adjudicator = ?, resolved_at = ?
           WHERE dispute_id = ? AND state IN ('evidence', 'arbitration')`,
      )
      .run(
        args.resolution,
        args.rationale,
        args.fund_action,
        args.split_ratio,
        relayIdentity.relayMotebitId,
        args.resolvedAt,
        args.disputeId,
      );
    if (moved.changes === 0) {
      db.exec("ROLLBACK");
      return notPersisted("state_not_adjudicable");
    }
    try {
      db.prepare(
        `INSERT INTO relay_dispute_resolutions
           (resolution_id, dispute_id, round, resolution, rationale, fund_action,
            split_ratio, adjudicator, adjudicator_votes, resolved_at, signature, is_appeal)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        resolutionId,
        args.disputeId,
        args.resolution,
        args.rationale,
        args.fund_action,
        args.split_ratio,
        relayIdentity.relayMotebitId,
        JSON.stringify(args.adjudicator_votes),
        args.resolvedAt,
        signed.signature,
      );
    } catch (err) {
      // UNIQUE(dispute_id, round): a round-1 row already exists for a dispute
      // still in evidence/arbitration (one an earlier relay left). The
      // standing row wins; this verdict is not committed.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        db.exec("ROLLBACK");
        return notPersisted("round_1_row_exists");
      }
      throw err;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { persisted: true, signature: signed.signature };
}
