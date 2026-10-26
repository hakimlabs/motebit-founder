# Dispute money path (design, revision 12, consolidated; design review CLOSED: GO)

Revision 9 replaced every earlier design section; revisions 10 and 11 edit it in place for review rounds 9 and 10 (revision 4's D1–D9, revision 5's E1–E8 and revision 6–8's R-sections). Each mechanism is stated once, here. The review rounds at the bottom are the record of what each part answers. Tracked as #1152; the money defects are #1156.

## Governing rule and invariants

**Rule (founder/PE direction, 2026-10-25):** neither a verdict nor a timeout may create money authority that did not already exist. Three things are kept apart:

- what the protocol **decided**: the signed verdict;
- what it **authorized**: the money that verdict names, inside the escrow the task already held;
- what **happened**: the ledger transition that committed.

**Invariants:**

- **I1 Escrow.** A `disputed` allocation produces no outflow except the one its governing verdict authorizes.
- **I2 One disposition.** An allocation's money has one disposition at a time, decided by a compare-and-set slot. A second claimant is deferred or superseded, never paid twice and never silently dropped.
- **I3 Two finalities.** A verdict is final when signed. Its money is final only when the ledger transition commits. A blocked execution is retried idempotently; it is never replaced and never substituted.
- **I4 Liveness without invention.** Every state has a bounded automatic next step, or a visible blocked record with one named authorized exit. The exceptions are the states listed in Limits as **terminal held**: there, no authority exists to move the money, and it stays held and visible by rule. A timeout restores prior authority; it never picks a winner.
- **I5 Conservation and counterfactual.** Escrow is conserved across every interleaving. A lapse ends with the ledger the no-dispute run would have.

**The basis** is a reconstruction of the reachable state machine from code (transition table, 13 cross-machine interactions, 12 stranded states S1–S12), plus probes by five cold reviews on origin/main `6560d45f8`. That main includes #1155, #1157, #1158 and #1172.

## M1. The disposition slot

- **The column.** `relay_allocations.disposition` holds one of:
  - NULL (open);
  - `settlement:<receipt_sig>`;
  - `refund:<sweep|retry>`;
  - `forward:<forward_id>`;
  - `verdict:<dispute_id>:<round>`.
- **The transitions.** Each is a compare-and-set inside the transaction that moves the money:
  - `open → settlement | refund | forward | verdict`;
  - `settlement → verdict` (a post-settlement claw-back);
  - `forward → open`, on `forward_return`.
  - Releasing a surplus or a buffer belongs to the slot that already holds.
- **On a `forward:` slot:** `forward_return` (an **inflow**) moves the slot back to open. `sweep_refund` and `settlement_release` of the risk buffer above the forward's gross are part of the `forward:` slot, because the buffer is not the forward's money. A refund of the gross itself needs `forward → open` first.
- **Where it is enforced.** `moveAllocationMoney` reads `status` and the slot:
  - a non-dispute **outflow** on a `disputed` allocation **throws** `DeferredByDispute`. `forward_return` is an inflow and is exempt, since I1 restricts only outflows;
  - a kind whose transition the slot does not allow throws `SupersededBy`;
  - every caller is updated in the same PR;
  - **the stale sweep isolates each allocation** in its own SAVEPOINT. Main runs every allocation in one transaction, so a single throw would stop refunds relay-wide. A refused row is flagged and skipped; the others proceed.
- **Backfill.** Every existing row is classified from its ledger and status. A row that can't be classified gets `legacy_unclassified_slot` and an allocation-level blocked record (M5).
- **Harness law:** every money row's kind is allowed by the slot's state at that time.

## M2. Receipts during a dispute

Every receipt door (result POST, MCP forward callback, federation result, multi-hop sub-receipt, recovery replay) admits through `admitReceipt` → `answerTask`, unchanged. On a `disputed` allocation:

- the settle step returns **not settled** (today it returns true, and the task is marked settled: #1156 item 3);
- the claim stays `settling`.

When the dispute ends:

- **a verdict** takes the slot, and the deferred claim closes as `superseded`;
- **a lapse** (M6) restores the pre-dispute status, and recovery settles the claim through its own door.

## M3. A claim is kept until it settles (PR 1)

A claimed-but-unsettled answer (`settling IS NOT NULL AND settled = 0`) is kept, with no time limit, in **all three stores a replay needs**:

- the queue entry: `heldClaim` drops its `expires_at` floor;
- the answer archive: `cleanupTaskRoutes` does not delete it;
- **the task's route**: `cleanupTaskRoutes` keeps a route whose task has such a claim, because `answerTask` refuses `not_routed` without one.

**Retention.** These are kept until the claim settles, or until the operator records it `unrecoverable` (M5). Recording `unrecoverable` writes `relay_allocations.claim_unrecoverable_at`, a durable allocation-level marker. The sweep and `task-cleanup` skip on **it** as well as on the stores. So the escrow stays held even after the stores are released, and no refund can happen over the valid receipt.

**The sweep and `task-cleanup`** skip an allocation whose task holds such a claim. This also closes a race that needs no dispute: a worker answering after 1 h lost to a refund that ran while settlement was awaiting.

**Visibility.** `relay_allocations.settlement_blocked_at` is set after 12 consecutive replay failures. It is for visibility only (admin health) and is never read by a money path. Recovery skips allocations under dispute without counting them as failures.

## M4. Forwards (a legacy-only path)

**Why this is legacy-only.** Under M1 a `federated_forward` on a `disputed` allocation throws, and M2 defers the federation settle step that starts forwards. M7 refuses filing when the slot holds a forward. So a forward on a disputed allocation exists only on **legacy rows**: main admits filing on a `locked` federated-origin allocation with a forward pending, because filing checks only status. For those rows:

- **A forward never sent** is decided by a **send marker**, not by `attempts = 0`. Main's first send happens inline before any attempt is counted, and a non-2xx response leaves `attempts = 0` with the forward `pending`. So `beginForwardSend` writes `sent_at` on the forward row **before** every POST, and "never sent" means `sent_at IS NULL`.
  - **Such a forward is closed `superseded` in the verdict's transaction.** Its gross returns to escrow before the verdict distributes, and a `peer_obligation_unpaid` row records the peer, the gross and the dispute. The peer's worker did the work, and the claim is exported.
- **When a forward is superseded:** `beginForwardSend` refuses `superseded`, and the verdict's transaction retires the forward's retry row.
- **A forward sent but not acknowledged** (`sent_at` set) is **`blocked:forward_in_doubt`**. The peer may already have credited its worker (`recordInboundFederatedSettlement` credits on arrival, and the origin leaves the forward `pending` on any non-2xx response), so returning its gross would risk paying twice. The money stays held and visible. The M5 door is its exit, with evidence of the peer's acknowledgement or refusal.
- **Legacy rows (B2).** PR 5's migration stamps every existing forward `sent_at = created_at`, meaning "sent, outcome unknown". "Never sent" can be proved only for a forward created after the marker shipped. So every legacy pending forward on a disputed allocation is `blocked:forward_in_doubt`, and **its gross is never returned**.
- **A forward already `delivered`** is out of escrow, and the verdict distributes only what remains (Limits).

**A `failed` or `denied` federated result** is never forwarded. It releases to the delegator through the slot.

## M5. Execution status and the one operator door

**Where status lives.** Execution status is on `relay_dispute_resolutions` (one row per dispute and round), as `exec_status`:

- **NULL**: not due (the dispute is not `final`).
- **`pending`**: the dispute is `final` and this round governs it.
- **`applied`**: written from a **typed outcome**. `executeFundAction` returns `{ kind: 'applied' } | { kind: 'blocked', reason, sub }`, never a bare normal return, because today `refuse()` also returns normally. `exec_status` is written from that outcome, in the same transaction, and every `refuse()` is `blocked`. `applied` covers:
  - a money move, with its `relay_dispute_fund_actions` row;
  - `amount_locked = 0` (P2P or zero value);
  - `priorDisputeRows > 0`;
  - a claim conflict on an already-closed allocation.
- **`blocked:<reason>`**: the reasons are `frozen`, `clawback_insufficient`, `unroutable:<sub-reason>`, `under_review:<flag>`, `unroutable_refund`, `failed_forward_unrefunded`, `legacy_cross_allocation_dispute`, `legacy_ambiguous_dispute_rows`, `forward_in_doubt`, `adjudication_exhausted`, `no_allocation` and `task_mismatch`.

  `no_allocation` and `task_mismatch` also **restore the dispute's own allocation's pre-dispute status**, derived from its ledger, as a lapse would. That allocation's own money was never the verdict's to move.

- **`superseded`**: round 1, when a round-2 resolution exists.

The **governing round** is round 2 if it exists, otherwise round 1.

**A quorum fallback is not a verdict (B1).** On main a federation round whose orchestration row is `timed_out` with fewer than `FEDERATION_QUORUM_MIN` votes carries a 0.5 `split` written by `aggregateVotes`'s fallback. Such a resolution is **never** `pending`: it is `blocked:quorum_fallback` (held, visible, no money moved). This applies to rows the fallback has already written and to rows it writes before PR 10 removes it. PR 3's loop and migration apply it; PR 8's re-queue excludes these rows; and PR 10 lapses a dispute whose **round-1** resolution is a fallback (`pre_dispute_*` restored), so the split never executes.

**A round-2 fallback row is void.** It is not "a round-2 resolution" for the governing round, for `superseded`, or for M8's `appealed` migration. Round 1 governs, as on an appeal lapse (M6). Only a round-1 fallback lapses the dispute. Otherwise a quorum failure in the appeal would void a signed round-1 verdict.

**The `dispute-disposition` loop** (supervised; exempt from the freeze, since a refused move becomes `blocked:frozen`):

- retries the governing round's `pending` and `blocked:frozen`;
- retries `blocked:clawback_insufficient` with backoff;
- runs `resolved → final` past the appeal window. Today that happens only lazily on read (S5).

**Apply-once.** `relay_dispute_fund_actions` keeps its meaning exactly: one row per allocation, written in the transaction that moves the money. A refusal never inserts a fund-action row. A retry updates its own resolution row by compare-and-set (`exec_status <> 'applied'`).

**The one operator door:** `POST /api/v1/admin/allocations/:id/resolve-blocked`. It requires the master token and is recorded in `relay_auth_events`.

**What it acts on.** The **governing item**:

- the governing verdict's execution, when the allocation is `disputed`;
- otherwise, the deferred settlement claim (M3) or a `legacy_unclassified_slot`.

A disputed allocation can carry both a deferred claim and a blocked verdict at once. The verdict governs, and settlement-claim actions are refused while the allocation is `disputed`. Verdict-execution and legacy-flag actions are allowed then.

**Its three actions:**

- **Classify a legacy flag** (`legacy_*`, `legacy_unclassified_slot`), with stated evidence: either **clear** it (the allocation is single-payer and correct) or confirm it. A cleared flag makes the item retryable. `review_reason` is never cleared anywhere on main today.
- **Re-attempt** the governing item's own action (never another payee, never a refund instead).
- **Record `unrecoverable`**, with evidence.

What `unrecoverable` does, per item:

- **A verdict execution:** the money stays held in escrow, and the §7.5 hold on the worker is released (it is a recorded loss of the claw-back, not a transfer).
- **A settlement claim:** the escrow **stays held** and visible, exactly as for a verdict. Releasing it to the hold payer over a valid signed receipt would be a substituted refund. The authorized exit for a claim that cannot settle is a **pre-settlement dispute**: M7 admits `locked`, answered, unsettled. Its verdict then takes the slot.
- **A legacy slot:** it is classified by the operator's stated evidence, and the money then follows the normal path.

## M6. Deadlines and the lapse (relay clock)

| State                                     | Deadline                   | On expiry                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence`                                | `evidence_deadline` (48 h) | adjudication may begin; `/resolve` is refused before then (#1172)                                                                                                                                                                         |
| `evidence`/`arbitration`                  | `evidence_deadline` + 72 h | **lapse**                                                                                                                                                                                                                                 |
| `resolved`                                | `resolved_at` + 24 h       | `final`; the governing round becomes `pending`                                                                                                                                                                                            |
| `appealed` with **no** round-2 resolution | `appealed_at` + 72 h       | round 2 lapses; round 1 governs and becomes `pending`                                                                                                                                                                                     |
| `appealed` **with** a round-2 resolution  | —                          | goes `final` at once, with round 2 `pending` or `blocked:<reason>`. Round 2 governs, and it is never lapsed. The migration moves main's existing rows of this shape (a refused round 2 leaves `appealed` plus a round-2 row) the same way |

**The lapse's terminal state.** `relay_disputes.state = 'lapsed'`, a new terminal state. Every reader of the state changes in the same PR (PR 10):

- the §7.5 hold (`account-store-sqlite.ts`, `NOT IN ('final','expired')` → also `'lapsed'`);
- the per-filer rate limit (the same predicate);
- the one-dispute-per-task index **and** the filing transaction's own `NOT EXISTS … state != 'expired'` guard (`disputes.ts:1606`), so **a lapse frees the slot and the allocation can be disputed again**;
- the P2P eligibility reader (`task-routing.ts:1691`, `NOT IN ('final','expired')`), so a lapse no longer bars a pair from P2P settlement for ever;
- the partial index (`disputes.ts:138`) and the admin `total_amount_locked` (`disputes.ts:2355`).

All of these read one shared predicate, `isLiveDisputeState(state)`, defined once. PR 10 adds a static gate refusing any other spelling of the live-dispute set.

- every writer guard (none of them accepts `lapsed`);
- the state export.

Re-filing is the named exit for a pre-settlement allocation that stalled in adjudication: for example an undetermined, receipt-less task whose adjudicator never ruled. Re-filing is capped at **3 disputes per allocation**. Past the cap the allocation is a door item (`blocked:adjudication_exhausted`): the money stays held and visible, and it is listed in Limits.

**Rows already open on main.** Before a lapse, and in PR 10's migration:

- **Deriving `pre_dispute_*`.** For disputes filed before the column exists, `pre_dispute_status` is `settled` if a `relay_settlements` row exists for the task, otherwise `locked`, and `pre_dispute_slot` comes from M1's backfill.
- **Receipts main dropped.** A pre-settlement allocation whose task is `settled = 1` with **no** `relay_settlements` row is one where main dropped the receipt (#1156 item 3).
  - If the receipt is still archived, the claim is **re-opened** (`settled = 0`, `settling` = its signature) before the lapse, so recovery settles it.
  - If the receipt is gone, the lapse does **not** restore `locked`. The allocation becomes a door item (`blocked:receipt_lost`), held and visible. A refund over a receipt main dropped would be a timeout picking a winner.
- **Deploy grace.** Deadlines for disputes that existed before the deploy count from **the later of** their natural deadline and deploy + 72 h, so no row that had no deadline before lapses on the first tick.

**What a lapse does.** It restores `pre_dispute_status` and `pre_dispute_slot` (both recorded at filing) in one transaction guarded on state, and writes a `relay_dispute_lapses` row. It moves no money itself. Afterwards the normal path runs: recovery settles a kept claim (M3), a forward resumes (M4), and the sweep treats an unanswered task as it would have.

**What happens below quorum.** `aggregateVotes` returns **no verdict**, never a 0.5 split, and the orchestrator's `timed_out` commits nothing. The lapse is the only writer at expiry. The loop starts federation orchestration at `evidence_deadline`.

**Who may write dispute state.** Every writer is guarded on state:

- round 1 commits through `finalizeFederationResolution` `WHERE state IN ('evidence','arbitration')`;
- round 2 commits **only** through `commitRound2Verdict` `WHERE state = 'appealed'`. `finalizeFederationResolution` loses its round-2 branch. The deferred worker's round-2 branch is **re-pointed** at `commitRound2Verdict`, not deleted: once `/appeal` defers below quorum (it creates the round-2 orchestration row), the worker is the round-2 retry, and without it one transient peer failure would void an appeal;
- the lapse is guarded on the same sets;
- `/resolve` checks `persisted` and returns 409 with the standing record.

**What the freeze touches.** Filing, `/resolve` signing, appeal recording, evidence, `dispute-orchestration` and the deadline loop are all **exempt** from the freeze. None writes money except through the chokepoint, which the freeze stops (`blocked:frozen`). So no window is consumed by a freeze, and no deadline is extended.

## M7. Filing eligibility, and what a pre-settlement verdict pays

**Who may file.** A dispute is admitted only for a task with exactly one relay-custody allocation, filed by a party of it, on the relay's clock.

| Allocation state                                                                | Admitted                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `locked`, answered, unsettled                                                   | yes: pre-settlement; the receipt is deferred (M2)      |
| `locked`, granted, lease lapsed (`undetermined_at` set)                         | yes: pre-settlement; adjudicates the uncertain outcome |
| `locked`, lease live (running)                                                  | no (spec §4.3)                                         |
| `settled`, inside the §4.5 window                                               | yes: post-settlement                                   |
| `locked`, never granted; `released`; `disputed`; slot holds a forward or refund | no (409)                                               |

**`undetermined`.** The dispute legs no longer refuse on `undetermined`. A verdict is the authority that adjudicates it, and it takes the slot, so a later receipt is superseded. The settlement transaction clears `undetermined`. Flags are kept by severity: a genuine external flag (`unroutable_refund`, `failed_forward_unrefunded`, the two `legacy_*` flags) is never overwritten by `undetermined`. Verdicts already `blocked:under_review:undetermined` are re-queued `pending` in the PR that ships this.

**What a pre-settlement verdict pays.** It pays **what settlement would have paid**, through a new money kind, `dispute_settle`, which needs its harness alphabet entry and its gate update:

- the worker's net goes to the payee, who is the deferred receipt's verified signer, or `alloc.motebit_id` when there is no receipt;
- the platform fee goes to the treasury;
- the risk buffer goes back to the hold payer.

A `split` divides the net by `split_ratio`, and the fee is charged only on the worker's share. On a **settled** allocation, leftover escrow always returns to the hold payer.

**How the fee is recorded.** The dispute fee is a `relay_allocation_fees` row keyed `settlement_id = 'dispute:<dispute_id>:<round>'`. The key is non-NULL, so `heldSql`'s `NOT IN` subquery stays correct. The row stamps `x402_network`, taken from `relay_x402_settlements` joined on `task_id`, so the EVM reconciler attributes it without a join. It adds **only** the `dispute:%` rows to its existing `relay_settlements` sum, never the whole journal, which would count every settlement fee twice. The writer must always set the key, because SQLite's primary key allows NULL. The Solana reconciler is unchanged: it sums only P2P fee legs.

## M8. The §7.5 hold

**Before `final`:** main's §7.5(b) hold stays as it is: the worker's whole settled credit is held from filing until the dispute is `final` (or `lapsed`). PR 3 must not narrow it.

**After `final`:** what is held is the claw-back still owed by the **governing** round's verdict while its `exec_status` is `pending` or `blocked:*`. The owed amount is 0 for `no_allocation` and `task_mismatch` (the task belongs to another allocation's payee), so those are listed but never held.

**Released only by:** `applied`, a lapse, or an operator-recorded `unrecoverable`.

**Keyed on:** the payee, i.e. the account the settlement credited (the #959 residual; closed in PR 9).

**Migration.** Resolution rows are backfilled:

- `applied` when the dispute is `final` with no `fund_refusal`;
- `blocked:<fund_refusal>:<sub>` when it has one. The sub-reason is read from `relay_allocations.review_reason`, because `fund_refusal` stores only `under_review` or `unroutable`. That lets PR 8's re-queue select `under_review:undetermined`;
- `appealed` with a round-2 row that is **not** a B1 fallback: the dispute becomes `final`, round 2 is `pending` (or `blocked:<fund_refusal>:<sub>`), and round 1 is `superseded`. `appealed` with only a round-2 **fallback** row: the fallback is void, round 1 governs and is `pending` (as on an appeal lapse);
- NULL when the dispute is otherwise not final;
- `superseded` for round 1 when a non-fallback round-2 row exists.

## Precedence

**Freeze** (money writes only) **> slot > governing verdict > recovery > sweep.**

## Limits (stated, not solved)

- **A stalling relay that is a party keeps the status quo.** Every lapse, with whether the relay was a party, is exported in the signed state export. A financial guarantee against the relay needs adjudicators it does not control.
- **Money already forwarded cannot be clawed back unilaterally.** The shortfall and every `peer_obligation_unpaid` are exported for an inter-relay mechanism that is not specified here.
- **An undetermined outcome with neither a receipt nor a verdict stays held and visible.** The reason is not double payment: a refund in the slot would supersede any later receipt. It is that releasing it automatically would be a timeout picking a winner. The exits are a fresh dispute, up to 3, then the door's record. Spec §7 states this.
- **Terminal held states.** In these, no party holds authority to move the money, so it stays held and visible by rule, never released by a timeout:
  - `adjudication_exhausted`;
  - a verdict execution recorded `unrecoverable`;
  - `receipt_lost`;
  - a settlement claim recorded `unrecoverable`.

  A future exit needs a genuine authority, for example a release signed by both parties, which is not specified here.

- **Repeated filing can keep money locked** for up to 3 × about 120 h. That is bounded by the per-allocation cap, and every lapse is exported.
- **Reachability INFERRED:** a federated-origin relay-custody allocation; zero-`amount_locked` (S2); legacy multi-payer rows (S9). Each PR's red-on-main test establishes reachability or records that the path is unreachable.

## Spec changes (one spec PR, after the code)

- **delegation-v1 §6.1:** add `settled → disputed` and `disputed → locked | settled` (lapse). A failed receipt goes `locked → settled`.
- **dispute-v1:**
  - §3: drop the never-written `opened` state; single-relay disputes skip `arbitration`.
  - §3.3: `lapsed` is a terminal relay **record** (`relay_dispute_lapses`, exported). There is no new wire type and no package bump.
  - §4.3: running tasks are not disputable.
  - §6.3/§6.6: below quorum there is no verdict, and the deadline counts from the evidence window's close.
  - §7.3–§7.5: the pre-settlement base and the hold as above.
  - §7: the undetermined limit.

## GO / NO-GO, and how review ends

**Design: review round 11 is the last whole-design round.** Its stopping rule is the governing rule and I1–I5 only:

- unauthorized movement;
- double payment or loss;
- a timeout deciding a winner;
- a contradiction that would build the wrong thing.

Findings below that line are implementation details. From round 11 onwards they become **acceptance criteria on the named PR**, and each PR carries its own red-on-main tests, tamper checks and cold review. Rounds 8–10 found progressively deeper legacy, migration and implementation details. Those are real, and per-PR review against code catches them better than another whole-design pass.

**Implementation:** NO-GO until round 11 returns GO under that stopping rule.

## Implementation order (each PR is small, red on main and tampered, and needs human approval; none leaves main worse)

1. **M3:** keep a claim in the queue, the archive and the route; add the `claim_unrecoverable_at` marker; the sweep and cleanup skip it; `settlement_blocked_at`; the operator door's settlement action.
2. **M6 guards:** `finalizeFederationResolution` loses its round-2 branch and gains its state guard; `/resolve` returns 409 when nothing was persisted.
3. **M5:**
   - `executeFundAction`'s typed outcome;
   - `exec_status` with the full value set;
   - the governing round;
   - `applied` on every successful return;
   - the loop and `resolved → final` by loop;
   - the round-2 resolution finalized and never lapsed;
   - the door's verdict action;
   - **M8's hold**, with §7.5(b) unchanged before `final`;
   - the door's flag-classification action;
   - the migration.
4. **M7 flags:** `undetermined` is cleared on settlement, and flags are kept by severity.
5. **M1 + M4:** the slot with its transitions (including the `forward:` buffer rule) and backfill; deferral throws, with `forward_return` exempt; the per-allocation SAVEPOINT in the stale sweep; the send marker, the refusal of `superseded` and retry-row retirement; the forward gate, the legacy forward rule (never-sent → superseded with `peer_obligation_unpaid`; sent → `blocked:forward_in_doubt`), and no forwarding of failed or denied results.
6. **M2:** receipts deferred on a `disputed` allocation.
7. **M7 money:** `dispute_settle`, the fee journal's non-NULL key and network stamp, and leftover escrow returned to the hold payer.
8. **M7 eligibility:** `undetermined` adjudicable; `blocked:under_review:undetermined` re-queued; and the filing refusals for a live lease and for a never-granted task.
9. **M8 keyed on the payee** (#959).
10. **M6 deadlines:** the `lapsed` state with every reader on `isLiveDisputeState` and its gate; re-opening dropped receipts and `receipt_lost`; derivation of `pre_dispute_*`; the deploy grace; re-filing with its cap, the lapse, "no quorum, no verdict", orchestration started at `evidence_deadline`, the freeze exemptions, `relay_dispute_lapses` and its export, and the counterfactual harness law. The harness must run `cleanupTaskRoutes` past day 7.
11. **The spec PR.**

## Acceptance criteria per PR (from review round 11; each is enforced by that PR's own red-on-main test and cold review)

- **PR 1**
  - Removing `heldClaim`'s floor also covers `evict()` (`stmtEvictOldest`); eviction is tested, not only `cleanup`.
  - `claim_unrecoverable_at` is read by the stale sweep, `refundExhaustedForward` and `task-cleanup`.
- **PR 2**
  - The 409 test for `/resolve` covers the synchronous federation path as well as single-relay.
- **PR 3**
  - When `FundActionRefused` rolls back the money transaction, `exec_status = blocked:clawback_insufficient` and `final` are committed in a **second** transaction. Today the whole finalize rolls back and no outcome row is written.
  - The `task_mismatch` / `no_allocation` restore checks that no other non-terminal dispute references the allocation.
  - `unrecoverable` on `clawback_insufficient` is refused while the payee's balance covers part of the owed amount. That part is clawed back first.
  - B1's `blocked:quorum_fallback` applies in both the migration and the loop.
- **PR 4**
  - `undetermined` never overwrites an existing `review_reason`, tested against main's first-wins `COALESCE` (index.ts:329).
- **PR 5**
  - B2's backfill.
  - Retry exhaustion on a disputed allocation: eight non-2xx answers count as evidence the forward was **not** delivered (as in the no-dispute run), so the exempt `forward_return` stands; this is stated in a test.
  - While the allocation is `disputed`, the retry loop does not resend.
- **PR 6**
  - Closing a deferred claim as `superseded` releases the M3 stores and clears `settling`.
  - Each receipt door gets its own test: the result POST, the MCP callback, the federation result, the multi-hop sub-receipt and the recovery replay.
- **PR 7**
  - The `dispute_settle` payee must pass the chokepoint's party check. On a federated origin the signer is the peer's worker; where it fails the check, the outcome is `blocked:unroutable`, never a credit to a non-party.
  - The fee row's `settlement_id` is never NULL, enforced by a test (and by a CHECK constraint where a rebuild is acceptable).
- **PR 8**
  - The re-queue excludes B1 rows.
  - The filing refusals (live lease, never granted) are red on main.
- **PR 9**
  - The hold is keyed on the account the ledger credited, tested with path agent ≠ payee (#959).
- **PR 10**
  - The lapse restores **status only**, and compare-and-sets the slot only if it is unchanged since filing. A blind `forward:` restore over a forward that failed would strand the gross.
  - `pre_dispute_slot` for disputes filed before the column existed is the current slot at migration time.
  - When quorum and the lapse land on the same tick, exactly one commits; tested.
  - A re-filing after a lapse still respects the §4.5 window; tested.
- **PR 11**
  - The spec states that below-quorum rows written before the fix are not verdicts.

## Review round 2 (REVISE): findings revision 3 answers

Cold review of revision 2, probed on origin/main `2e66afc67`. Each point is confirmed unless marked.

1. **A pre-settlement lapse is not neutral.** A receipt that arrives while the allocation is `disputed` is dropped (`tasks.ts:1484-1488` claims only `WHERE status='locked'`). Once the allocation reverts to `locked`, `releaseStaleAllocations` refunds the delegator in full. So D1's "the normal path decides" picks the delegator. Revision 3 must either restore the pre-dispute status and settle from the archived receipt, or rule pre-settlement disputes inadmissible. §4.3/§4.5 read literally ("within the window **after settlement**") already imply the second, which contradicts §7.1's two regimes. A new law is needed: **the lapse outcome equals the no-dispute counterfactual.** Conservation cannot see this.
2. **D6 is backwards.** The federation path runs only when the relay is a party. The status quo then gives a stalling relay 100%, where main's split gives 50%. The relay also controls quorum through its own `relay_peers`. The remedy D6 relies on has no exported artifact (no disputes in `state-export.ts`). Candidate: when the relay is a party, a lapse goes against the party that controls the forum. Fallback: keep the split for that case only. The §6.2(2) case (an agent alleging relay misconduct between two agents) runs on the single-relay path today, so the operator rules on its own conduct.
3. **`resolved → final` is bounded only on read.** D5 must scan `resolved` too.
4. **The terminal state must be `final`.** Every reader keys on `{final, expired}`. A lapse recorded as `expired` lets the filer re-file, so the lock length is the filer's again.
5. **D2 is not expressible as written.** `fund_action` is a required closed enum with no "move nothing" value. `DisputeOutcome` is shared with `AdjudicatorVote.vote`, so the resolution needs its own union. §3.3 is foundation law, so the change is more than a minor bump.
6. **The orchestrator's own timer still writes the 0.5 split** at first `/resolve` + 72 h, ahead of D4's lapse.
7. **Round 2 with ≥3 peers and <3 votes is an immediate final 0.5 split** (`disputes.ts:1908`, no deferral).
8. **`appealed_at` is party-chosen**, stored verbatim. The skew refusal shipped with #1153, PR A.
9. **A lapse racing a resolve.** The lapse must insert the `(dispute_id, round)` row in its own transaction, and `finalizeFederationResolution` must guard on state (`dispute-orchestration.ts:271-285`). `/resolve` returns 200 on a verdict it did not persist (`disputes.ts:1723-1762`).
10. **The evidence window is a cap, not a guarantee.** A defendant relay's `/resolve` before the deadline moves the dispute to `arbitration` and refuses the party's evidence. `/resolve` should be refused before `evidence_deadline`.

Decided by the code: the deploy straddle backfills from `relay_disputes.created_at`, which is relay time and exists since the table was created. Witness-omission disputes have no lifecycle on main (`horizon.ts:615-645`) and are out of scope.

## Review round 3 (REVISE): findings revision 4 answers

1. R1's "pre-settlement disputes inadmissible" stranded a granted-but-unanswered task's escrow (the stale sweep never releases it): answered by D1/D2, which keep them admissible.
2. R1's admissible set refused failed-receipt settlements that §4.3 makes eligible: no longer applicable.
3. `non_payment` has no door to federation: D6's category routing.
4. A single-relay appeal had no round-2 door: fixed in #1158.
5. The freeze consumed evidence and appeal windows and decided outcomes: the D4 exemption plus deadline extension.
6. A refused fund action had no R2 row: D9.
7. A lapse left the allocation `disputed`: D2 writes the pre-dispute status.
8. `/resolve` moved money by `split_ratio` against the signed verdict: fixed in #1157.
9. Federation orchestration starts only on `/resolve`: D6 (the loop starts it).
10. Wire gaps: `executes_round` is not specified; widening the published `DisputeResolution` type is a semver break. D7 uses an additive `DisputeLapse` type.
11. Spec scope incomplete: delegation §6.1 edges, dispute §1/§6.6/§10. D2/D6 name them, and the spec PR edits all of them.
12. "Already enforced by #1155" was stated while #1155 was still open: it is merged now.

## Review round 4 (REVISE): findings revision 5 must answer

1. D2's restored `locked`, plus the stale sweep, refunds the delegator before the deferred receipt settles: both are 60 s loops with no ordering (probe: delegator +1,052,632, worker 0). Revision 5: settle the deferred receipt **inside** the lapse transaction, or have the sweep skip claimed-unsettled tasks.
2. D1's replay reads only `relay_task_queue`, and a claimed-unsettled entry is deleted 7 days past expiry. The longest path back to `locked` (about 216 h) outlives it. Revision 5: replay from the `relay_task_answers` archive.
3. A granted-unanswered task flagged `undetermined` (a sticky flag after 1 h) refuses every fund action (`under_review`). **Any dispute filed more than an hour after admission can never move that escrow.** This is a main bug (#1156).
4. D3 is incomplete and can strand money:
   - an existing forward is still sent through `beginForwardSend` while `disputed`
   - retries exhaust after about 21 min, with no re-send after the dispute
   - a refused forward leaves no row, yet the task is marked settled
   - a refused `forward_return` leaves the forward `pending` forever
5. Sibling receipt doors D1 missed: the multi-hop sub-receipt claim (`tasks.ts` ~1936) and the federation origin door.
6. D6 plus category routing is exploitable. `category` is the filer's free choice, and in agent-vs-agent disputes the relay is not a party, so "against the relay" is undefined. Below quorum, any agent wins by routing. Revision 5: route for adjudication only, and let those lapses follow D5's counterfactual.
7. D6 is not applied in round 2: a relay can void an appeal by stalling.
8. Freeze history is not persisted (one overwritten `freeze_state` row). The deadline extension needs a new interval record.
9. Appeal POSTs do move money (a lazy finalize, and an inline federation round 2). The exemption is still safe at the chokepoint, but its stated premise is wrong.
10. D7 contradicts itself:
    - it widens the type and also says it doesn't
    - a §3.3 change is more than a minor bump
    - the package versions it cites are wrong (protocol 3.19.0, crypto 4.0.1)
    - `executes_round` is undefined for D5
    - "none" must bypass `split_ratio`
    - a lapse row hits NOT NULL columns
    - `finalizeFederationResolution` is still unguarded
11. Minor: there is no 30-day claim window on main; D9 also uses the lapse edges; `unroutable` retries on read; `appealed_at` is within 15 min, not exact.

Safe to start now (per the reviewer): refuse `/resolve` before `evidence_deadline`; exempt the **evidence** POST from the entry freeze.

## Review round 5 (REVISE): findings revision 6 answers

Cold review of revision 5, probed on `ce5efdc37` with #1172 applied:

- **C1 (below-quorum split):** R6.1.
- **C2 (unguarded `finalizeFederationResolution`, round 2 without money):** R6.2.
- **C3 (hold released at `final`; reproducible on main):** R6.3.
- **C4 (sticky `undetermined`, first reason wins):** R6.4.
- **C5 (the slot as write-once contradicted post-settlement and forward flows):** R6.5.
- **O1 (PR 2 alone could double-pay a forward):** R6.6, with PRs 2 and 4 merged.
- **O2 (PR 6 before E7 spread a wrong payout):** R6.7, with the order changed.
- **P1–P5:** R6.6, R6.7, R6.9, and PR 1's exit.
- **Answered with defects:**
  - E2's replay source and the lapse's in-transaction settle: R6.9.
  - The running-task contradiction: R6.8.
  - The incomplete `blocked` list: R6.10.
  - The lost round-3 finding 9: R6.1.
  - `/resolve` reporting 200 on a verdict it did not persist: R6.2.
- **Over-built:** `relay_freeze_intervals` and archive replay are both dropped (R6.9).

## Review round 6 (REVISE): findings revision 7 answers

Cold review of revision 6 on `6560d45f8`, which includes #1172:

1. An appeal lapse overrode a persisted round-2 verdict: R7.1.
2. PR 2 alone stranded below-quorum disputes: R7.2.
3. The pre-settlement fee had no lawful record or payee: R7.4.
4. PR 1's exit didn't exist, and "N = 12" was false: R7.5.
5. PR 2 depended on PR 3: R7.3.
6. The freeze consumed adjudication windows: R7.6.
7. The hold was open-ended: R7.7.

The `unroutable` sub-reasons are added (R7.8). Over-built: the in-transaction lapse settle and the signed `DisputeLapse` were dropped, and the disposition table was merged into the fund-action record. The forward gate was kept, with the reason stated (R7.8).

## Review round 7 (REVISE): findings revision 8 answers

Cold review of revision 7 on `6560d45f8`:

- F1, the day-7 deletion of the queue and archive: R8.1.
- F2, the write-once fund-action constraints: R8.2.
- F3, the hold narrowed: R8.3.
- The contradictions in §3.3, E8 and R7.4: fixed in place and by R8.6.
- P1 and P2: R8.5.
- Over-built, two doors: merged by R8.4.

## Review round 8 (REVISE): findings revision 9 answers

- Route deleted at day 7: M3 keeps all three stores.
- No status for a not-yet-due or superseded round: M5 adds NULL and `superseded` and defines the governing round.
- `applied` missed three success paths: M5.
- A NULL fee key broke `heldSql`: M7's non-NULL key.
- The EVM join found nothing: M7 stamps the network.
- `task_mismatch` and `no_allocation` were held: M8 holds 0 for them.
- Plausible findings:
  - the round-2 path through `finalizeFederationResolution` (M6);
  - "unrecoverable" meaning two things (M5, one meaning per item);
  - the legacy slot with no exit (M5's door covers it).
- The over-built layering: consolidated into this single revision.

## Review round 9 (REVISE): findings revision 10 answers

- **C1 / C2:** the lapse's state is named (`lapsed`), every reader is listed, and re-filing (capped at 3) is the exit.
- **C3:** a settlement claim's `unrecoverable` keeps the money held.
- **C4:** `appealed` plus a round-2 row migrates to `final`.
- **C5:** a typed outcome, with sub-reasons taken from `review_reason`.
- **C6:** the door's flag-classification action.
- **C7:** M4 is legacy-only, with `forward_in_doubt`.
- **P1:** the §7.5(b) pre-final hold is kept.
- **P2:** a `task_mismatch` or `no_allocation` outcome restores the dispute's own allocation.
- **P3:** the filing refusals are in PR 8.
- **P4:** claim actions are refused while the allocation is disputed.
- **P5:** the EVM reconciler adds only `dispute:%` rows.
- **Over-built:** the dead round-2 worker branch is deleted.

## Review round 10 (REVISE): findings revision 11 answers

1. `attempts = 0` is not "never sent": M4's `sent_at` send marker, the refusal of `superseded`, and retry-row retirement.
2. Stores released after `unrecoverable` let the sweep refund: M3's `claim_unrecoverable_at` marker.
3. Legacy dropped receipts refunded by a lapse: M6 re-opens the claim, or marks `receipt_lost`.
4. Readers of the dispute state were missing: the shared `isLiveDisputeState` predicate and its gate.
5. One throw stopped the whole sweep: a per-allocation SAVEPOINT, and the `forward:` slot transitions defined.
6. The door's wording: three actions, the governing item, and the refusal scope.

Plausible findings:

- **7:** `forward_return` exempt as an inflow.
- **8:** `pre_dispute_*` derivation.
- **9:** I4 states terminal held states honestly.
- **10:** a deploy grace.
- **11:** the round-2 worker branch is re-pointed, not deleted.

Over-built: the per-filer rate limit is no longer cited as a lock bound.

## Review round 11 (final; REVISE with two blocking findings, answered in revision 12)

- **B1** (a quorum fallback becomes an executed verdict): M5's `blocked:quorum_fallback`, with PR 3, PR 8 and PR 10 handling.
- **B2** (legacy forwards read as never sent): M4's backfill to `sent_at = created_at`, so every legacy pending forward is in doubt.

The reviewer stated that with B1 and B2 added it saw no other blocking finding under the narrowed rule. All other findings became the per-PR acceptance criteria above.

**B1/B2 wording check (round-11 reviewer):** REVISE on wording only.

- The B2 sentences were moved out of the never-sent bullet into their own bullet ending "its gross is never returned", and the never-sent fragment was repaired.
- B1 gained the round-2 carve-out: a round-2 fallback row is void and round 1 governs. M8's migration carries the same carve-out.

The reviewer stated that, with these changes, the design is GO under the narrowed stopping rule, with no other blocking findings.
