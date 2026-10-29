/**
 * Governed repo change — the wire artifacts an agent's repository change is
 * verified from (spec/repo-change-v1.md; design of record
 * docs/proposals/governed-repo-change-v1.md).
 *
 * Three unsigned shapes, each bound by a signature elsewhere:
 *
 *   - `RepoTaskScope` (`motebit/repo-task-scope@1.0`) — the principal's
 *     detached scope. Bound into a `StandingDelegation` by `subject_binding`
 *     (the grant's signature reaches it through the digest).
 *   - `RepoChangeResult` (`motebit/repo-change@1.0`) — the change record. It is
 *     the canonical-JSON `result` string of the agent's `ExecutionReceipt`, so
 *     the agent's receipt signature reaches it.
 *   - `RepoChangeBundle` (`motebit/repo-change-bundle@1.0`) — every artifact a
 *     verifier needs, landed in the repository at
 *     `.motebit/bundles/<grant_id>.json`.
 *
 * The verification law is `verifyRepoChange` in `@motebit/verifier`; it
 * returns a `VerificationVerdict` with `type: "repo_change"` whose every
 * failure carries one of {@link ALL_REPO_CHANGE_REPAIR_CODES}.
 */

import type { DigestRef } from "./evidence-provenance.js";
import type {
  DelegationToken,
  ExecutionReceipt,
  StandingDelegation,
  ToolInvocationReceipt,
} from "./index.js";

/** `schema` tag of a repo-task scope — the field `verifySubjectBinding` reads. */
export const REPO_TASK_SCOPE_SCHEMA = "motebit.repo-task-scope.v1" as const;
/** `spec` tag of a repo-task scope. */
export const REPO_TASK_SCOPE_SPEC_ID = "motebit/repo-task-scope@1.0" as const;
/** `spec` tag of the change record (the `ExecutionReceipt` `result` payload). */
export const REPO_CHANGE_SPEC_ID = "motebit/repo-change@1.0" as const;
/** `spec` tag of the evidence bundle. */
export const REPO_CHANGE_BUNDLE_SPEC_ID = "motebit/repo-change-bundle@1.0" as const;
/** The `StandingDelegation.subject` a repo-change grant carries. */
export const REPO_CHANGE_SUBJECT = "repo-change" as const;
/** The only branch a repo-task scope names. */
export const REPO_TASK_BASE_REF = "main" as const;
/** The most tool receipts one bundle may carry. */
export const REPO_CHANGE_MAX_TOOL_RECEIPTS = 256;
/** The longest a repo-change grant may live (`expires_at - issued_at`), in ms: 24 hours. */
export const REPO_CHANGE_MAX_GRANT_LIFETIME_MS = 86_400_000;

/**
 * The two capabilities a repo-change grant may name. A grant's `scope`, a
 * tick's `scope` and a receipt's `delegated_scope` are comma-separated lists of
 * these names and nothing else.
 */
export type RepoChangeTool = "repo_read_blob" | "repo_write_path";

/** Frozen list of every {@link RepoChangeTool}. */
export const ALL_REPO_CHANGE_TOOLS: readonly RepoChangeTool[] = Object.freeze([
  "repo_read_blob",
  "repo_write_path",
]);

/**
 * Git's object format (`extensions.objectFormat`): the hash a repository names
 * its objects by. It fixes the length of every commit and blob id in a scope's
 * change record: 40 lowercase hex characters for `sha1`, 64 for `sha256`.
 * Agile by append: a new git object format is one entry here and one length.
 */
export type GitObjectFormat = "sha1" | "sha256";

/** Frozen list of every {@link GitObjectFormat}. */
export const ALL_GIT_OBJECT_FORMATS: readonly GitObjectFormat[] = Object.freeze(["sha1", "sha256"]);

/** Length, in lowercase hex characters, of an object id under each format. */
export const GIT_OBJECT_ID_HEX_LENGTH: Readonly<Record<GitObjectFormat, number>> = Object.freeze({
  sha1: 40,
  sha256: 64,
});

