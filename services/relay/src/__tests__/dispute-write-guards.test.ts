/**
 * Who may write dispute state (docs/proposals/dispute-money-path-v1.md M6,
 * implementation order PR 2). Every verdict writer is guarded on state:
 *
 * 1. Round 1 commits through `finalizeFederationResolution`, guarded
 *    `WHERE state IN ('evidence','arbitration')`. On main its UPDATE had no
 *    state guard: a `final` (or `resolved`, `appealed`, `opened`, `expired`)
 *    dispute with no round-1 row was flipped back to `resolved`, and a lost
 *    race reported nothing about the verdict that stood.
 * 2. Round 2 commits only through `commitRound2Verdict` (`WHERE state =
 *    'appealed'`, with its fund action in the same transaction). On main
 *    `finalizeFederationResolution` also had a round-2 branch that moved the
 *    dispute to `final` WITHOUT running the fund action, and the deferred
 *    worker's round-2 path called it.
 * 3. `/resolve` answers 409 with the standing record when its verdict did not
 *    commit — on main it answered 200 with a verdict it never persisted, on
 *    the single-relay path and the synchronous federation path alike.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A one-shot hook run inside `signDisputeResolution`, i.e. in the await
 * between `/resolve`'s state read and its commit — where another process's
 * commit can land. Cleared before it runs, so the competing commit signs
 * normally.
 */
const signHook: { once: (() => Promise<void>) | null } = { once: null };

vi.mock("@motebit/encryption", async (orig) => {
  const actual = await orig<typeof import("@motebit/encryption")>();
  return {
    ...actual,
    signDisputeResolution: async (
      ...args: Parameters<typeof actual.signDisputeResolution>
    ): ReturnType<typeof actual.signDisputeResolution> => {
      const hook = signHook.once;
      if (hook) {
        signHook.once = null;
        await hook();
      }
      return actual.signDisputeResolution(...args);
    },
  };
});

