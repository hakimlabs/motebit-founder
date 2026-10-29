/**
 * Governed repo change — wire schemas (spec/repo-change-v1.md).
 *
 * Three unsigned shapes, each reached by a signature elsewhere:
 *
 *   - `RepoTaskScope` (`motebit/repo-task-scope@1.0`) — the principal's
 *     detached scope, digest-bound into a `StandingDelegation` by
 *     `subject_binding`.
 *   - `RepoChangeResult` (`motebit/repo-change@1.0`) — the change record, the
 *     canonical-JSON `result` of the agent's `ExecutionReceipt`.
 *   - `RepoChangeBundle` (`motebit/repo-change-bundle@1.0`) — the evidence file
 *     `.motebit/bundles/<grant_id>.json`, whose bytes are exactly its canonical
 *     JSON.
 *
 * Every object is `.strict()`: a key the spec does not name is malformed, not
 * ignored, so a field cannot slip into a bundle one producer at a time. The
 * receipts inside a bundle are the repo-change PROFILES of `ExecutionReceipt`
 * and `ToolInvocationReceipt` (`public_key` required; sub-delegation, relay,
 * payment and fetched-source fields absent). Two rules are cross-field and
 * are stated in words rather than expressed here: an object id's length is
 * fixed by `object_format`, and entries are sorted by path. The verification
 * law (`verifyRepoChange`, `@motebit/verifier`) enforces both.
 */

import { z } from "zod";

import {
  ALL_GIT_OBJECT_FORMATS,
  REPO_CHANGE_BUNDLE_SPEC_ID,
  REPO_CHANGE_MAX_TOOL_RECEIPTS,
  REPO_CHANGE_SPEC_ID,
  REPO_TASK_BASE_REF,
  REPO_TASK_SCOPE_SCHEMA,
  REPO_TASK_SCOPE_SPEC_ID,
} from "@motebit/protocol";
import type {
  GitObjectFormat,
  RepoChangeBundle,
  RepoChangeEntry,
  RepoChangeExecutionReceipt,
  RepoChangeResult,
  RepoChangeToolInvocationReceipt,
  RepoTaskScope,
} from "@motebit/protocol";

import { assembleJsonSchemaFor, toDraft7 } from "./assemble.js";
import { DelegationTokenSchema } from "./delegation-token.js";
import { StandingDelegationSchema } from "./standing-delegation.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const REPO_TASK_SCOPE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/repo-task-scope-v1.json";

export const REPO_CHANGE_RESULT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/repo-change-v1.json";

export const REPO_CHANGE_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/repo-change-bundle-v1.json";

// ---------------------------------------------------------------------------
// Leaf rules
// ---------------------------------------------------------------------------

/**
 * A canonical repository path: segments of `[A-Za-z0-9._-]+` (ASCII only),
 * joined by `/`, with no empty, `.`, `..` or `.git` (any case) segment and no
 * leading or trailing `/`. One regular expression, so the committed JSON
 * Schema states the same rule the verifier applies.
 */
export const REPO_PATH_PATTERN =
  /^(?!(?:.*\/)?(?:\.|\.\.|\.[gG][iI][tT])(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const repoPath = (what: string) =>
  z
    .string()
    .regex(REPO_PATH_PATTERN, "path MUST be canonical (spec/repo-change-v1.md §4)")
    .describe(what);

const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "MUST be 64 lowercase hex characters")
  .describe("Lowercase hex SHA-256 digest (64 characters).");

const publicKeyHex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "public_key MUST be 64 lowercase hex characters")
  .describe("Ed25519 public key, 64 lowercase hex characters.");

/**
 * An Ed25519 signature in canonical unpadded base64url: 86 characters, the
 * last one of `A`, `Q`, `g`, `w` (its four unused low bits zero), so the
 * bytes have one spelling.
 */
const signatureB64 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{85}[AQgw]$/, "signature MUST be canonical unpadded base64url")
  .describe(
    "Ed25519 signature, canonical unpadded base64url: 86 characters ending in A, Q, g or w.",
  );