/**
 * The principal's detached scope for one repository task. Unsigned: a
 * `StandingDelegation` binds it with `subject_binding` (`artifact_schema` =
 * {@link REPO_TASK_SCOPE_SCHEMA}, `digest` = hex SHA-256 of its canonical JSON).
 */
export interface RepoTaskScope {
  /** {@link REPO_TASK_SCOPE_SCHEMA} — the field `verifySubjectBinding` checks. */
  readonly schema: typeof REPO_TASK_SCOPE_SCHEMA;
  /** The spec tag, {@link REPO_TASK_SCOPE_SPEC_ID}. */
  readonly spec: typeof REPO_TASK_SCOPE_SPEC_ID;
  /** The repository the change lands in, compared byte-exact with the verifier's expected repository. */
  readonly repo: string;
  /** Always `"main"`: the protected branch the change lands on. */
  readonly base_ref: typeof REPO_TASK_BASE_REF;
  /** The repository's git object format; fixes the length of every object id. */
  readonly object_format: GitObjectFormat;
  /**
   * Repository-relative paths the change may add or modify. Each segment
   * matches `[A-Za-z0-9._-]+`; no `.`, `..` or `.git` (any case) segment; no
   * leading `/`. Unique. Compared byte-exact with git's path bytes.
   */
  readonly allowed_paths: readonly string[];
  /** The most entries (added or modified paths) one change may have. Integer, at least 1. */
  readonly max_changed_files: number;
  /** The task text the run starts from. `prompt_hash` is hex SHA-256 of its UTF-8 bytes. */
  readonly task: string;
}

/**
 * One path the change adds or modifies, as git records it in the tree the
 * change commit produces.
 */
export interface RepoChangeEntry {
  /** Repository-relative path, canonical under the scope's path rule. */
  readonly path: string;
  /** Git file mode as six octal digits, for example 100644. */
  readonly mode: string;
  /** Blob object id, lowercase hex of the scope's object-format length. */
  readonly blob: string;
}

/**
 * The change record: the canonical-JSON `result` of the agent's
 * `ExecutionReceipt` for every receipt status (spec/repo-change-v1.md §8,
 * deviation 1).
 */
export interface RepoChangeResult {
  /** The spec tag, {@link REPO_CHANGE_SPEC_ID}. */
  readonly spec: typeof REPO_CHANGE_SPEC_ID;
  /** The grant the run acted under. */
  readonly grant_id: string;
  /** SHA-256 of the canonical JSON of the whole signed grant, signature included. */
  readonly grant_digest: DigestRef;
  /** SHA-256 of the canonical JSON of the whole signed tick, signature included. */
  readonly tick_digest: DigestRef;
  /** SHA-256 of the canonical JSON of the scope — equal to the grant's `subject_binding.digest`. */
  readonly scope_digest: DigestRef;
  /** The scope's `repo`. */
  readonly repo: string;
  /** The scope's `object_format`. */
  readonly object_format: GitObjectFormat;
  /** The commit the change commit sits on. */
  readonly parent_commit: string;
  /** The change commit. */
  readonly head_commit: string;
  /** Every path the change adds or modifies, sorted by path bytes, unique. */
  readonly entries: readonly RepoChangeEntry[];
  /** SHA-256 of the canonical JSON of each signed tool receipt in the bundle. */
  readonly tool_receipt_digests: readonly DigestRef[];
  /** SHA-256 of the UTF-8 bytes of the system prompt the run used. */
  readonly system_prompt_digest: DigestRef;
  /** The inference provider the run used (informational). */
  readonly provider: string;
  /** The model the run used (informational). */
  readonly model: string;
  /** The runtime version that ran the task (informational). */
  readonly runtime_version: string;
}

/**
 * The `ExecutionReceipt` profile a repo-change bundle carries: `public_key` is
 * required (the receipt verifies offline under it), and the fields that bring
 * meaning a repo-change verifier does not judge — sub-delegations, relay
 * binding, payment and fetched-source fields — are absent.
 */
export type RepoChangeExecutionReceipt = Omit<
  ExecutionReceipt,
  | "public_key"
  | "delegation_receipts"
  | "relay_task_id"
  | "service_result_hash"
  | "source_digest"
  | "source_projection"
  | "source_projection_class"
