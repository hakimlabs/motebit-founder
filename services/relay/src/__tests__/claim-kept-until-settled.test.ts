/**
 * A claim is kept until it settles (#1152 M3; design
 * `docs/proposals/dispute-money-path-v1.md` §M3 + PR-1 acceptance criteria).
 *
 * A claimed-but-unsettled answer (`settling` set, `settled` not) holds a valid
 * signed receipt the relay has not yet paid. On main it could lose its escrow
 * to a refund, with no dispute involved:
 *
 *   (a) RACE — once `answerTask` wrote the receipt, the stale sweep's "granted
 *       and unanswered" protection ended; the settlement step awaits before
 *       its transaction, so a task-cleanup tick landing there refunded the
 *       delegator first. The worker was never paid.
 *   (b) HORIZON — the claim's three replay stores (queue entry, archived
 *       answer, route) were deleted ~7 days after the answer; recovery could
 *       then never settle it and the sweep refunded.
 *
 * Every case drives a relay-custody x402-paid task (`seedX402PaidTask`) and the
 * REAL receipt door, sweep, recovery and admin route. Each guard is removed by
 * `services/relay/tamper/claim-kept-until-settled.mjs` and the test named for
 * it goes red.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { refundExhaustedForward } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation and receipt signing
import { generateKeypair, bytesToHex, signExecutionReceipt } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";
import {
  AUTH_HEADER,
  JSON_AUTH,
  createAgent,
  createTestRelay,
  seedX402PaidTask,
} from "./test-helpers.js";
import { TaskQueue } from "../task-queue.js";
import { cleanupTaskRoutes } from "../task-routing.js";
import { getAccountBalance } from "../accounts.js";
import { SETTLEMENT_BLOCKED_AFTER_FAILURES, noteClaimReplay } from "../claim-settlement.js";
import { allocationHeld } from "../allocation-escrow.js";
import { forwardOriginSettlement } from "../federation-callbacks.js";
import { processSettlementRetries } from "../federation.js";
import type { RelayIdentity } from "../federation.js";
import { markTaskSettled } from "../task-answer.js";
// eslint-disable-next-line no-restricted-imports -- the relay identity row is hex
import { hexToBytes } from "@motebit/encryption";

/** The relay's own identity, as the federation callbacks take it. */
function relayIdentityOf(r: SyncRelay): RelayIdentity {
  const row = r.moteDb.db
    .prepare(
      "SELECT relay_motebit_id, public_key, private_key_hex, did FROM relay_identity LIMIT 1",
    )
    .get() as {
    relay_motebit_id: string;
    public_key: string;
    private_key_hex: string;
    did: string;
  };
  return {
    relayMotebitId: row.relay_motebit_id,
    publicKey: hexToBytes(row.public_key),
    privateKey: hexToBytes(row.private_key_hex),
    publicKeyHex: row.public_key,
    did: row.did,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const STALE_HORIZON_MS = 3_600_000; // index.ts STALE_ALLOCATION_HORIZON_MS

interface World {
  relay: SyncRelay;
  db: SyncRelay["moteDb"]["db"];
  q: TaskQueue;
  W: { id: string; kp: KeyPair };
  D: string;
  S: string;
  A: string;
}

let current: World | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await current?.relay.close();
  current = undefined;
});

async function world(): Promise<World> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const relay = await createTestRelay({ enableDeviceAuth: false });
  const kp = await generateKeypair();
  const worker = await createAgent(relay, bytesToHex(kp.publicKey));
  const delegator = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
  const reg = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  expect(reg.status, await reg.clone().text()).toBeLessThan(300);
  const listing = await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 1.0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "kept-claim worker",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
  expect(listing.status, await listing.clone().text()).toBeLessThan(300);
  const S = seedX402PaidTask(relay, {
    workerId: worker.motebitId,
    delegatorId: delegator.motebitId,
    prompt: "kept claim",
    unitCostUsd: 1.0,
  });
  const w: World = {
    relay,
    db: relay.moteDb.db,
    q: new TaskQueue(relay.moteDb.db),
    W: { id: worker.motebitId, kp },
    D: delegator.motebitId,
    S,
    A: `x402-${S}`,
  };
  current = w;
  return w;
}