import { generateKeypair, bytesToHex, signDisputeRequest } from "@motebit/encryption";
import { signAdjudicatorVote } from "@motebit/crypto";
import type { DisputeOutcome, VoteRequest } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import type { RelayIdentity } from "../federation.js";
import { finalizeFederationResolution, type FinalizeArgs } from "../dispute-orchestration.js";
import { runDeferredOrchestrationCycle } from "../disputes.js";
import { AUTH_HEADER, JSON_AUTH, closeEvidenceWindow, createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;
afterEach(async () => {
  signHook.once = null;
  vi.unstubAllGlobals();
  await relay?.close();
});

const db = () => relay.moteDb.db;

/** A dispute row inserted directly in `state`, with no resolution row. */
function insertDispute(state: string, opts: { relayIsParty?: boolean } = {}): string {
  const id = `dsp-guard-${crypto.randomUUID()}`;
  const now = Date.now();
  const respondent = opts.relayIsParty ? relay.relayIdentity.relayMotebitId : "wrk-guard";
  db()
    .prepare(
      `INSERT INTO relay_disputes
         (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
          amount_locked, filing_fee, filed_at, evidence_deadline, filer_role)
       VALUES (?, ?, ?, 'del-guard', ?, 'quality', 'guard test', ?, 0, 0, ?, ?, 'delegator')`,
    )
    .run(id, `task-${id}`, `alloc-${id}`, respondent, state, now - 1000, now - 1);
  return id;
}

function round1Args(disputeId: string, resolution: DisputeOutcome = "upheld"): FinalizeArgs {
  return {
    disputeId,
    round: 1,
    resolution,
    rationale: `verdict ${resolution}`,
    fund_action: resolution === "upheld" ? "refund_to_delegator" : "release_to_worker",
    split_ratio: resolution === "upheld" ? 0 : 1,
    adjudicator_votes: [],
    resolvedAt: Date.now(),
  };
}

const disputeRow = (id: string) =>
  db()
    .prepare(
      "SELECT state, resolution, fund_action, resolved_at, final_at FROM relay_disputes WHERE dispute_id = ?",
    )
    .get(id) as {
    state: string;
    resolution: string | null;
    fund_action: string | null;
    resolved_at: number | null;
    final_at: number | null;
  };

const resolutionRows = (id: string) =>
  db()
    .prepare(
      "SELECT round, resolution FROM relay_dispute_resolutions WHERE dispute_id = ? ORDER BY round",
    )
    .all(id) as Array<{ round: number; resolution: string }>;

/**
 * The relay's identity as another process of the same relay holds it. The
 * test relay does not expose its private key, so the signing key here is a
 * fresh one under the relay's id; no assertion reads the signature.
 */
let signer: RelayIdentity | null = null;
async function relaySigner(): Promise<RelayIdentity> {
  if (signer?.relayMotebitId !== relay.relayIdentity.relayMotebitId) {
    const kp = await generateKeypair();
    signer = {
      relayMotebitId: relay.relayIdentity.relayMotebitId,
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: relay.relayIdentity.did,
    };
  }
  return signer;
}
const deps = async () => ({ db: db(), relayIdentity: await relaySigner() });

describe("finalizeFederationResolution: round 1 commits only from evidence or arbitration", () => {
  for (const state of ["opened", "resolved", "appealed", "final", "expired"]) {
    it(`a ${state} dispute with no round-1 row stays ${state}: nothing is written and the standing record is reported`, async () => {
      relay = await createTestRelay();
      const id = insertDispute(state);
      const before = disputeRow(id);
      const out = await finalizeFederationResolution(round1Args(id), await deps());
      expect(out.persisted).toBe(false);
      expect(disputeRow(id)).toEqual(before);
      expect(resolutionRows(id)).toEqual([]);
      expect(out).toMatchObject({ standing: { state, resolution: null } });
    });
  }

  for (const state of ["evidence", "arbitration"]) {
    it(`a ${state} dispute commits round 1: one signed row, state resolved`, async () => {
      relay = await createTestRelay();
      const id = insertDispute(state);
      const out = await finalizeFederationResolution(round1Args(id), await deps());
      expect(out.persisted).toBe(true);
      expect(disputeRow(id)).toMatchObject({ state: "resolved", resolution: "upheld" });
      expect(resolutionRows(id)).toEqual([{ round: 1, resolution: "upheld" }]);
    });
  }

  it("two round-1 commits racing write one resolution, and the loser reports the standing record", async () => {
    relay = await createTestRelay();
    const id = insertDispute("arbitration");
    const d = await deps();
    const [a, b] = await Promise.all([
      finalizeFederationResolution(round1Args(id, "upheld"), d),
      finalizeFederationResolution(round1Args(id, "overturned"), d),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.persisted)).toHaveLength(1);
    const rows = resolutionRows(id);
    expect(rows).toHaveLength(1);
    const winner = rows[0]!.resolution;
    expect(disputeRow(id)).toMatchObject({ state: "resolved", resolution: winner });
    const loser = outcomes.find((o) => !o.persisted)!;
    expect(loser).toMatchObject({
      standing: { state: "resolved", resolution: { round: 1, resolution: winner } },
    });
  });

  it("round 2 can no longer be written through it: an appealed dispute keeps its state and gains no round-2 row", async () => {
    relay = await createTestRelay();
    const id = insertDispute("evidence");
    expect((await finalizeFederationResolution(round1Args(id), await deps())).persisted).toBe(true);
    db()
      .prepare("UPDATE relay_disputes SET state = 'appealed', appealed_at = ? WHERE dispute_id = ?")
      .run(Date.now(), id);
    const round2 = { ...round1Args(id, "overturned"), round: 2 } as unknown as FinalizeArgs;
    await expect(finalizeFederationResolution(round2, await deps())).rejects.toThrow(
      /round 1 only/,
    );
    expect(resolutionRows(id)).toEqual([{ round: 1, resolution: "upheld" }]);
    expect(disputeRow(id)).toMatchObject({ state: "appealed", final_at: null });
  });
});

// ── The federation world: the relay is the respondent, three active peers ──

interface Peer {
  id: string;
  privateKey: Uint8Array;
  url: string;
}

async function federationWorld(): Promise<{
  peers: Peer[];
  disputeId: string;
  allocId: string;
}> {
  relay = await createTestRelay({ enableDeviceAuth: false });
  const delKp = await generateKeypair();
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: "del-wg",
      public_key: bytesToHex(delKp.publicKey),
      endpoint_url: "https://del-wg.test",
      capabilities: ["test"],
    }),
  });
  const peers: Peer[] = [];
  for (let i = 0; i < 3; i++) {
    const kp = await generateKeypair();
    const peer = {
      id: `relay-wg${i}-${crypto.randomUUID().slice(0, 8)}`,
      privateKey: kp.privateKey,
      url: `http://wg-peer${i}.test`,
    };
    db()
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
         VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
      )
      .run(peer.id, bytesToHex(kp.publicKey), peer.url, `wg${i}`, Date.now(), Date.now());
    peers.push(peer);
  }
  const relayId = relay.relayIdentity.relayMotebitId;
  const allocId = `alloc-wg-${crypto.randomUUID().slice(0, 8)}`;
  const taskId = `task-${allocId}`;
  db()
    .prepare(
      "INSERT INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, 'del-wg', 100000, 'settled', ?)",
    )
    .run(allocId, taskId, Date.now());
  // §4.4 standing: the relay funded this allocation (it is the delegator).
  db()
    .prepare(
      "INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at) VALUES (?, ?, 'allocation_hold', -100000, 0, ?, 'test hold', ?)",
    )
    .run(crypto.randomUUID(), relayId, allocId, Date.now());
  const disputeId = `dsp-wg-${crypto.randomUUID().slice(0, 8)}`;
  const req = await signDisputeRequest(
    {
      dispute_id: disputeId,
      task_id: taskId,
      allocation_id: allocId,
      filed_by: "del-wg",
      respondent: relayId,
      category: "quality",
      description: "write-guard federation dispute",
      evidence_refs: ["receipt-x"],
      filed_at: Date.now(),
    },
    delKp.privateKey,
  );
  const filed = await relay.app.request(`/api/v1/allocations/${allocId}/dispute`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(req),
  });
  expect(filed.status, await filed.clone().text()).toBe(200);
  closeEvidenceWindow(relay, disputeId);
  return { peers, disputeId, allocId };
}