> & {
  /** The agent's Ed25519 public key, 64 lowercase hex. Required. */
  readonly public_key: string;
};

/** The `ToolInvocationReceipt` profile a repo-change bundle carries: `public_key` is required. */
export type RepoChangeToolInvocationReceipt = Omit<ToolInvocationReceipt, "public_key"> & {
  /** The agent's Ed25519 public key, 64 lowercase hex. Required. */
  readonly public_key: string;
};

/**
 * Everything a verifier needs, in one file. Its bytes MUST be exactly the
 * canonical JSON of this shape, with no other keys.
 */
export interface RepoChangeBundle {
  /** The spec tag, {@link REPO_CHANGE_BUNDLE_SPEC_ID}. */
  readonly spec: typeof REPO_CHANGE_BUNDLE_SPEC_ID;
  /** The principal's scope, digest-bound by the grant's `subject_binding`. */
  readonly scope: RepoTaskScope;
  /** The principal's `StandingDelegation` to the agent. */
  readonly grant: StandingDelegation;
  /** The principal's per-tick `DelegationToken` under the grant; `grant_id` is required. */
  readonly tick: DelegationToken & { readonly grant_id: string };
  /** At most {@link REPO_CHANGE_MAX_TOOL_RECEIPTS}. */
  readonly tool_receipts: readonly RepoChangeToolInvocationReceipt[];
  /** The agent's signed outcome; its `result` is the change record. */
  readonly receipt: RepoChangeExecutionReceipt;
}

/**
 * Repair codes a repo-change verdict carries, one per failed rule
 * (spec/repo-change-v1.md §7). The prefix names the verdict axis the rule
 * fails (`identity` for `identityBinding`, as in the existing verdict codes).
 * Agile by append; a code's meaning never changes.
 */
export type RepoChangeRepairCode =
  // integrity
  | "integrity.repo_change.bundle_malformed"
  | "integrity.repo_change.bundle_not_canonical"
  | "integrity.repo_change.value_not_canonical"
  | "integrity.repo_change.signature_invalid"
  | "integrity.repo_change.result_hash_mismatch"
  | "integrity.repo_change.result_malformed"
  | "integrity.repo_change.result_not_canonical"
  | "integrity.repo_change.scope_binding_mismatch"
  | "integrity.repo_change.grant_id_mismatch"
  | "integrity.repo_change.grant_digest_mismatch"
  | "integrity.repo_change.tick_digest_mismatch"
  | "integrity.repo_change.scope_digest_mismatch"
  | "integrity.repo_change.scope_reference_mismatch"
  | "integrity.repo_change.prompt_hash_mismatch"
  | "integrity.repo_change.tool_receipts_mismatch"
  | "integrity.repo_change.task_id_mismatch"
  | "integrity.repo_change.shape_check_failed"
  // identityBinding
  | "identity.repo_change.delegator_not_principal"
  | "identity.repo_change.delegate_not_agent"
  | "identity.repo_change.delegator_is_delegate"
  | "identity.repo_change.signer_not_delegate"
  // authority
  | "authority.repo_change.tick_expired"
  | "authority.repo_change.tick_not_yet_valid"
  | "authority.repo_change.tick_insufficient"
  | "authority.repo_change.tick_outlives_grant"
  | "authority.repo_change.time_unavailable"
  | "authority.repo_change.subject_binding_absent"
  | "authority.repo_change.subject_binding_wrong_schema"
  | "authority.repo_change.subject_wrong"
  | "authority.repo_change.scope_tools_outside"
  | "authority.repo_change.lifetime_exceeded"
  | "authority.repo_change.spend_ceiling_present"
  | "authority.repo_change.cadence_below_lifetime"
  | "authority.repo_change.repo_mismatch"
  | "authority.repo_change.grant_spent"
  | "authority.repo_change.delegated_scope_outside"
  | "authority.repo_change.tools_used_outside"
  | "authority.repo_change.tool_receipt_outside_scope"
  | "authority.repo_change.tools_used_mismatch"
  | "authority.repo_change.memories_formed"
  | "authority.repo_change.scope_path_not_permitted"
  | "authority.repo_change.entry_not_add_or_modify"
  | "authority.repo_change.entry_symlink"
  | "authority.repo_change.entry_submodule"
  | "authority.repo_change.entry_mode"
  | "authority.repo_change.entry_binary"
  | "authority.repo_change.entry_case_collision"
  | "authority.repo_change.entry_path_not_allowed"
  | "authority.repo_change.entry_path_not_permitted"
  | "authority.repo_change.entries_exceed_max"
  | "authority.repo_change.entries_mismatch"
  | "authority.repo_change.grant_not_yet_valid"
  | "authority.repo_change.window_inverted"
  | "authority.repo_change.tick_predates_grant"
  // revocation
  | "revocation.repo_change.revoked"
  | "revocation.repo_change.unchecked"
  | "revocation.repo_change.set_malformed";