async function receiptFor(w: World): Promise<ExecutionReceipt> {
  const now = Date.now();
  return signExecutionReceipt(
    {
      task_id: w.S,
      relay_task_id: w.S,
      motebit_id: w.W.id as MotebitId,
      device_id: "svc" as DeviceId,
      submitted_at: now - 1000,
      completed_at: now,
      status: "completed",
      result: "completed result with enough text to count as real work",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: "p",
      result_hash: `h-${crypto.randomUUID()}`,
    },
    w.W.kp.privateKey,
  ) as Promise<ExecutionReceipt>;
}

async function postResult(w: World, r: ExecutionReceipt): Promise<number> {
  const res = await w.relay.app.request(`/agent/${w.W.id}/task/${w.S}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(r),
  });
  return res.status;
}

/** The settlement write fails while on: the claim is taken and left unsettled. */
function crash(w: World, on: boolean): void {
  w.db.exec("DROP TRIGGER IF EXISTS kept_claim_crash");
  if (on) {
    w.db.exec(`CREATE TRIGGER kept_claim_crash BEFORE INSERT ON relay_settlements
               WHEN NEW.task_id = '${w.S}'
               BEGIN SELECT RAISE(ABORT, 'crash between claim and settle'); END;`);
  }
}

/** A claimed, unsettled answer for S (a crash between the claim and the settle). */
async function claimUnsettled(w: World): Promise<ExecutionReceipt> {
  const r = await receiptFor(w);
  crash(w, true);
  expect(await postResult(w, r)).toBe(200);
  expect(claimOf(w), "the answer is claimed and unsettled").toEqual({
    settled: false,
    settling: r.signature,
  });
  return r;
}

function claimOf(w: World): { settled: boolean; settling: string | null } | null {
  const row = w.db.prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?").get(w.S) as
    { task_json: string } | undefined;
  if (row == null) return null;
  const e = JSON.parse(row.task_json) as { settled?: boolean; settling?: string };
  return { settled: e.settled === true, settling: e.settling ?? null };
}

const balance = (w: World, id: string): number => getAccountBalance(w.db, id)?.balance ?? 0;
const refundRows = (w: World): unknown[] =>
  w.db
    .prepare(
      `SELECT allocation_kind, amount FROM relay_transactions WHERE allocation_id = ?
         AND allocation_kind IN ('sweep_refund', 'retry_exhaustion_refund', 'settlement_release')`,
    )
    .all(w.A);
const settlementRows = (w: World): unknown[] =>
  w.db.prepare("SELECT settlement_id FROM relay_settlements WHERE task_id = ?").all(w.S);
const allocation = (
  w: World,
): {
  status: string;
  claim_unrecoverable_at: number | null;
  settlement_blocked_at: number | null;
  settlement_replay_failures: number;
} =>
  w.db
    .prepare(
      "SELECT status, claim_unrecoverable_at, settlement_blocked_at, settlement_replay_failures FROM relay_allocations WHERE allocation_id = ?",
    )
    .get(w.A) as never;
const moneySnapshot = (w: World): string =>
  JSON.stringify([
    w.db.prepare("SELECT * FROM relay_transactions ORDER BY rowid").all(),
    w.db.prepare("SELECT * FROM relay_accounts ORDER BY motebit_id").all(),
    w.db.prepare("SELECT * FROM relay_settlements ORDER BY rowid").all(),
  ]);
const has = (w: World, table: string): boolean =>
  w.db.prepare(`SELECT 1 FROM ${table} WHERE task_id = ?`).get(w.S) !== undefined;

/** Every time-dependent store of S, and its allocation, aged by `ms`. */
function age(w: World, ms: number): void {
  w.db
    .prepare("UPDATE relay_task_queue SET expires_at = ? WHERE task_id = ?")
    .run(Date.now() - ms, w.S);
  w.db
    .prepare("UPDATE relay_task_answers SET answered_at = ? WHERE task_id = ?")
    .run(Date.now() - ms, w.S);
  w.db
    .prepare("UPDATE relay_task_routes SET created_at = ? WHERE task_id = ?")
    .run(Date.now() - ms, w.S);
  w.db
    .prepare("UPDATE relay_allocations SET created_at = ? WHERE allocation_id = ?")
    .run(Date.now() - ms, w.A);
}

async function door(
  w: World,
  body: Record<string, unknown>,
  headers: Record<string, string> = JSON_AUTH,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await w.relay.app.request(`/api/v1/admin/allocations/${w.A}/resolve-blocked`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("kept claim: the race (a)", () => {
  it("a task-cleanup tick that lands while the settlement step awaits never refunds the delegator; the worker is paid once", async () => {
    const w = await world();
    const r = await receiptFor(w);
    // The seam: the settlement step's first await (the trust read), AFTER
    // answerTask wrote the receipt and claimed its settlement.
    const store = w.relay.moteDb.agentTrustStore;
    const real = store.getAgentTrust.bind(store);
    let reached!: () => void;
    const atAwait = new Promise<void>((res) => (reached = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let first = true;
    vi.spyOn(store, "getAgentTrust").mockImplementation(async (...args) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return real(...args);
    });

    const posted = postResult(w, r);
    await atAwait;
    expect(claimOf(w), "inside the window: claimed, not settled").toEqual({
      settled: false,
      settling: r.signature,
    });
    // The real task-cleanup sweep, past the stale horizon.
    w.relay.taskLifecycle.sweep(Date.now() + STALE_HORIZON_MS + 60_000);
    expect(refundRows(w), "the sweep refunds nothing over the claimed receipt").toEqual([]);
    expect(allocation(w).status).toBe("locked");

    release();
    expect(await posted).toBe(200);
    expect(settlementRows(w)).toHaveLength(1);
    expect(balance(w, w.W.id), "the worker is paid").toBeGreaterThan(0);
    expect(balance(w, w.D), "the delegator is not refunded").toBe(0);
    expect(allocation(w).status).toBe("settled");
    expect(claimOf(w)?.settled).toBe(true);
  });
});

describe("kept claim: the 8-day horizon (b)", () => {
  it("queue cleanup keeps a claimed, unsettled entry 8 days past its expiry", async () => {
    const w = await world();
    await claimUnsettled(w);
    age(w, 8 * DAY);
    w.q.cleanup();
    expect(has(w, "relay_task_queue")).toBe(true);
  });

  it("queue eviction keeps a claimed, unsettled entry 8 days past its expiry", async () => {
    const w = await world();
    await claimUnsettled(w);
    age(w, 8 * DAY);
    w.q.evict(0);
    expect(has(w, "relay_task_queue")).toBe(true);
  });

  it("the answer archive keeps a claimed, unsettled answer 8 days on, even with no queue entry", async () => {
    const w = await world();
    await claimUnsettled(w);
    age(w, 8 * DAY);
    // An entry an earlier build already evicted: the claim lives on in the archive.
    w.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(w.S);
    cleanupTaskRoutes(w.db);
    expect(has(w, "relay_task_answers")).toBe(true);
  });

  it("the task route of a claimed, unsettled answer is kept 8 days on", async () => {
    const w = await world();
    await claimUnsettled(w);
    age(w, 8 * DAY);
    cleanupTaskRoutes(w.db);
    expect(has(w, "relay_task_routes")).toBe(true);
  });

  it("8 days on, after every cleanup and the sweep, recovery settles the claim once and nothing is refunded", async () => {
    const w = await world();
    await claimUnsettled(w);
    age(w, 8 * DAY);
    w.q.cleanup();
    w.q.evict(0);
    cleanupTaskRoutes(w.db);
    w.relay.taskLifecycle.sweep(Date.now());
    expect(refundRows(w)).toEqual([]);

    crash(w, false);
    const report = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(report.settled).toContain(w.S);
    expect(settlementRows(w)).toHaveLength(1);
    expect(balance(w, w.W.id)).toBeGreaterThan(0);
    expect(balance(w, w.D)).toBe(0);
    expect(allocation(w).status).toBe("settled");
    await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(settlementRows(w), "never twice").toHaveLength(1);
  });
});

describe("kept claim: the refund doors skip it", () => {
  it("the stale sweep skips an allocation whose task holds a claimed, unsettled answer", async () => {
    const w = await world();
    await claimUnsettled(w);
    const before = moneySnapshot(w);
    w.relay.taskLifecycle.sweep(Date.now() + STALE_HORIZON_MS + 60_000);
    expect(refundRows(w)).toEqual([]);
    expect(allocation(w).status).toBe("locked");
    expect(moneySnapshot(w)).toBe(before);
  });

  it("the stale sweep reads the claim from the archive when the queue entry is gone", async () => {
    const w = await world();
    await claimUnsettled(w);
    w.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(w.S);
    w.relay.taskLifecycle.sweep(Date.now() + STALE_HORIZON_MS + 60_000);
    expect(refundRows(w)).toEqual([]);
    expect(allocation(w).status).toBe("locked");
  });
});

describe("kept claim: settlement_blocked_at (visibility only)", () => {
  it("is set after 12 consecutive failed replays; retries continue and the claim still settles", async () => {
    const w = await world();
    await claimUnsettled(w);
    for (let i = 1; i < SETTLEMENT_BLOCKED_AFTER_FAILURES; i++) {
      const rep = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(rep.replayed).toContain(w.S);
    }
    expect(allocation(w).settlement_replay_failures).toBe(SETTLEMENT_BLOCKED_AFTER_FAILURES - 1);
    expect(allocation(w).settlement_blocked_at, "11 failures: not yet blocked").toBeNull();
    await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(allocation(w).settlement_blocked_at, "the 12th failure marks it").not.toBeNull();

    const health = (await (
      await w.relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER })
    ).json()) as {
      settlement_claims: { blocked: number; allocations: Array<{ allocation_id: string }> };
    };
    expect(health.settlement_claims.blocked).toBe(1);
    expect(health.settlement_claims.allocations.map((a) => a.allocation_id)).toEqual([w.A]);

    // No money path reads it: the sweep still skips, recovery still retries.
    w.relay.taskLifecycle.sweep(Date.now() + STALE_HORIZON_MS + 60_000);
    expect(refundRows(w)).toEqual([]);
    const again = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(again.replayed, "uncapped: the 13th replay runs").toContain(w.S);

    crash(w, false);
    const healed = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(healed.settled).toContain(w.S);
    expect(settlementRows(w)).toHaveLength(1);
    expect(balance(w, w.W.id)).toBeGreaterThan(0);
    expect(allocation(w).settlement_blocked_at, "a settled claim is not blocked").toBeNull();
    expect(allocation(w).settlement_replay_failures).toBe(0);
  });

  it("a replay on a disputed allocation is not counted as a failure", async () => {
    // Driven at the counter: on main a replay on a disputed allocation marks
    // its claim settled with no settlement row (#1156 item 3, fixed by M2 /
    // PR 6), so no failed replay on one is reachable through the door yet.
    const w = await world();
    await claimUnsettled(w);
    w.db
      .prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?")
      .run(w.A);
    for (let i = 0; i < SETTLEMENT_BLOCKED_AFTER_FAILURES; i++) noteClaimReplay(w.db, w.S, false);
    expect(allocation(w).settlement_replay_failures).toBe(0);
    expect(allocation(w).settlement_blocked_at).toBeNull();
    w.db.prepare("UPDATE relay_allocations SET status = 'locked' WHERE allocation_id = ?").run(w.A);
    noteClaimReplay(w.db, w.S, false);
    expect(allocation(w).settlement_replay_failures, "a locked one is counted").toBe(1);
  });
});

describe("kept claim: the operator door (resolve-blocked)", () => {
  it("is master-token only, and every presentation is recorded in relay_auth_events", async () => {
    const w = await world();
    await claimUnsettled(w);
    const none = await door(w, { action: "re-attempt" }, { "Content-Type": "application/json" });
    expect(none.status).toBe(401);
    const wrong = await door(
      w,
      { action: "re-attempt" },
      { "Content-Type": "application/json", Authorization: "Bearer not-the-token" },
    );
    expect(wrong.status).toBe(401);
    expect(allocation(w).claim_unrecoverable_at).toBeNull();

    const ok = await door(w, { action: "record-unrecoverable", evidence: "peer gone" });
    expect(ok.status).toBe(200);
    const events = w.db
      .prepare("SELECT kind, method, path FROM relay_auth_events WHERE path = ?")
      .all(`/api/v1/admin/allocations/${w.A}/resolve-blocked`);
    expect(events).toEqual([
      {
        kind: "master_token",
        method: "POST",
        path: `/api/v1/admin/allocations/${w.A}/resolve-blocked`,
      },
    ]);
  });

  it("re-attempt replays the claimed receipt through recovery's door and pays the worker, never a refund", async () => {
    const w = await world();
    await claimUnsettled(w);
    crash(w, false);
    const res = await door(w, { action: "re-attempt" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.settled).toBe(true);
    expect(settlementRows(w)).toHaveLength(1);
    expect(balance(w, w.W.id)).toBeGreaterThan(0);
    expect(refundRows(w)).toEqual([]);
    expect(allocation(w).status).toBe("settled");
    const twice = await door(w, { action: "re-attempt" });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("NO_UNSETTLED_CLAIM");
    expect(settlementRows(w)).toHaveLength(1);
  });

  it("a re-attempt that fails again is counted and moves no money", async () => {
    const w = await world();
    await claimUnsettled(w);
    const before = moneySnapshot(w);
    const res = await door(w, { action: "re-attempt" });
    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(false);
    expect(allocation(w).settlement_replay_failures).toBe(1);
    expect(moneySnapshot(w)).toBe(before);
  });

  it("record-unrecoverable moves no money, keeps the escrow held, and no sweep or retry refund ever refunds it", async () => {
    const w = await world();
    await claimUnsettled(w);
    const missing = await door(w, { action: "record-unrecoverable" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("EVIDENCE_REQUIRED");

    const before = moneySnapshot(w);
    const res = await door(w, { action: "record-unrecoverable", evidence: "worker key lost" });
    expect(res.status).toBe(200);
    expect(res.body.evidence).toBe("worker key lost");
    expect(moneySnapshot(w), "record-unrecoverable moves no money").toBe(before);
    expect(allocation(w).status).toBe("locked");
    expect(allocation(w).claim_unrecoverable_at).not.toBeNull();

    // While the claim stays unsettled, the marker holds the escrow: neither
    // the sweep nor a retry-exhaustion refund returns it to the delegator.
    w.relay.taskLifecycle.sweep(Date.now() + 30 * DAY);
    expect(refundExhaustedForward(w.db, { retry_id: "r", settlement_id: "x", task_id: w.S })).toBe(
      "skipped",
    );
    expect(refundRows(w)).toEqual([]);
    expect(allocation(w).status).toBe("locked");
    expect(moneySnapshot(w)).toBe(before);
  });

  it("a claim recorded unrecoverable that then settles by a forward, which exhausts, is refunded as on main and the marker is cleared", async () => {
    const w = await world();
    const r = await claimUnsettled(w);
    const rec = await door(w, { action: "record-unrecoverable", evidence: "worker unreachable" });
    expect(rec.status).toBe(200);
    expect(allocation(w).claim_unrecoverable_at).not.toBeNull();

    // The claim then settles BY a federated forward (the origin's settlement
    // step), which the peer never acknowledges.
    vi.stubGlobal("fetch", async () => {
      throw new Error("peer down");
    });
    const held = allocationHeld(w.db, w.A);
    expect(
      await forwardOriginSettlement(w.db, relayIdentityOf(w.relay), {
        taskId: w.S,
        receiptSignature: r.signature,
        peerRelayId: "gone",
        grossAmount: held,
        platformFeeRate: 0.05,
        receiptHash: "rh",
        x402TxHash: null,
        x402Network: null,
      }),
    ).toBe("queued");
    markTaskSettled(w.q, w.S, r.signature);
    expect(claimOf(w)?.settled).toBe(true);
    expect(allocation(w).claim_unrecoverable_at, "a settled claim clears its marker").toBeNull();

    // Retry exhaustion: the gross returns and is refunded to the hold payer.
    w.db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
    await processSettlementRetries(w.db, relayIdentityOf(w.relay), (retry) => {
      refundExhaustedForward(w.db, retry);
    });
    vi.unstubAllGlobals();
    expect(balance(w, w.D), "the delegator is refunded, as on main").toBe(held);
    expect(allocation(w).status).toBe("released");
    expect(allocationHeld(w.db, w.A)).toBe(0);
  });

  it("a marker left on a claim that has settled never holds the escrow against retry exhaustion", async () => {
    // Defense in depth for the probe above: a marker that outlived its claim
    // (written outside the door, or by a build that did not clear it) is read
    // only while the claim is unsettled.
    const w = await world();
    const r = await claimUnsettled(w);
    vi.stubGlobal("fetch", async () => {
      throw new Error("peer down");
    });
    const held = allocationHeld(w.db, w.A);
    expect(
      await forwardOriginSettlement(w.db, relayIdentityOf(w.relay), {
        taskId: w.S,
        receiptSignature: r.signature,
        peerRelayId: "gone",
        grossAmount: held,
        platformFeeRate: 0.05,
        receiptHash: "rh",
        x402TxHash: null,
        x402Network: null,
      }),
    ).toBe("queued");
    markTaskSettled(w.q, w.S, r.signature);
    w.db
      .prepare(
        "UPDATE relay_allocations SET claim_unrecoverable_at = ?, claim_unrecoverable_evidence = 'stale' WHERE allocation_id = ?",
      )
      .run(Date.now(), w.A);
    w.db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
    await processSettlementRetries(w.db, relayIdentityOf(w.relay), (retry) => {
      refundExhaustedForward(w.db, retry);
    });
    vi.unstubAllGlobals();
    expect(balance(w, w.D)).toBe(held);
    expect(allocation(w).status).toBe("released");
    expect(allocationHeld(w.db, w.A)).toBe(0);
  });

  it("a claim recorded unrecoverable that later settles through recovery clears the marker", async () => {
    const w = await world();
    await claimUnsettled(w);
    expect((await door(w, { action: "record-unrecoverable", evidence: "x" })).status).toBe(200);
    crash(w, false);
    const rep = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
    expect(rep.settled).toContain(w.S);
    expect(allocation(w).claim_unrecoverable_at).toBeNull();
    expect(allocation(w).status).toBe("settled");
  });

  it("refuses both claim actions while the allocation is disputed", async () => {
    const w = await world();
    await claimUnsettled(w);
    crash(w, false);
    w.db
      .prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?")
      .run(w.A);
    const before = moneySnapshot(w);
    const re = await door(w, { action: "re-attempt" });
    expect(re.status).toBe(409);
    expect(re.body.code).toBe("ALLOCATION_DISPUTED");
    const rec = await door(w, { action: "record-unrecoverable", evidence: "x" });
    expect(rec.status).toBe(409);
    expect(rec.body.code).toBe("ALLOCATION_DISPUTED");
    expect(allocation(w).claim_unrecoverable_at).toBeNull();
    expect(settlementRows(w)).toHaveLength(0);
    expect(moneySnapshot(w)).toBe(before);
  });

  it("answers 404 for an unknown allocation and 400 for an unknown action", async () => {
    const w = await world();
    const unknown = await w.relay.app.request("/api/v1/admin/allocations/no-such/resolve-blocked", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ action: "re-attempt" }),
    });
    expect(unknown.status).toBe(404);
    const bad = await door(w, { action: "refund" });
    expect(bad.status).toBe(400);
  });
});
