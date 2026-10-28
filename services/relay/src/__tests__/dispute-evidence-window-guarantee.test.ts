/**
 * The evidence window promised to dispute parties is a guarantee
 * (spec/dispute-v1.md §5.3, §5.4, §6.6).
 *
 * 1. `POST /api/v1/disputes/:id/resolve` was accepted before the dispute's
 *    `evidence_deadline` (the relay's receive time + 48 h, §4.4), so the
 *    operator — who on the federation path may itself be a party — could
 *    decide before the other side's evidence was in. A round-1 resolve is now
 *    refused 409 `DISPUTE_EVIDENCE_WINDOW_OPEN` until the relay's clock
 *    reaches the deadline, and the refusal writes nothing.
 * 2. The emergency freeze 503'd the evidence POST at entry, so an operator
 *    freeze consumed a party's evidence window. Evidence moves no money; the
 *    freeze holds where money moves (services/relay/CLAUDE.md rule 30). The
 *    evidence POST alone is exempt — filing, appeal and resolve stay refused.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  signDisputeRequest,
  signDisputeEvidence,
  signDisputeAppeal,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  closeEvidenceWindow,
  JSON_AUTH,
  createTestRelay,
  createAgent,
  seedX402PaidTask,
} from "./test-helpers.js";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };

let relay: SyncRelay;
afterEach(async () => {
  vi.useRealTimers();
  await relay?.close();
});

interface World {
  wKp: Keypair;
  dKp: Keypair;
  worker: string;
  delegator: string;
  taskId: string;
  allocId: string;
}

/** An x402-paid task, settled by the worker's completed receipt. */
async function settledWorld(): Promise<World> {
  relay = await createTestRelay();
  const wKp = await generateKeypair();
  const dKp = await generateKeypair();
  const worker = await createAgent(relay, bytesToHex(wKp.publicKey));
  const delegator = await createAgent(relay, bytesToHex(dKp.publicKey));
  for (const [a, kp, port] of [
    [worker, wKp, 3200],
    [delegator, dKp, 3201],
  ] as const) {
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: a.motebitId,
        endpoint_url: `http://localhost:${port}/mcp`,
        capabilities: ["web_search"],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
  }
  const taskId = seedX402PaidTask(relay, {
    workerId: worker.motebitId,
    delegatorId: delegator.motebitId,
    prompt: "p",
    unitCostUsd: 1.0,
  });
  const { allocation_id } = relay.moteDb.db
    .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ?")
    .get(taskId) as { allocation_id: string };
  const w: World = {
    wKp,
    dKp,
    worker: worker.motebitId,
    delegator: delegator.motebitId,
    taskId,
    allocId: allocation_id,
  };
  const enc = new TextEncoder();
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: w.worker as unknown as MotebitId,
      device_id: "svc" as unknown as DeviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed",
      result: "done",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("p")),
      result_hash: await sha256(enc.encode("done")),
    },
    wKp.privateKey,
  );
  const res = await relay.app.request(`/agent/${w.worker}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  expect(res.status).toBe(200);
  return w;
}

async function fileRequest(w: World): Promise<{ disputeId: string; res: Response }> {
  const disputeId = `dsp-window-${crypto.randomUUID()}`;
  const req = await signDisputeRequest(
    {
      dispute_id: disputeId,
      task_id: w.taskId,
      allocation_id: w.allocId,
      filed_by: w.delegator,
      respondent: w.worker,
      category: "quality",
      description: "d",
      evidence_refs: ["r"],
      filed_at: Date.now(),
    },
    w.dKp.privateKey,
  );
  const res = await relay.app.request(`/api/v1/allocations/${w.allocId}/dispute`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(req),
  });
  return { disputeId, res };
}

async function file(w: World): Promise<string> {
  const { disputeId, res } = await fileRequest(w);
  expect(res.status, await res.clone().text()).toBe(200);
  return disputeId;
}

async function resolve(disputeId: string): Promise<Response> {
  return relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ resolution: "upheld", rationale: "the work was inadequate" }),
  });
}

async function submitEvidence(w: World, disputeId: string, by: "worker" | "delegator") {
  const ev = await signDisputeEvidence(
    {
      dispute_id: disputeId,
      submitted_by: by === "worker" ? w.worker : w.delegator,
      evidence_type: "execution_receipt",
      evidence_data: { claim: by },
      description: `${by} evidence`,
      submitted_at: Date.now(),
    },
    by === "worker" ? w.wKp.privateKey : w.dKp.privateKey,
  );
  return relay.app.request(`/api/v1/disputes/${disputeId}/evidence`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(ev),
  });
}

async function appeal(w: World, disputeId: string): Promise<Response> {
  const ap = await signDisputeAppeal(
    {
      dispute_id: disputeId,
      appealed_by: w.worker,
      reason: "round 1 was wrong",
      appealed_at: Date.now(),
    },
    w.wKp.privateKey,
  );
  return relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(ap),
  });
}

async function freeze(): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/freeze", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ reason: "evidence-window test" }),
  });
  expect(res.status).toBe(200);
}
async function unfreeze(): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/unfreeze", {
    method: "POST",
    headers: JSON_AUTH,
  });
  expect(res.status).toBe(200);
}

/**
 * Every table except the auth-event log (a master-token presentation is
 * recorded there by design, rule 6) — the whole of the relay's state.
 */
function stateSnapshot(): Record<string, string> {
  const db = relay.moteDb.db;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    if (name === "relay_auth_events") continue;
    out[name] = JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  }
  return out;
}

const disputeRow = (id: string) =>
  relay.moteDb.db
    .prepare(
      "SELECT state, evidence_deadline, resolved_at FROM relay_disputes WHERE dispute_id = ?",
    )
    .get(id) as { state: string; evidence_deadline: number; resolved_at: number | null };

describe("dispute /resolve is refused while the evidence window is open (§5.3)", () => {
  it("a resolve before evidence_deadline is 409 DISPUTE_EVIDENCE_WINDOW_OPEN and changes no state and no money", async () => {
    const w = await settledWorld();
    const id = await file(w);
    const before = stateSnapshot();
    const res = await resolve(id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; evidence_deadline: number };
    expect(body.code).toBe("DISPUTE_EVIDENCE_WINDOW_OPEN");
    expect(body.evidence_deadline).toBe(disputeRow(id).evidence_deadline);
    expect(stateSnapshot()).toEqual(before);
    expect(disputeRow(id).state).toBe("evidence");
  });

  it("the window is measured on the relay's clock: refused at deadline − 1 ms, resolved at the deadline", async () => {
    const w = await settledWorld();
    const id = await file(w);
    const deadline = disputeRow(id).evidence_deadline;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline - 1);
    const early = await resolve(id);
    expect(early.status).toBe(409);
    expect(disputeRow(id).state).toBe("evidence");
    vi.setSystemTime(deadline);
    const onTime = await resolve(id);
    expect(onTime.status, await onTime.clone().text()).toBe(200);
    const body = (await onTime.json()) as { state: string; resolution: string };
    expect(body.state).toBe("resolved");
    expect(body.resolution).toBe("upheld");
    expect(disputeRow(id).state).toBe("resolved");
  });

  it("a resolve after evidence_deadline proceeds as before (resolved, signed round-1 row, money held for the appeal window)", async () => {
    const w = await settledWorld();
    const id = await file(w);
    const moneyBefore = JSON.stringify(
      relay.moteDb.db.prepare("SELECT * FROM relay_accounts ORDER BY rowid").all(),
    );
    closeEvidenceWindow(relay, id);
    const res = await resolve(id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("resolved");
    const rows = relay.moteDb.db
      .prepare("SELECT round FROM relay_dispute_resolutions WHERE dispute_id = ?")
      .all(id) as Array<{ round: number }>;
    expect(rows).toEqual([{ round: 1 }]);
    // §7.1: funds stay locked through the appeal window.
    expect(
      JSON.stringify(relay.moteDb.db.prepare("SELECT * FROM relay_accounts ORDER BY rowid").all()),
    ).toBe(moneyBefore);
  });

  it("the federation path (the relay is a party) is refused too, before the arbitration transition or any orchestration row", async () => {
    relay = await createTestRelay();
    const id = `dsp-fed-${crypto.randomUUID()}`;
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_disputes
           (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
         VALUES (?, 'task-fed', 'alloc-fed', 'del-fed', ?, 'quality', 'relay as respondent', 'evidence', 0, 0, ?, ?)`,
      )
      .run(id, relay.relayIdentity.relayMotebitId, now, now + 48 * 3600_000);
    const before = stateSnapshot();
    const res = await resolve(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DISPUTE_EVIDENCE_WINDOW_OPEN");
    expect(stateSnapshot()).toEqual(before);
    // Once the window has closed it reaches orchestration (no peers here → 503).
    closeEvidenceWindow(relay, id);
    const after = await resolve(id);
    expect(after.status).toBe(503);
  });
});

