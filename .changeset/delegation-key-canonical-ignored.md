---
"@motebit/relay": patch
"@motebit/molecule-runner": patch
---

The revocation binder's comment and tests now state the canonical-key rule: a `DelegationRevocation`'s own `delegator_public_key` must be 64 lowercase hex (`verifyDelegationRevocation` refuses any other spelling, and the POST route's wire schema already returns 400 for one), while the comparison against keys the relay holds for the delegator stays case-insensitive for legacy device rows. A new test pins that `bindByDelegationRevocation` refuses an UPPERCASE-key revocation (`signature_invalid`) and the route caches nothing.

`@motebit/molecule-runner`: `selfIssueGrant` lowercases the identity's `publicKeyHex` before signing. `bootstrapIdentity` returns `device_public_key` from `motebit.json` verbatim, so a legacy or hand-edited uppercase value would have minted a grant every verifier now rejects (the money seam silently dead); the respelling is the same bytes, the same key.
