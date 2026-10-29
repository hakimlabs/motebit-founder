---
"@motebit/wire-schemas": patch
"@motebit/self-knowledge": patch
"@motebit/docs": patch
---

Wire schemas for governed repo change (`spec/repo-change-v1.md`): `RepoTaskScopeSchema`, `RepoChangeEntrySchema`, `RepoChangeResultSchema`, `RepoChangeBundleSchema` and the bundle's receipt profiles `RepoChangeExecutionReceiptSchema` / `RepoChangeToolInvocationReceiptSchema`, with committed JSON Schemas `spec/schemas/repo-task-scope-v1.json`, `repo-change-v1.json` and `repo-change-bundle-v1.json`. Every object is `.strict()`; paths match one regular expression that states the spec's canonical path rule; signatures must be canonical unpadded base64url. The eval-attestation verdict enums gain `repo_change` and `operator_recorded`, regenerated in `eval-attestation-v1.json`.

The spec count (37 → 38) is regenerated into the self-knowledge corpus and the LLM-facing docs corpus.