/** Peers sign `vote` for every round; `onFirst` runs once, before the first answer. */
function peerFetch(
  peers: Peer[],
  vote: DisputeOutcome,
  onFirst?: () => Promise<void>,
): typeof fetch {
  let first = onFirst;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (first) {
      const f = first;
      first = undefined;
      await f();
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const peer = peers.find((p) => url.startsWith(p.url));
    if (!peer) throw new Error(`unrouted url: ${url}`);
    const body = JSON.parse(init!.body as string) as VoteRequest;
    const signed = await signAdjudicatorVote(
      {
        dispute_id: body.dispute_id,
        round: body.round,
        peer_id: peer.id,
        vote,
        rationale: `peer ${peer.id} votes ${vote}`,
      },
      peer.privateKey,
    );
    return new Response(JSON.stringify(signed), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function resolveReq(disputeId: string, resolution: DisputeOutcome = "upheld") {
  return relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ resolution, rationale: `operator says ${resolution}` }),
  });
}

interface NotCommittedBody {
  code: string;
  state: string;
  resolution: { round: number; resolution: string } | null;
}

describe("/resolve answers 409 with the standing record when its verdict did not commit", () => {
  it("single-relay: a round-1 commit that lost the race to another process's commit is 409, not 200", async () => {
    relay = await createTestRelay();
    const id = insertDispute("evidence");
    // Another process commits "overturned" while this /resolve is signing "upheld".
    signHook.once = async () => {
      const other = await finalizeFederationResolution(round1Args(id, "overturned"), await deps());
      expect(other.persisted).toBe(true);
    };
    const res = await resolveReq(id, "upheld");
    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as NotCommittedBody;
    expect(body.code).toBe("DISPUTE_RESOLUTION_NOT_COMMITTED");
    expect(body.state).toBe("resolved");
    expect(body.resolution).toMatchObject({ round: 1, resolution: "overturned" });
    expect(resolutionRows(id)).toEqual([{ round: 1, resolution: "overturned" }]);
    expect(disputeRow(id)).toMatchObject({ state: "resolved", resolution: "overturned" });
  });

  it("single-relay: a dispute that left evidence/arbitration during the resolve is 409 and keeps its state", async () => {
    relay = await createTestRelay();
    const id = insertDispute("evidence");
    signHook.once = async () => {
      db()
        .prepare("UPDATE relay_disputes SET state = 'expired', expired_at = ? WHERE dispute_id = ?")
        .run(Date.now(), id);
    };
    const res = await resolveReq(id, "upheld");
    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as NotCommittedBody;
    expect(body).toMatchObject({
      code: "DISPUTE_RESOLUTION_NOT_COMMITTED",
      state: "expired",
      resolution: null,
    });
    expect(resolutionRows(id)).toEqual([]);
    expect(disputeRow(id).state).toBe("expired");
  });

  it("synchronous federation: a round-1 commit that lost the race to the worker's commit during the fan-out is 409, not 200", async () => {
    const w = await federationWorld();
    // During the fan-out, another process's worker commits "overturned".
    vi.stubGlobal(
      "fetch",
      peerFetch(w.peers, "upheld", async () => {
        const other = await finalizeFederationResolution(
          round1Args(w.disputeId, "overturned"),
          await deps(),
        );
        expect(other.persisted).toBe(true);
      }),
    );
    const res = await resolveReq(w.disputeId);
    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as NotCommittedBody;
    expect(body.code).toBe("DISPUTE_RESOLUTION_NOT_COMMITTED");
    expect(body.state).toBe("resolved");
    expect(body.resolution).toMatchObject({ round: 1, resolution: "overturned" });
    expect(resolutionRows(w.disputeId)).toEqual([{ round: 1, resolution: "overturned" }]);
  });

  it("happy paths unchanged: single-relay and federation resolves with no race answer 200 and commit", async () => {
    relay = await createTestRelay();
    const id = insertDispute("evidence");
    const res = await resolveReq(id, "upheld");
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()) as { state: string }).toMatchObject({ state: "resolved" });
    expect(resolutionRows(id)).toEqual([{ round: 1, resolution: "upheld" }]);
    await relay.close();

    const w = await federationWorld();
    vi.stubGlobal("fetch", peerFetch(w.peers, "upheld"));
    const fed = await resolveReq(w.disputeId);
    expect(fed.status, await fed.clone().text()).toBe(200);
    expect((await fed.json()) as { resolution: string }).toMatchObject({ resolution: "upheld" });
    expect(resolutionRows(w.disputeId)).toEqual([{ round: 1, resolution: "upheld" }]);
  });
});