const objectId = (what: string) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "object id MUST be lowercase hex")
    .describe(
      `${what} Lowercase hex; its length is fixed by the scope's object_format (40 for sha1, 64 for sha256).`,
    );

const DigestRefSchema = z
  .object({
    algorithm: z.literal("sha-256").describe("Hash algorithm (a DigestAlgorithm)."),
    value: sha256Hex,
  })
  .strict()
  .describe("A content digest: algorithm plus lowercase hex value.");

const ObjectFormatSchema = z
  // Cast preserves the literal GitObjectFormat union in z.infer.
  .enum(ALL_GIT_OBJECT_FORMATS as unknown as [GitObjectFormat, ...GitObjectFormat[]])
  .describe("Git object format of the repository; fixes the length of every object id.");

// ---------------------------------------------------------------------------
// RepoTaskScope
// ---------------------------------------------------------------------------

export const RepoTaskScopeSchema = z
  .object({
    schema: z
      .literal(REPO_TASK_SCOPE_SCHEMA)
      .describe(
        "Type tag read by verifySubjectBinding; equals the grant's subject_binding.artifact_schema.",
      ),
    spec: z.literal(REPO_TASK_SCOPE_SPEC_ID).describe("Spec tag of this artifact."),
    repo: z
      .string()
      .min(1)
      .describe(
        "The repository the change lands in; compared byte-exact with the verifier's expected repository.",
      ),
    base_ref: z.literal(REPO_TASK_BASE_REF).describe("The protected branch the change lands on."),
    object_format: ObjectFormatSchema,
    allowed_paths: z
      .array(
        repoPath("A path the change may add or modify, compared byte-exact with git's path bytes."),
      )
      .min(1)
      .describe("Paths the change may add or modify. Unique."),
    max_changed_files: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .describe("The most entries one change may have."),
    task: z
      .string()
      .min(1)
      .describe(
        "The task text the run starts from; the receipt's prompt_hash is hex SHA-256 of its UTF-8 bytes.",
      ),
  })
  .strict()
  .describe(
    "The principal's detached scope for one repository task, bound into a StandingDelegation by subject_binding.",
  );

// ---------------------------------------------------------------------------
// RepoChangeEntry + RepoChangeResult
// ---------------------------------------------------------------------------

export const RepoChangeEntrySchema = z
  .object({
    path: repoPath("Repository-relative path the change adds or modifies."),
    mode: z
      .string()
      .regex(/^[0-7]{6}$/, "mode MUST be six octal digits")
      .describe("Git file mode as six octal digits (100644 is the only mode a scope authorizes)."),
    blob: objectId("Blob object id the path holds after the change."),
  })
  .strict()
  .describe("One path the change adds or modifies.");

export const RepoChangeResultSchema = z
  .object({
    spec: z.literal(REPO_CHANGE_SPEC_ID).describe("Spec tag of the change record."),
    grant_id: z.string().min(1).describe("The grant the run acted under."),
    grant_digest: DigestRefSchema.describe(
      "SHA-256 of the canonical JSON of the whole signed grant, signature included.",
    ),
    tick_digest: DigestRefSchema.describe(
      "SHA-256 of the canonical JSON of the whole signed tick, signature included.",
    ),
    scope_digest: DigestRefSchema.describe(
      "SHA-256 of the canonical JSON of the scope; equals the grant's subject_binding.digest.",
    ),
    repo: z.string().min(1).describe("The scope's repo."),
    object_format: ObjectFormatSchema,
    parent_commit: objectId("The commit the change commit sits on."),
    head_commit: objectId("The change commit."),
    entries: z
      .array(RepoChangeEntrySchema)
      .describe("Every path the change adds or modifies, sorted by path bytes, unique."),
    tool_receipt_digests: z
      .array(DigestRefSchema)
      .max(REPO_CHANGE_MAX_TOOL_RECEIPTS)
      .describe("SHA-256 of the canonical JSON of each signed tool receipt in the bundle. Unique."),
    system_prompt_digest: DigestRefSchema.describe(
      "SHA-256 of the UTF-8 bytes of the system prompt the run used.",
    ),
    provider: z.string().min(1).describe("The inference provider the run used (informational)."),
    model: z.string().min(1).describe("The model the run used (informational)."),
    runtime_version: z
      .string()
      .min(1)
      .describe("The runtime version that ran the task (informational)."),
  })
  .strict()
  .describe(
    "The change record: the canonical-JSON result of the agent's ExecutionReceipt, for every receipt status.",
  );