/** Frozen list of every {@link RepoChangeRepairCode}, in axis order. */
export const ALL_REPO_CHANGE_REPAIR_CODES: readonly RepoChangeRepairCode[] = Object.freeze([
  "integrity.repo_change.bundle_malformed",
  "integrity.repo_change.bundle_not_canonical",
  "integrity.repo_change.value_not_canonical",
  "integrity.repo_change.signature_invalid",
  "integrity.repo_change.result_hash_mismatch",
  "integrity.repo_change.result_malformed",
  "integrity.repo_change.result_not_canonical",
  "integrity.repo_change.scope_binding_mismatch",
  "integrity.repo_change.grant_id_mismatch",
  "integrity.repo_change.grant_digest_mismatch",
  "integrity.repo_change.tick_digest_mismatch",
  "integrity.repo_change.scope_digest_mismatch",
  "integrity.repo_change.scope_reference_mismatch",
  "integrity.repo_change.prompt_hash_mismatch",
  "integrity.repo_change.tool_receipts_mismatch",
  "integrity.repo_change.task_id_mismatch",
  "integrity.repo_change.shape_check_failed",
  "identity.repo_change.delegator_not_principal",
  "identity.repo_change.delegate_not_agent",
  "identity.repo_change.delegator_is_delegate",
  "identity.repo_change.signer_not_delegate",
  "authority.repo_change.tick_expired",
  "authority.repo_change.tick_not_yet_valid",
  "authority.repo_change.tick_insufficient",
  "authority.repo_change.tick_outlives_grant",
  "authority.repo_change.time_unavailable",
  "authority.repo_change.subject_binding_absent",
  "authority.repo_change.subject_binding_wrong_schema",
  "authority.repo_change.subject_wrong",
  "authority.repo_change.scope_tools_outside",
  "authority.repo_change.lifetime_exceeded",
  "authority.repo_change.spend_ceiling_present",
  "authority.repo_change.cadence_below_lifetime",
  "authority.repo_change.repo_mismatch",
  "authority.repo_change.grant_spent",
  "authority.repo_change.delegated_scope_outside",
  "authority.repo_change.tools_used_outside",
  "authority.repo_change.tool_receipt_outside_scope",
  "authority.repo_change.tools_used_mismatch",
  "authority.repo_change.memories_formed",
  "authority.repo_change.scope_path_not_permitted",
  "authority.repo_change.entry_not_add_or_modify",
  "authority.repo_change.entry_symlink",
  "authority.repo_change.entry_submodule",
  "authority.repo_change.entry_mode",
  "authority.repo_change.entry_binary",
  "authority.repo_change.entry_case_collision",
  "authority.repo_change.entry_path_not_allowed",
  "authority.repo_change.entry_path_not_permitted",
  "authority.repo_change.entries_exceed_max",
  "authority.repo_change.entries_mismatch",
  "authority.repo_change.grant_not_yet_valid",
  "authority.repo_change.window_inverted",
  "authority.repo_change.tick_predates_grant",
  "revocation.repo_change.revoked",
  "revocation.repo_change.unchecked",
  "revocation.repo_change.set_malformed",
]);
