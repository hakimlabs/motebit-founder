---
"@motebit/relay": patch
"motebit": patch
---

A task submitted for an explicit target is executed by that target or by no one; an offline target means the task waits, expires or fails — it never becomes another worker's task. The relay can no longer substitute the executor of a pinned task.

Observed in production (2026-10-12): `motebit delegate --target <phone>` with the phone offline was forwarded over HTTP MCP to a different agent, whose receipt was verified and settled, and no push wake was attempted. Every phase was pin-blind — scored routing ranked the whole market (so even an ONLINE target lost its task to a better-ranked agent), the HTTP-MCP fallback took the first agent listing the capability, and the doors after routing accepted whichever executor a route recorded.

The pin (a P2P `target_agent`, an explicit `target_agent`, or a path agent that is not the submitter, when the submitter is an identity — the verified caller or a known `submitted_by`, never a label like the planner's `"plan_engine"`) is read once from the submission terms and stamped on the queue entry (`pinned_executor`). `task-pin.ts` is the one predicate set every point reads: scored routing selects the target directly (never ranked, never substituted) and the candidate sets pass `candidatesUnderPin`; the HTTP-MCP fallback asks for the target alone; the relay's MCP forward grant (`grantForward`), reconnect recovery, a released forward's re-presentation and the claim door grant or offer a pinned task only to its target; the answer door (`answerTask` step 2b) refuses a receipt signed by anyone else; and settlement attribution (`admitReceipt`) refuses to settle anyone else, independently of the answer door. An inbound federated forward is pinned to the agent it names. Unpinned submissions (the runtime's capability routing to its own path, operator submissions with no submitter) route exactly as before.

The addressed doors name their target, so the pin holds whatever token carries the request: the A2A (`/a2a/agents/:id`) and AP2 (`/ap2/agents/:id/mandate`) bridges submit with `target_agent` set to the addressed agent — their `a2a:…` / `ap2:…` submitter labels name no identity, so the path alone did not pin them.

CLI: `motebit delegate` now also names its worker as `target_agent` (equal to the agent it posts to). With `MOTEBIT_API_TOKEN`, `MOTEBIT_SYNC_TOKEN` or a configured sync token set, the CLI submits with the master token, where the relay can verify no caller; naming the target pins the task even when the relay does not know the delegator's id.
