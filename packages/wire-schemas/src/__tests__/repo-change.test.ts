/**
 * Governed repo change — wire schemas (spec/repo-change-v1.md).
 *
 * Shape only, on hand-built fixtures (this package does not depend on
 * `@motebit/crypto`); the signed-artifact law is `verifyRepoChange` in
 * `@motebit/verifier`, tested there on real signatures.
 */
import { describe, it, expect } from "vitest";

import {
  REPO_PATH_PATTERN,
  RepoChangeBundleSchema,
  RepoChangeResultSchema,
  RepoTaskScopeSchema,
} from "../repo-change.js";

const KEY = "ab".repeat(32);
const SIG = "A".repeat(86);
const HEX = "cd".repeat(32);
const sha = { algorithm: "sha-256" as const, value: HEX };

function scope() {
  return {
    schema: "motebit.repo-task-scope.v1" as const,
    spec: "motebit/repo-task-scope@1.0" as const,
    repo: "motebit/motebit",
    base_ref: "main" as const,
    object_format: "sha1" as const,
    allowed_paths: ["docs/a.md"],
    max_changed_files: 1,
    task: "Fix the typo.",
  };
}

function record() {
  return {
    spec: "motebit/repo-change@1.0" as const,
    grant_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    grant_digest: sha,
    tick_digest: sha,
    scope_digest: sha,
    repo: "motebit/motebit",
    object_format: "sha1" as const,
    parent_commit: "1".repeat(40),
    head_commit: "2".repeat(40),
    entries: [{ path: "docs/a.md", mode: "100644", blob: "3".repeat(40) }],
    tool_receipt_digests: [sha],
    system_prompt_digest: sha,
    provider: "anthropic",
    model: "model-1",
    runtime_version: "1.0.0",
  };
}

function bundle() {
  const party = {
    delegator_id: "f",
    delegator_public_key: KEY,
    delegate_id: "a",
    delegate_public_key: "ef".repeat(32),
  };
  return {
    spec: "motebit/repo-change-bundle@1.0" as const,
    scope: scope(),
    grant: {
      grant_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      ...party,
      scope: "repo_read_blob,repo_write_path",
      subject: "repo-change",
      subject_binding: {
        schema: "motebit.subject-binding.v1" as const,
        artifact_schema: "motebit.repo-task-scope.v1",
        digest_method: "jcs-sha256-hex" as const,
        digest: HEX,
      },
      cadence_ms: 86_400_000,
      issued_at: 1,
      not_before: null,
      expires_at: 86_400_001,
      max_token_ttl_ms: 3_600_000,
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: SIG,
    },
    tick: {
      ...party,
      scope: "repo_read_blob,repo_write_path",
      issued_at: 1,
      expires_at: 3_600_001,
      grant_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: SIG,
    },
    tool_receipts: [
      {
        invocation_id: "inv-1",
        task_id: "t",
        motebit_id: "a",
        public_key: "ef".repeat(32),
        device_id: "d",
        tool_name: "repo_read_blob",
        started_at: 2,
        completed_at: 3,
        status: "completed" as const,
        args_hash: HEX,
        result_hash: HEX,
        suite: "motebit-jcs-ed25519-b64-v1" as const,
        signature: SIG,
      },
    ],
    receipt: {
      task_id: "t",
      motebit_id: "a",
      public_key: "ef".repeat(32),
      device_id: "d",
      submitted_at: 1,
      completed_at: 4,
      status: "completed" as const,
      result: JSON.stringify(record()),
      tools_used: ["repo_read_blob"],
      memories_formed: 0,
      prompt_hash: HEX,
      result_hash: HEX,
      delegated_scope: "repo_read_blob,repo_write_path",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: SIG,
    },
  };
}

describe("repo-change wire schemas", () => {
  it("accept a well-formed scope, change record and bundle", () => {
    expect(RepoTaskScopeSchema.safeParse(scope()).success).toBe(true);
    expect(RepoChangeResultSchema.safeParse(record()).success).toBe(true);
    expect(RepoChangeBundleSchema.safeParse(bundle()).success).toBe(true);
  });

  it("are strict: an unnamed key is malformed", () => {
    expect(RepoTaskScopeSchema.safeParse({ ...scope(), note: "x" }).success).toBe(false);
    expect(RepoChangeResultSchema.safeParse({ ...record(), note: "x" }).success).toBe(false);
    expect(RepoChangeBundleSchema.safeParse({ ...bundle(), note: "x" }).success).toBe(false);
  });

  it("refuse a receipt outside the repo-change profile", () => {
    const b = bundle();
    expect(
      RepoChangeBundleSchema.safeParse({ ...b, receipt: { ...b.receipt, relay_task_id: "r" } })
        .success,
    ).toBe(false);
    const { public_key: _pk, ...noKey } = b.receipt;
    expect(RepoChangeBundleSchema.safeParse({ ...b, receipt: noKey }).success).toBe(false);
  });

  it("refuse a non-canonical signature spelling", () => {
    const b = bundle();
    expect(
      RepoChangeBundleSchema.safeParse({
        ...b,
        tick: { ...b.tick, signature: "A".repeat(85) + "B" },
      }).success,
    ).toBe(false);
  });

  it("refuse repeated allowed paths and repeated tool receipt digests", () => {
    expect(
      RepoTaskScopeSchema.safeParse({ ...scope(), allowed_paths: ["docs/a.md", "docs/a.md"] })
        .success,
    ).toBe(false);
    expect(
      RepoChangeResultSchema.safeParse({ ...record(), tool_receipt_digests: [sha, sha] }).success,
    ).toBe(false);
  });

  it("require a lowercase-UUID grant_id, and a grant_id on the tick", () => {
    const b = bundle();
    expect(
      RepoChangeBundleSchema.safeParse({ ...b, grant: { ...b.grant, grant_id: "grant-1" } })
        .success,
    ).toBe(false);
    const { grant_id: _g, ...tickNoGrant } = b.tick;
    expect(RepoChangeBundleSchema.safeParse({ ...b, tick: tickNoGrant }).success).toBe(false);
    expect(
      RepoChangeResultSchema.safeParse({
        ...record(),
        grant_id: "0199A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B",
      }).success,
    ).toBe(false);
  });

  it("refuse more than 256 tool receipts", () => {
    const b = bundle();
    const many = Array.from({ length: 257 }, () => b.tool_receipts[0]!);
    expect(RepoChangeBundleSchema.safeParse({ ...b, tool_receipts: many }).success).toBe(false);
  });

  it("refuse a base_ref other than main and a zero max_changed_files", () => {
    expect(RepoTaskScopeSchema.safeParse({ ...scope(), base_ref: "dev" }).success).toBe(false);
    expect(RepoTaskScopeSchema.safeParse({ ...scope(), max_changed_files: 0 }).success).toBe(false);
  });

  it("the path pattern states the canonical path rule", () => {
    for (const ok of ["docs/a.md", ".ci/x.yml", "a/b-c_d.e/f", ".gitignore", "x/.gitkeep"]) {
      expect(REPO_PATH_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/docs/a.md",
      "docs/a.md/",
      "docs//a.md",
      "docs/./a.md",
      "docs/../a.md",
      ".",
      "..",
      ".git/config",
      "a/.GIT/x",
      "a/.Git",
      "docs\\a.md",
      "docs/ſ.md",
      "docs/a b.md",
      "docs/a.",
      ".git./config",
      "a/b./c",
    ]) {
      expect(REPO_PATH_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