describe("the emergency freeze does not consume the evidence window (rule 30, §5.4)", () => {
  it("evidence POST under an active freeze is accepted and recorded", async () => {
    const w = await settledWorld();
    const id = await file(w);
    await freeze();
    const res = await submitEvidence(w, id, "worker");
    expect(res.status, await res.clone().text()).toBe(200);
    const { n } = relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_dispute_evidence WHERE dispute_id = ? AND submitted_by = ?",
      )
      .get(id, w.worker) as { n: number };
    expect(n).toBe(1);
  });

  it("filing under an active freeze is still refused 503", async () => {
    const w = await settledWorld();
    await freeze();
    const { disputeId, res } = await fileRequest(w);
    expect(res.status).toBe(503);
    const row = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId);
    expect(row).toBeUndefined();
  });

  it("resolve under an active freeze is still refused 503, with the evidence window closed", async () => {
    const w = await settledWorld();
    const id = await file(w);
    closeEvidenceWindow(relay, id);
    await freeze();
    const res = await resolve(id);
    expect(res.status).toBe(503);
    expect(disputeRow(id).state).toBe("evidence");
    await unfreeze();
    expect((await resolve(id)).status).toBe(200);
  });

  it("appeal under an active freeze is still refused 503", async () => {
    const w = await settledWorld();
    const id = await file(w);
    closeEvidenceWindow(relay, id);
    expect((await resolve(id)).status).toBe(200);
    await freeze();
    const res = await appeal(w, id);
    expect(res.status).toBe(503);
    expect(disputeRow(id).state).toBe("resolved");
    await unfreeze();
    expect((await appeal(w, id)).status).toBe(200);
  });

  it("the exemption is the evidence route only: a lookalike path under the freeze is still refused 503", async () => {
    const w = await settledWorld();
    const id = await file(w);
    await freeze();
    for (const path of [
      `/api/v1/disputes/${id}/evidence/`,
      `/api/v1/disputes/${id}/evidence/x`,
      `/api/v1/disputes/${id}/x/evidence`,
      `/api/v1/disputes/evidence`,
    ]) {
      const res = await relay.app.request(path, {
        method: "POST",
        headers: JSON_AUTH,
        body: "{}",
      });
      expect(res.status, path).toBe(503);
    }
  });
});