describe("the deferred worker's round 2 commits through commitRound2Verdict", () => {
  /** Resolve round 1, then park the dispute `appealed` with a due round-2 orchestration row. */
  async function appealedWithRound2Row(): Promise<
    Awaited<ReturnType<typeof federationWorld>> & { now: number }
  > {
    const w = await federationWorld();
    vi.stubGlobal("fetch", peerFetch(w.peers, "upheld"));
    expect((await resolveReq(w.disputeId)).status).toBe(200);
    // Parked `appealed` with no round-2 resolution, as when `/appeal` defers
    // below quorum (it opens the round-2 orchestration row): the worker is
    // then the round-2 retry.
    db()
      .prepare(
        "UPDATE relay_disputes SET state = 'appealed', appealed_at = ? WHERE dispute_id = ? AND state = 'resolved'",
      )
      .run(Date.now(), w.disputeId);
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO relay_dispute_orchestrations
           (dispute_id, round, status, started_at, last_attempt_at, next_attempt_at, attempt_count, deadline_at)
         VALUES (?, 2, 'in_progress', ?, ?, ?, 1, ?)`,
      )
      .run(w.disputeId, now, now, now - 1, now + 72 * 3600_000);
    return { ...w, now };
  }

  it("a due round-2 row finalizes the appeal AND executes its fund action in the same commit", async () => {
    const w = await appealedWithRound2Row();
    const out = await runDeferredOrchestrationCycle({
      db: db(),
      relayIdentity: await relaySigner(),
      fetchImpl: peerFetch(w.peers, "overturned"),
      nowMs: () => w.now,
    });
    expect(out).toMatchObject({ processed: 1, ready: 1 });
    expect(resolutionRows(w.disputeId)).toEqual([
      { round: 1, resolution: "upheld" },
      { round: 2, resolution: "overturned" },
    ]);
    expect(disputeRow(w.disputeId)).toMatchObject({ state: "final", resolution: "overturned" });
    // del-wg owns the allocation (worker-filer); overturned on appeal ⇒
    // refund_to_delegator: the relay (respondent = delegator) gets the escrow.
    const refund = db()
      .prepare(
        "SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit' AND reference_id = ?",
      )
      .get(relay.relayIdentity.relayMotebitId, w.disputeId) as { amount: number } | undefined;
    expect(refund?.amount).toBe(100000);
  });

  it("a round-2 row for a dispute no longer appealed writes nothing", async () => {
    const w = await appealedWithRound2Row();
    db()
      .prepare("UPDATE relay_disputes SET state = 'final', final_at = ? WHERE dispute_id = ?")
      .run(w.now - 5, w.disputeId);
    await runDeferredOrchestrationCycle({
      db: db(),
      relayIdentity: await relaySigner(),
      fetchImpl: peerFetch(w.peers, "overturned"),
      nowMs: () => w.now,
    });
    expect(resolutionRows(w.disputeId)).toEqual([{ round: 1, resolution: "upheld" }]);
    expect(disputeRow(w.disputeId)).toMatchObject({
      state: "final",
      resolution: "upheld",
      final_at: w.now - 5,
    });
  });
});
