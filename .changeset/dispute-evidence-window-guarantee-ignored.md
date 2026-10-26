---
"@motebit/relay": patch
---

The dispute evidence window is now a guarantee (dispute-v1 §5.4). `POST /api/v1/disputes/:disputeId/resolve` used to accept a round-1 verdict right after filing, so the operator, who on the federation path may itself be a party, could decide before the other side's evidence was in. It now answers 409 `DISPUTE_EVIDENCE_WINDOW_OPEN` (with `evidence_deadline`) and writes nothing until the relay's clock reaches the deadline, on the single-relay and federation paths alike. Round 2 is unchanged: its evidence bundle closes when the dispute becomes `appealed` (§8.3), so there is no round-2 deadline to wait for. The emergency freeze used to refuse the evidence POST at entry, so a freeze used up a party's evidence window. That POST moves no money, so `POST /api/v1/disputes/:disputeId/evidence` is now exempt from the freeze at entry. Filing, appeal and resolve are still refused with 503 under the freeze.
