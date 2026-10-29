---
"@motebit/protocol": minor
"@motebit/verifier": minor
---

Governed repo change: `verifyRepoChange` closes two fail-open holes found in cold review, and `RepoChangeRepairCode` gains three appended codes (`authority.repo_change.grant_not_yet_valid`, `authority.repo_change.window_inverted`, `authority.repo_change.tick_predates_grant`).

An evaluation time that is not a finite number (absent, `NaN`, `±Infinity`) now reads `authority: "unknown"` instead of being judged against a fallback clock. The 24-hour lifetime now bounds the authority window: a grant or tick that starts after it expires, or a tick issued before its grant, is `insufficient`; an evaluation time before the grant's or the tick's start (`max(issued_at, not_before)`) is `not_yet_valid`; the lifetime counts from the grant's start. Crypto semantics are unchanged. A bundle's tick must now carry `grant_id` (`RepoChangeBundle.tick` is typed accordingly), a path segment ending in `.` is non-canonical, and a tracked path that is not UTF-8 fails the case-collision rule closed.
