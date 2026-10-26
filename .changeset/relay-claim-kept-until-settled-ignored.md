---
"@motebit/relay": patch
---

A claimed-but-unsettled answer keeps its escrow until it settles (#1152 M3, PR 1 of the dispute money path).

- The queue entry, the archived answer and the task route of such a claim are kept with no time limit: `TaskQueue.cleanup` and `evict` lose the 7-day `expires_at` floor (`claimHoldFloor` and `UNSETTLED_CLAIM_HOLD_MS` are removed), and `cleanupTaskRoutes` keeps the route and the archived answer.
- The stale sweep (`task-cleanup`) skips an allocation whose task holds such a claim. The claim is read from the queue or the archive (`holdsUnsettledClaim`). This closes a race with no dispute in it: a sweep tick landing while the settlement step awaited refunded the delegator, and the worker was never paid.
- Migration v60 adds `relay_allocations.claim_unrecoverable_at` (with the operator's evidence), a durable marker the stale sweep and the retry-exhaustion refund skip on, and `settlement_blocked_at` (with a replay-failure count), set after 12 consecutive failed recovery replays. The blocked mark is visibility only, shown in `GET /api/v1/admin/health` under `settlement_claims`.
- New master-token door `POST /api/v1/admin/allocations/:id/resolve-blocked`, recorded in `relay_auth_events`: `re-attempt` replays the claimed receipt through recovery's own door, and `record-unrecoverable` (evidence required) writes the marker and moves no money. Both actions are refused 409 while the allocation is `disputed`.
- Transparency declaration and `PRIVACY.md` updated for the changed retention and the new retained fields.