// ---------------------------------------------------------------------------
// Receipt profiles + RepoChangeBundle
// ---------------------------------------------------------------------------

const MotebitIdSchema = z.string().min(1).describe("Motebit identity.");
const DeviceIdSchema = z.string().min(1).describe("Signing device identity.");
const StatusSchema = z
  .enum(["completed", "failed", "denied"])
  .describe("Terminal state (execution-ledger-v1 §11.1).");
const IntentOriginSchema = z
  .enum(["user-tap", "ai-loop", "scheduled", "agent-to-agent"])
  .describe("How the act was authorized for invocation. Signature-bound.");
const SuiteSchema = z
  .literal("motebit-jcs-ed25519-b64-v1")
  .describe("Cryptosuite: JCS, Ed25519, base64url signature, hex public key.");

/** The repo-change profile of a ToolInvocationReceipt: `public_key` required. */
export const RepoChangeToolInvocationReceiptSchema = z
  .object({
    invocation_id: z.string().min(1).describe("Per-call identifier."),
    task_id: z.string().min(1).describe("The run's task_id; equals the ExecutionReceipt's."),
    motebit_id: MotebitIdSchema,
    public_key: publicKeyHex,
    device_id: DeviceIdSchema,
    tool_name: z.string().min(1).describe("The tool the call named."),
    started_at: z.number().describe("Unix ms the call started."),
    completed_at: z.number().describe("Unix ms the call finished."),
    status: StatusSchema,
    args_hash: sha256Hex,
    result_hash: sha256Hex,
    invocation_origin: IntentOriginSchema.optional(),
    suite: SuiteSchema,
    signature: signatureB64,
  })
  .strict()
  .describe("A signed record of one tool call, in the repo-change profile.");

/** The repo-change profile of an ExecutionReceipt. */
export const RepoChangeExecutionReceiptSchema = z
  .object({
    task_id: z.string().min(1).describe("The run's fresh task id."),
    motebit_id: MotebitIdSchema,
    public_key: publicKeyHex,
    device_id: DeviceIdSchema,
    submitted_at: z.number().describe("Unix ms the run started."),
    completed_at: z.number().describe("Unix ms the run ended."),
    status: StatusSchema,
    result: z
      .string()
      .describe("The change record (RepoChangeResult) as canonical JSON, for every status."),
    tools_used: z.array(z.string()).describe("Names of the tools the run used."),
    memories_formed: z
      .number()
      .int()
      .nonnegative()
      .describe("Memories formed; a verifier requires 0."),
    prompt_hash: sha256Hex.describe("Hex SHA-256 of the UTF-8 bytes of the scope's task."),
    result_hash: sha256Hex.describe("Hex SHA-256 of the UTF-8 bytes of result."),
    delegated_scope: z
      .string()
      .optional()
      .describe("The tick's scope. A verifier requires it, within the tick's scope."),
    invocation_origin: IntentOriginSchema.optional(),
    suite: SuiteSchema,
    signature: signatureB64,
  })
  .strict()
  .describe("The agent's signed outcome, in the repo-change profile.");

export const RepoChangeBundleSchema = z
  .object({
    spec: z.literal(REPO_CHANGE_BUNDLE_SPEC_ID).describe("Spec tag of the bundle."),
    scope: RepoTaskScopeSchema,
    grant: StandingDelegationSchema.extend({ signature: signatureB64 }).describe(
      "The principal's StandingDelegation to the agent.",
    ),
    tick: DelegationTokenSchema.extend({ signature: signatureB64 }).describe(
      "The principal's per-tick DelegationToken under the grant.",
    ),
    tool_receipts: z
      .array(RepoChangeToolInvocationReceiptSchema)
      .max(REPO_CHANGE_MAX_TOOL_RECEIPTS)
      .describe("Every tool receipt of the run."),
    receipt: RepoChangeExecutionReceiptSchema,
  })
  .strict()
  .describe(
    "The evidence bundle of one governed repo change. Its bytes MUST be exactly its canonical JSON (RFC 8785).",
  );

// ---------------------------------------------------------------------------
// Type parity
// ---------------------------------------------------------------------------

type InferredScope = z.infer<typeof RepoTaskScopeSchema>;
type InferredEntry = z.infer<typeof RepoChangeEntrySchema>;
type InferredResult = z.infer<typeof RepoChangeResultSchema>;
type InferredToolReceipt = z.infer<typeof RepoChangeToolInvocationReceiptSchema>;
type InferredReceipt = z.infer<typeof RepoChangeExecutionReceiptSchema>;
type InferredBundle = z.infer<typeof RepoChangeBundleSchema>;

export const _REPO_CHANGE_TYPE_PARITY: {
  scopeForward: ParityForward<RepoTaskScope, InferredScope>;
  scopeReverse: ParityReverse<RepoTaskScope, InferredScope>;
  entryForward: ParityForward<RepoChangeEntry, InferredEntry>;
  entryReverse: ParityReverse<RepoChangeEntry, InferredEntry>;
  resultForward: ParityForward<RepoChangeResult, InferredResult>;
  resultReverse: ParityReverse<RepoChangeResult, InferredResult>;
  toolReceiptForward: ParityForward<RepoChangeToolInvocationReceipt, InferredToolReceipt>;
  toolReceiptReverse: ParityReverse<RepoChangeToolInvocationReceipt, InferredToolReceipt>;
  receiptForward: ParityForward<RepoChangeExecutionReceipt, InferredReceipt>;
  receiptReverse: ParityReverse<RepoChangeExecutionReceipt, InferredReceipt>;
  bundleForward: ParityForward<RepoChangeBundle, InferredBundle>;
  bundleReverse: ParityReverse<RepoChangeBundle, InferredBundle>;
} = {
  scopeForward: true,
  scopeReverse: true,
  entryForward: true,
  entryReverse: true,
  resultForward: true,
  resultReverse: true,
  toolReceiptForward: true,
  toolReceiptReverse: true,
  receiptForward: true,
  receiptReverse: true,
  bundleForward: true,
  bundleReverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildRepoTaskScopeJsonSchema(): Record<string, unknown> {
  return assembleJsonSchemaFor(toDraft7(RepoTaskScopeSchema), {
    $id: REPO_TASK_SCOPE_SCHEMA_ID,
    title: "RepoTaskScope (v1)",
    description:
      "The principal's detached scope for one repository task (motebit/repo-task-scope@1.0), bound into a StandingDelegation by subject_binding. Spec: spec/repo-change-v1.md.",
  });
}

export function buildRepoChangeResultJsonSchema(): Record<string, unknown> {
  return assembleJsonSchemaFor(toDraft7(RepoChangeResultSchema), {
    $id: REPO_CHANGE_RESULT_SCHEMA_ID,
    title: "RepoChangeResult (v1)",
    description:
      "The change record (motebit/repo-change@1.0): the canonical-JSON result of the agent's ExecutionReceipt. Object-id length per object_format and path order are cross-field rules the verifier enforces. Spec: spec/repo-change-v1.md.",
  });
}

export function buildRepoChangeBundleJsonSchema(): Record<string, unknown> {
  return assembleJsonSchemaFor(toDraft7(RepoChangeBundleSchema), {
    $id: REPO_CHANGE_BUNDLE_SCHEMA_ID,
    title: "RepoChangeBundle (v1)",
    description:
      "The evidence bundle of one governed repo change (motebit/repo-change-bundle@1.0); its bytes are exactly its canonical JSON. Verification law: verifyRepoChange in @motebit/verifier. Spec: spec/repo-change-v1.md.",
  });
}
