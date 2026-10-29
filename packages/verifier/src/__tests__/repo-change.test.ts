/**
 * verifyRepoChange — one positive control plus a negative test per rule of
 * spec/repo-change-v1.md §7 (the axis table and the "change entry outside the
 * scope" list). Each negative asserts the rule's repair code (and, where one
 * code covers several sites, the site's detail), so removing the rule's check
 * turns its test red (the repo-change verifier tamper file, repo root, tamper suites).
 *
 * Fixtures are real: Ed25519 keys, artifacts signed with @motebit/crypto, the
 * bundle serialized as canonical JSON. Each test changes one thing at the
 * stage it belongs to (before or after a signature) so the rule under test is
 * what fires.
 */
import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  canonicalJson,
  canonicalSha256,
  generateKeypair,
  hash,
  signDelegation,
  signDelegationRevocation,
  signExecutionReceipt,
  signStandingDelegation,
  signToolInvocationReceipt,
  subjectBindingDigest,
  type KeyPair,
} from "@motebit/crypto";
import type { DelegationRevocation, DelegationToken, StandingDelegation } from "@motebit/crypto";
import type {
  RepoChangeBundle,
  RepoChangeExecutionReceipt,
  RepoChangeResult,
  RepoChangeToolInvocationReceipt,
  RepoTaskScope,
} from "@motebit/protocol";

import {
  ALL_REPO_CHANGE_REPAIR_CODES,
  isFullyVerified,
  verifyRepoChange,
  type RepoChangeComputedEntry,
  type RepoChangeVerification,
  type VerifyRepoChangeInput,
} from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;
const DAY = 24 * HOUR;
const GRANT_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_GRANT_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const REPO = "motebit/motebit";
const PARENT = "1".repeat(40);
const HEAD = "2".repeat(40);
const BLOB = "ab".repeat(20);
const TASK_ID = "task-0001";
const BOTH = "repo_read_blob,repo_write_path";
const enc = new TextEncoder();

const F_ID = "motebit-principal-f";
const A_ID = "motebit-agent-a";

let keys: { f: KeyPair; a: KeyPair; x: KeyPair } | null = null;
async function getKeys(): Promise<{ f: KeyPair; a: KeyPair; x: KeyPair }> {
  if (!keys)
    keys = { f: await generateKeypair(), a: await generateKeypair(), x: await generateKeypair() };
  return keys;
}
const hex = (k: KeyPair): string => bytesToHex(k.publicKey);

/** Re-spell a canonical base64url Ed25519 signature: same bytes, another spelling. */
function respell(sig: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = sig[sig.length - 1]!;
  return sig.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]!;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Body<T> = Mutable<Omit<T, "signature" | "suite">>;

interface Opts {
  scope?: (s: Mutable<RepoTaskScope> & { allowed_paths: string[] }) => void;
  scopeAfterBinding?: (s: Mutable<RepoTaskScope>) => void;
  grant?: (g: Body<StandingDelegation>) => void;
  grantSigner?: (k: { f: KeyPair; a: KeyPair; x: KeyPair }) => KeyPair;
  grantSigned?: (g: Mutable<StandingDelegation>) => void;
  tick?: (t: Body<DelegationToken>) => void;
  tickSigner?: (k: { f: KeyPair; a: KeyPair; x: KeyPair }) => KeyPair;
  tickSigned?: (t: Mutable<DelegationToken>) => void;
  tools?: (t: Body<RepoChangeToolInvocationReceipt>[]) => void;
  toolSigner?: (k: { f: KeyPair; a: KeyPair; x: KeyPair }) => KeyPair;
  toolsSigned?: (t: Mutable<RepoChangeToolInvocationReceipt>[]) => void;
  record?: (
    r: Mutable<RepoChangeResult> & { entries: Mutable<RepoChangeResult["entries"][number]>[] },
  ) => void;
  resultText?: (canonical: string) => string;
  receipt?: (r: Body<RepoChangeExecutionReceipt>) => void;
  receiptSigner?: (k: { f: KeyPair; a: KeyPair; x: KeyPair }) => KeyPair;
  receiptSigned?: (r: Mutable<RepoChangeExecutionReceipt>) => void;
  bundle?: (b: Record<string, unknown>) => void;
  bytes?: (b: unknown) => Uint8Array;
  input?: (
    i: Mutable<VerifyRepoChangeInput>,
    k: { f: KeyPair; a: KeyPair; x: KeyPair },
  ) => void | Promise<void>;
}

const sha = (value: string) => ({ algorithm: "sha-256" as const, value });

async function makeCase(
  opts: Opts = {},
): Promise<{ input: VerifyRepoChangeInput; bundle: RepoChangeBundle }> {
  const k = await getKeys();

  const scope = {
    schema: "motebit.repo-task-scope.v1" as const,
    spec: "motebit/repo-task-scope@1.0" as const,
    repo: REPO,
    base_ref: "main" as const,
    object_format: "sha1" as const,
    allowed_paths: ["docs/a.md"],
    max_changed_files: 1,
    task: "Fix the typo in docs/a.md.",
  } as Mutable<RepoTaskScope> & { allowed_paths: string[] };
  opts.scope?.(scope);
  const binding = {
    schema: "motebit.subject-binding.v1" as const,
    artifact_schema: "motebit.repo-task-scope.v1",
    digest_method: "jcs-sha256-hex" as const,
    digest: await subjectBindingDigest(scope),
  };
  opts.scopeAfterBinding?.(scope);

  const grantBody: Body<StandingDelegation> = {
    grant_id: GRANT_ID,
    delegator_id: F_ID,
    delegator_public_key: hex(k.f),
    delegate_id: A_ID,
    delegate_public_key: hex(k.a),
    scope: BOTH,
    subject: "repo-change",
    subject_binding: binding,
    cadence_ms: 24 * HOUR,
    issued_at: T0,
    not_before: null,
    expires_at: T0 + 24 * HOUR,
    max_token_ttl_ms: HOUR,
  };
  opts.grant?.(grantBody);
  const grant: Mutable<StandingDelegation> = {
    ...(await signStandingDelegation(grantBody, (opts.grantSigner?.(k) ?? k.f).privateKey)),
  };
  opts.grantSigned?.(grant);

  const tickBody: Body<DelegationToken> = {
    delegator_id: grantBody.delegator_id,
    delegator_public_key: grantBody.delegator_public_key,
    delegate_id: grantBody.delegate_id,
    delegate_public_key: grantBody.delegate_public_key,
    scope: BOTH,
    issued_at: T0,
    expires_at: T0 + HOUR,
    grant_id: GRANT_ID,
  };
  opts.tick?.(tickBody);
  const tick: Mutable<DelegationToken> = {
    ...(await signDelegation(tickBody, (opts.tickSigner?.(k) ?? k.f).privateKey)),
  };
  opts.tickSigned?.(tick);

  const toolSigner = opts.toolSigner?.(k) ?? k.a;
  const toolBodies: Body<RepoChangeToolInvocationReceipt>[] = [
    {
      invocation_id: "inv-1",
      task_id: TASK_ID,
      motebit_id: A_ID,
      public_key: hex(toolSigner),
      device_id: "dev-a",
      tool_name: "repo_read_blob",
      started_at: T0 + MIN,
      completed_at: T0 + MIN,
      status: "completed",
      args_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
    },
    {
      invocation_id: "inv-2",
      task_id: TASK_ID,
      motebit_id: A_ID,
      public_key: hex(toolSigner),
      device_id: "dev-a",
      tool_name: "repo_write_path",
      started_at: T0 + 2 * MIN,
      completed_at: T0 + 2 * MIN,
      status: "completed",
      args_hash: "c".repeat(64),
      result_hash: "d".repeat(64),
    },
  ];
  opts.tools?.(toolBodies);
  const toolReceipts: Mutable<RepoChangeToolInvocationReceipt>[] = [];
  for (const b of toolBodies) {
    toolReceipts.push({ ...(await signToolInvocationReceipt(b, toolSigner.privateKey)) });
  }
  opts.toolsSigned?.(toolReceipts);

  const record = {
    spec: "motebit/repo-change@1.0" as const,
    grant_id: grant.grant_id,
    grant_digest: sha(await canonicalSha256(grant)),
    tick_digest: sha(await canonicalSha256(tick)),
    scope_digest: sha(await canonicalSha256(scope)),
    repo: scope.repo,
    object_format: scope.object_format,
    parent_commit: PARENT,
    head_commit: HEAD,
    entries: [{ path: "docs/a.md", mode: "100644", blob: BLOB }],
    tool_receipt_digests: await Promise.all(
      toolReceipts.map(async (t) => sha(await canonicalSha256(t))),
    ),
    system_prompt_digest: sha("e".repeat(64)),
    provider: "anthropic",
    model: "model-1",
    runtime_version: "1.0.0",
  } as Mutable<RepoChangeResult> & { entries: Mutable<RepoChangeResult["entries"][number]>[] };
  opts.record?.(record);
  const canonicalRecord = canonicalJson(record);
  const result = opts.resultText ? opts.resultText(canonicalRecord) : canonicalRecord;

  const receiptSigner = opts.receiptSigner?.(k) ?? k.a;
  const receiptBody: Body<RepoChangeExecutionReceipt> = {
    task_id: TASK_ID,
    motebit_id: A_ID,
    public_key: hex(receiptSigner),
    device_id: "dev-a",
    submitted_at: T0,
    completed_at: T0 + 3 * MIN,
    status: "completed",
    result,
    tools_used: ["repo_read_blob", "repo_write_path"],
    memories_formed: 0,
    prompt_hash: await hash(enc.encode(scope.task)),
    result_hash: await hash(enc.encode(result)),
    delegated_scope: BOTH,
  };
  opts.receipt?.(receiptBody);
  const receipt: Mutable<RepoChangeExecutionReceipt> = {
    ...(await signExecutionReceipt(receiptBody, receiptSigner.privateKey)),
  };
  opts.receiptSigned?.(receipt);

  const bundleObj: Record<string, unknown> = {
    spec: "motebit/repo-change-bundle@1.0",
    scope,
    grant,
    tick,
    tool_receipts: toolReceipts,
    receipt,
  };
  opts.bundle?.(bundleObj);
  const bytes = opts.bytes ? opts.bytes(bundleObj) : enc.encode(canonicalJson(bundleObj));

  const entries: RepoChangeComputedEntry[] = [
    {
      kind: "modify",
      path: enc.encode("docs/a.md"),
      mode: "100644",
      previousMode: "100644",
      blob: BLOB,
      containsNul: false,
    },
  ];
  const input: Mutable<VerifyRepoChangeInput> = {
    bundle: bytes,
    entries,
    trackedPaths: ["README.md", "docs/a.md", "packages/x/src/y.ts"].map((p) => enc.encode(p)),
    pins: {
      principal: { motebit_id: F_ID, public_key: hex(k.f) },
      agents: [{ motebit_id: A_ID, public_key: hex(k.a) }],
    },
    isPathPermitted: (p) => !p.startsWith(".motebit/") && !p.startsWith(".ci/"),
    revocations: {
      set: [],
      failures: [],
      freshness: { basis: "asserted", asOf: { timestamp_ms: T0 } },
      readAt: "c".repeat(40),
    },
    spent: false,
    expectedRepo: REPO,
    mode: { kind: "pull_request", shapeFailures: [], now: T0 + 10 * MIN },
  };
  await opts.input?.(input, k);
  return { input, bundle: bundleObj as unknown as RepoChangeBundle };
}

async function run(opts: Opts = {}): Promise<RepoChangeVerification> {
  const { input } = await makeCase(opts);
  return verifyRepoChange(input);
}

function codes(r: RepoChangeVerification): string[] {
  return r.diagnostics.failures.map((f) => f.code);
}

/** The rule fired: its code is present (with `detail` containing `site`, when given). */
function expectRule(r: RepoChangeVerification, code: string, site?: string): void {
  const hit = r.diagnostics.failures.some(
    (f) => f.code === code && (site === undefined || f.detail.includes(site)),
  );
  expect(
    hit,
    `${code}${site ? ` (${site})` : ""} in ${JSON.stringify(r.diagnostics.failures)}`,
  ).toBe(true);
  expect(isFullyVerified(r.verdict)).toBe(false);
}

const ALT = "f".repeat(64);

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

describe("verifyRepoChange positive controls", () => {
  it("a well-formed governed change is fully verified, pinned, with outcome completed", async () => {
    const r = await run();
    expect(r.diagnostics.failures).toEqual([]);
    expect(r.verdict.type).toBe("repo_change");
    expect(r.verdict.integrity).toBe("verified");
    expect(r.verdict.identityBinding).toBe("pinned");
    expect(r.verdict.authority).toBe("valid");
    expect(r.verdict.revocation.status).toBe("fresh");
    expect(r.verdict.temporalBasis).toBe("local_clock");
    expect(r.verdict.repair).toBeUndefined();
    expect(isFullyVerified(r.verdict)).toBe(true);
    expect(r.outcome).toBe("completed");
    expect(r.diagnostics.revocationsReadAt).toBe("c".repeat(40));
  });

  it("a truthful denied run keeps valid authority: a denied receipt may name any tool", async () => {
    const r = await run({
      tools: (t) => {
        t.push({ ...t[0]!, invocation_id: "inv-3", tool_name: "write_file", status: "denied" });
      },
      receipt: (b) => {
        b.status = "denied";
      },
    });
    expect(r.diagnostics.failures).toEqual([]);
    expect(isFullyVerified(r.verdict)).toBe(true);
    expect(r.outcome).toBe("denied");
  });

  it("a landed change is judged at an operator-recorded time", async () => {
    const r = await run({
      input: (i) => {
        i.mode = { kind: "landed", shapeFailures: [], landedAt: T0 + 20 * MIN };
      },
    });
    expect(r.diagnostics.failures).toEqual([]);
    expect(r.verdict.temporalBasis).toBe("operator_recorded");
    expect(isFullyVerified(r.verdict)).toBe(true);
  });

  it("a sha256 repository takes 64-hex commit and blob ids", async () => {
    const blob = "cd".repeat(32);
    const r = await run({
      scope: (s) => {
        s.object_format = "sha256";
      },
      record: (rec) => {
        rec.parent_commit = "1".repeat(64);
        rec.head_commit = "2".repeat(64);
        rec.entries = [{ path: "docs/a.md", mode: "100644", blob }];
      },
      input: (i) => {
        i.entries = [{ ...i.entries[0]!, blob }];
      },
    });
    expect(r.diagnostics.failures).toEqual([]);
  });

  it("an add of an allowed path that is not tracked yet verifies", async () => {
    const r = await run({
      input: (i) => {
        i.entries = [{ ...i.entries[0]!, kind: "add", previousMode: undefined }];
        i.trackedPaths = [enc.encode("README.md")];
      },
    });
    expect(r.diagnostics.failures).toEqual([]);
  });

  it("a revocation of the grant under another key does not revoke it (per-grant authority)", async () => {
    const r = await run({
      input: async (i, k) => {
        const rev = await signDelegationRevocation(
          {
            grant_id: GRANT_ID,
            delegator_id: F_ID,
            delegator_public_key: hex(k.x),
            revoked_at: T0,
          },
          k.x.privateKey,
        );
        i.revocations = { ...i.revocations!, set: [rev] };
      },
    });
    expect(r.diagnostics.failures).toEqual([]);
    expect(r.verdict.revocation.status).toBe("fresh");
  });

  it("every repair code a verdict can carry is a repo-change code on the axis its prefix names", async () => {
    const r = await run({
      input: (i) => {
        i.spent = true;
        i.revocations = undefined;
        i.mode = {
          kind: "pull_request",
          shapeFailures: ["base ref is not main"],
          now: T0 + 10 * MIN,
        };
      },
    });
    for (const f of r.diagnostics.failures) {
      expect(ALL_REPO_CHANGE_REPAIR_CODES).toContain(f.code);
    }
    expect(r.verdict.repair?.code).toBe("integrity.repo_change.shape_check_failed");
    expect(r.verdict.repair?.axis).toBe("integrity");
    expect(r.verdict.repair?.canonical).toBe("spec/repo-change-v1.md");
  });
});

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

describe("verifyRepoChange integrity", () => {
  it("bundle bytes that are not UTF-8 are malformed and leave outcome null", async () => {
    const r = await run({ bytes: () => new Uint8Array([0xff, 0xfe, 0x7b]) });
    expectRule(r, "integrity.repo_change.bundle_malformed");
    expect(r.outcome).toBeNull();
    expect(r.verdict.integrity).toBe("invalid");
    expect(r.verdict.authority).toBe("unknown");
    expect(r.verdict.identityBinding).toBe("unverified");
    expect(r.verdict.revocation.status).toBe("unchecked");
  });

  it("bundle bytes with an invalid UTF-8 byte inside a string are malformed", async () => {
    const r = await run({
      bytes: (b) => {
        const bytes = enc.encode(canonicalJson(b));
        const at = new TextDecoder().decode(bytes).indexOf("Fix the typo");
        bytes[at] = 0xff;
        return bytes;
      },
    });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("a byte-order mark before the bundle is malformed", async () => {
    const r = await run({
      bytes: (b) => new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(canonicalJson(b))]),
    });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("a tick without grant_id is malformed", async () => {
    const r = await run({ tickSigned: (t) => void delete t.grant_id });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("a bundle with a key the spec does not name is malformed", async () => {
    const r = await run({
      bundle: (b) => {
        b.note = "x";
      },
    });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("a receipt carrying a field outside the repo-change profile is malformed", async () => {
    const r = await run({
      receipt: (b) => {
        (b as Record<string, unknown>).relay_task_id = "relay-1";
      },
    });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("bundle bytes that are not the canonical JSON are rejected", async () => {
    const r = await run({ bytes: (b) => enc.encode(JSON.stringify(b, null, 2)) });
    expectRule(r, "integrity.repo_change.bundle_not_canonical");
  });

  for (const [site, mutate] of [
    [
      "grant.delegator_public_key",
      (o: Opts) =>
        (o.grantSigned = (g) =>
          void (g.delegator_public_key = g.delegator_public_key.toUpperCase())),
    ],
    [
      "grant.delegate_public_key",
      (o: Opts) =>
        (o.grantSigned = (g) => void (g.delegate_public_key = g.delegate_public_key.toUpperCase())),
    ],
    [
      "tick.delegator_public_key",
      (o: Opts) =>
        (o.tickSigned = (t) =>
          void (t.delegator_public_key = t.delegator_public_key.toUpperCase())),
    ],
    [
      "tick.delegate_public_key",
      (o: Opts) =>
        (o.tickSigned = (t) => void (t.delegate_public_key = t.delegate_public_key.toUpperCase())),
    ],
    [
      "receipt.public_key",
      (o: Opts) => (o.receipt = (b) => void (b.public_key = b.public_key.toUpperCase())),
    ],
  ] as const) {
    it(`a non-canonical key is rejected: ${site}`, async () => {
      const o: Opts = {};
      mutate(o);
      const r = await run(o);
      expectRule(r, "integrity.repo_change.value_not_canonical", site);
    });
  }

  it("B5a: a tick signature re-spelled in non-canonical base64url, with the record re-signed over it, fails on canonicality alone", async () => {
    const r = await run({ tickSigned: (t) => void (t.signature = respell(t.signature)) });
    const integrity = r.diagnostics.failures.filter((f) => f.axis === "integrity");
    expect(integrity.map((f) => f.code)).toEqual(["integrity.repo_change.value_not_canonical"]);
    expectRule(r, "integrity.repo_change.value_not_canonical", "tick.signature");
    expect(r.verdict.integrity).toBe("invalid");
  });

  it("a non-canonical grant signature is rejected", async () => {
    const r = await run({ grantSigned: (g) => void (g.signature = respell(g.signature)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "grant.signature");
  });

  it("a non-canonical receipt signature is rejected", async () => {
    const r = await run({ receiptSigned: (x) => void (x.signature = respell(x.signature)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "receipt.signature");
  });

  it("a grant_id that is not a lowercase UUID is rejected", async () => {
    const r = await run({ grant: (g) => void (g.grant_id = GRANT_ID.toUpperCase()) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "grant.grant_id");
  });

  it("a non-canonical subject_binding digest is rejected", async () => {
    const r = await run({
      grant: (g) =>
        void (g.subject_binding = {
          ...g.subject_binding!,
          digest: g.subject_binding!.digest.toUpperCase(),
        }),
    });
    expectRule(r, "integrity.repo_change.value_not_canonical", "grant.subject_binding.digest");
  });

  it("a non-canonical prompt_hash is rejected", async () => {
    const r = await run({ receipt: (b) => void (b.prompt_hash = b.prompt_hash.toUpperCase()) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "receipt.prompt_hash");
  });

  it("a non-canonical result_hash is rejected", async () => {
    const r = await run({ receipt: (b) => void (b.result_hash = b.result_hash.toUpperCase()) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "receipt.result_hash");
  });

  it("a tool receipt with a non-canonical public_key is rejected", async () => {
    const r = await run({ tools: (t) => void (t[0]!.public_key = t[0]!.public_key.toUpperCase()) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "tool_receipts[0].public_key");
  });

  it("a tool receipt with a non-canonical signature is rejected", async () => {
    const r = await run({ toolsSigned: (t) => void (t[0]!.signature = respell(t[0]!.signature)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "tool_receipts[0].signature");
  });

  it("a tool receipt with a non-canonical args_hash is rejected", async () => {
    const r = await run({ tools: (t) => void (t[0]!.args_hash = "A".repeat(64)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "tool_receipts[0].args_hash");
  });

  it("a tool receipt with a non-canonical result_hash is rejected", async () => {
    const r = await run({ tools: (t) => void (t[0]!.result_hash = "B".repeat(64)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "tool_receipts[0].result_hash");
  });

  for (const bad of [
    "docs/../a.md",
    "docs/Aſ.md",
    ".GIT/config",
    "docs//a.md",
    "/docs/a.md",
    "docs/./a.md",
    "docs/a.",
    ".git./config",
  ]) {
    it(`a non-canonical allowed path is rejected: ${JSON.stringify(bad)}`, async () => {
      const r = await run({ scope: (s) => void s.allowed_paths.push(bad) });
      expectRule(r, "integrity.repo_change.value_not_canonical", "non-canonical path");
    });
  }

  it("a repeated allowed path is rejected", async () => {
    const r = await run({ scope: (s) => void s.allowed_paths.push("docs/a.md") });
    expectRule(r, "integrity.repo_change.value_not_canonical", "repeats");
  });

  it("a non-canonical record digest is rejected", async () => {
    const r = await run({ record: (x) => void (x.system_prompt_digest = sha("E".repeat(64))) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.system_prompt_digest");
  });

  it("a non-canonical recorded tool receipt digest is rejected", async () => {
    const r = await run({
      record: (x) =>
        void (x.tool_receipt_digests = [
          sha(x.tool_receipt_digests[0]!.value.toUpperCase()),
          x.tool_receipt_digests[1]!,
        ]),
    });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.tool_receipt_digests[0]");
  });

  it("a parent_commit of the wrong length for the object format is rejected", async () => {
    const r = await run({ record: (x) => void (x.parent_commit = "1".repeat(64)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.parent_commit");
  });

  it("an uppercase head_commit is rejected", async () => {
    const r = await run({ record: (x) => void (x.head_commit = "A".repeat(40)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.head_commit");
  });

  it("a recorded entry with a non-canonical path is rejected", async () => {
    const r = await run({ record: (x) => void (x.entries[0]!.path = "docs/./a.md") });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.entries[0].path");
  });

  it("a recorded entry with a mode that is not six octal digits is rejected", async () => {
    const r = await run({ record: (x) => void (x.entries[0]!.mode = "644") });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.entries[0].mode");
  });

  it("a recorded entry with a blob of the wrong length is rejected", async () => {
    const r = await run({ record: (x) => void (x.entries[0]!.blob = "ab".repeat(32)) });
    expectRule(r, "integrity.repo_change.value_not_canonical", "record.entries[0].blob");
  });

  it("recorded entries that are not sorted by path are rejected", async () => {
    const r = await run({
      scope: (s) => {
        s.allowed_paths.push("docs/b.md");
        s.max_changed_files = 2;
      },
      record: (x) =>
        void (x.entries = [
          { path: "docs/b.md", mode: "100644", blob: BLOB },
          { path: "docs/a.md", mode: "100644", blob: BLOB },
        ]),
    });
    expectRule(r, "integrity.repo_change.value_not_canonical", "not sorted");
  });

  it("a grant whose signature does not verify is rejected", async () => {
    const r = await run({ grantSigned: (g) => void (g.max_token_ttl_ms = 2 * HOUR) });
    expectRule(r, "integrity.repo_change.signature_invalid", "grant's signature");
  });

  it("a tick whose signature does not verify is rejected", async () => {
    const r = await run({ tickSigned: (t) => void (t.issued_at = t.issued_at + 1) });
    expectRule(r, "integrity.repo_change.signature_invalid", "tick's signature");
  });

  it("an execution receipt whose signature does not verify is rejected", async () => {
    const r = await run({ receiptSigned: (x) => void (x.device_id = "dev-other") });
    expectRule(r, "integrity.repo_change.signature_invalid", "execution receipt's signature");
  });

  it("a tool receipt whose signature does not verify is rejected", async () => {
    const r = await run({ toolsSigned: (t) => void (t[0]!.device_id = "dev-other") });
    expectRule(r, "integrity.repo_change.signature_invalid", "tool_receipts[0]'s signature");
  });

  it("a result_hash that does not bind the result is rejected", async () => {
    const r = await run({ receipt: (b) => void (b.result_hash = ALT) });
    expectRule(r, "integrity.repo_change.result_hash_mismatch");
  });

  it("a record with a key the spec does not name is malformed", async () => {
    const r = await run({ record: (x) => void ((x as Record<string, unknown>).note = "x") });
    expectRule(r, "integrity.repo_change.result_malformed");
  });

  it("with no parseable record, the recorded entries cannot match the computed ones", async () => {
    const r = await run({ resultText: () => "not json" });
    expectRule(r, "authority.repo_change.entries_mismatch");
  });

  it("a result that is not the change-record shape is rejected", async () => {
    const r = await run({ resultText: () => "not json" });
    expectRule(r, "integrity.repo_change.result_malformed");
  });

  it("a result that is not the record's canonical JSON is rejected", async () => {
    const r = await run({ resultText: (c) => JSON.stringify(JSON.parse(c), null, 1) });
    expectRule(r, "integrity.repo_change.result_not_canonical");
  });

  it("a scope that does not match the grant's subject_binding is rejected", async () => {
    const r = await run({ scopeAfterBinding: (s) => void (s.task = "Do something else.") });
    expectRule(r, "integrity.repo_change.scope_binding_mismatch");
  });

  it("a record naming another grant is rejected", async () => {
    const r = await run({ record: (x) => void (x.grant_id = OTHER_GRANT_ID) });
    expectRule(r, "integrity.repo_change.grant_id_mismatch");
  });

  it("a record whose grant_digest is not the bundle grant's is rejected", async () => {
    const r = await run({ record: (x) => void (x.grant_digest = sha(ALT)) });
    expectRule(r, "integrity.repo_change.grant_digest_mismatch");
  });

  it("a record whose tick_digest is not the bundle tick's is rejected", async () => {
    const r = await run({ record: (x) => void (x.tick_digest = sha(ALT)) });
    expectRule(r, "integrity.repo_change.tick_digest_mismatch");
  });

  it("a record whose scope_digest is not the bundle scope's is rejected", async () => {
    const r = await run({ record: (x) => void (x.scope_digest = sha(ALT)) });
    expectRule(r, "integrity.repo_change.scope_digest_mismatch");
  });

  it("a record whose repo differs from the scope's is rejected", async () => {
    const r = await run({ record: (x) => void (x.repo = "other/repo") });
    expectRule(r, "integrity.repo_change.scope_reference_mismatch");
  });

  it("a record whose object_format differs from the scope's is rejected", async () => {
    const r = await run({ record: (x) => void (x.object_format = "sha256") });
    expectRule(r, "integrity.repo_change.scope_reference_mismatch");
  });

  it("a prompt_hash that is not the digest of the scope's task is rejected", async () => {
    const r = await run({ receipt: (b) => void (b.prompt_hash = ALT) });
    expectRule(r, "integrity.repo_change.prompt_hash_mismatch");
  });

  it("a record that omits a bundled tool receipt's digest is rejected", async () => {
    const r = await run({
      record: (x) => void (x.tool_receipt_digests = [x.tool_receipt_digests[0]!]),
    });
    expectRule(r, "integrity.repo_change.tool_receipts_mismatch");
  });

  it("a record listing a digest beside every bundled one is rejected", async () => {
    const r = await run({
      toolsSigned: (t) => void t.splice(1, 1),
      record: (x) => void (x.tool_receipt_digests = [x.tool_receipt_digests[0]!, sha(ALT)]),
      receipt: (b) => void (b.tools_used = ["repo_read_blob"]),
    });
    expectRule(r, "integrity.repo_change.tool_receipts_mismatch");
  });

  it("a record naming another receipt in place of a bundled one is rejected", async () => {
    const r = await run({
      record: (x) => void (x.tool_receipt_digests = [x.tool_receipt_digests[0]!, sha(ALT)]),
    });
    expectRule(r, "integrity.repo_change.tool_receipts_mismatch");
  });

  it("a bundle carrying one tool receipt twice is rejected", async () => {
    const r = await run({
      toolsSigned: (t) => void t.splice(1, 1, t[0]!),
      record: (x) => void (x.tool_receipt_digests = [x.tool_receipt_digests[0]!]),
      receipt: (b) => void (b.tools_used = ["repo_read_blob"]),
    });
    expectRule(r, "integrity.repo_change.tool_receipts_mismatch");
  });

  it("a record listing one tool receipt digest twice is rejected", async () => {
    const r = await run({
      toolsSigned: (t) => void t.splice(1, 1),
      record: (x) =>
        void (x.tool_receipt_digests = [x.tool_receipt_digests[0]!, x.tool_receipt_digests[0]!]),
      receipt: (b) => void (b.tools_used = ["repo_read_blob"]),
    });
    expectRule(r, "integrity.repo_change.tool_receipts_mismatch");
  });

  it("a tool receipt from another run is rejected", async () => {
    const r = await run({ tools: (t) => void (t[1]!.task_id = "task-other") });
    expectRule(r, "integrity.repo_change.task_id_mismatch");
  });

  it("a failed ancestry or shape check lands on integrity and every other axis is still computed", async () => {
    const r = await run({
      input: (i) => {
        i.mode = {
          kind: "pull_request",
          shapeFailures: ["parent_commit is not the tip of main"],
          now: T0 + 10 * MIN,
        };
        i.spent = true;
      },
    });
    expectRule(
      r,
      "integrity.repo_change.shape_check_failed",
      "parent_commit is not the tip of main",
    );
    expect(r.verdict.authority).toBe("insufficient");
    expect(r.verdict.identityBinding).toBe("pinned");
    expect(r.verdict.revocation.status).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// identityBinding
// ---------------------------------------------------------------------------

describe("verifyRepoChange identityBinding", () => {
  it("no principal pin: the delegator is not the principal", async () => {
    const r = await run({ input: (i) => void (i.pins = { ...i.pins, principal: null }) });
    expectRule(r, "identity.repo_change.delegator_not_principal");
    expect(r.verdict.identityBinding).toBe("invalid");
  });

  it("a principal pin with the same id but another key does not pin the delegator", async () => {
    const r = await run({
      input: (i, k) =>
        void (i.pins = { ...i.pins, principal: { motebit_id: F_ID, public_key: hex(k.x) } }),
    });
    expectRule(r, "identity.repo_change.delegator_not_principal");
  });

  it("a principal pin with the same key but another id does not pin the delegator", async () => {
    const r = await run({
      input: (i, k) =>
        void (i.pins = {
          ...i.pins,
          principal: { motebit_id: "someone-else", public_key: hex(k.f) },
        }),
    });
    expectRule(r, "identity.repo_change.delegator_not_principal");
  });

  it("an agent pin with the same id but another key does not pin the delegate", async () => {
    const r = await run({
      input: (i, k) =>
        void (i.pins = { ...i.pins, agents: [{ motebit_id: A_ID, public_key: hex(k.x) }] }),
    });
    expectRule(r, "identity.repo_change.delegate_not_agent");
  });

  it("an agent pin with the same key but another id does not pin the delegate", async () => {
    const r = await run({
      input: (i, k) =>
        void (i.pins = { ...i.pins, agents: [{ motebit_id: "agent-b", public_key: hex(k.a) }] }),
    });
    expectRule(r, "identity.repo_change.delegate_not_agent");
  });

  it("a grant whose delegate id is the delegator's is rejected", async () => {
    const r = await run({
      grant: (g) => void (g.delegate_id = F_ID),
      tick: (t) => void (t.delegate_id = F_ID),
    });
    expectRule(r, "identity.repo_change.delegator_is_delegate");
  });

  it("a grant whose delegate key is the delegator's is rejected", async () => {
    const r = await run({
      grant: (g) => void (g.delegate_public_key = g.delegator_public_key),
      tick: (t) => void (t.delegate_public_key = t.delegator_public_key),
    });
    expectRule(r, "identity.repo_change.delegator_is_delegate");
  });

  it("B4: an execution receipt signed by a key other than the grant's delegate is rejected", async () => {
    const r = await run({ receiptSigner: (k) => k.x });
    expectRule(r, "identity.repo_change.signer_not_delegate", "execution receipt's signer");
    expect(r.verdict.identityBinding).toBe("invalid");
  });

  it("an execution receipt naming another motebit_id is rejected", async () => {
    const r = await run({ receipt: (b) => void (b.motebit_id = "agent-b") });
    expectRule(r, "identity.repo_change.signer_not_delegate", "execution receipt's signer");
  });

  it("a tool receipt signed by a key other than the grant's delegate is rejected", async () => {
    const r = await run({ toolSigner: (k) => k.x });
    expectRule(r, "identity.repo_change.signer_not_delegate", "tool_receipts[0]'s signer");
  });

  it("a tick naming another delegate is rejected", async () => {
    const r = await run({ tick: (t) => void (t.delegate_id = "agent-b") });
    expectRule(r, "identity.repo_change.signer_not_delegate", "tick's delegate");
  });
});

// ---------------------------------------------------------------------------
// authority
// ---------------------------------------------------------------------------

describe("verifyRepoChange authority", () => {
  it("a tick past its expiry reads expired", async () => {
    const r = await run({
      input: (i) => void (i.mode = { kind: "pull_request", shapeFailures: [], now: T0 + 2 * HOUR }),
    });
    expectRule(r, "authority.repo_change.tick_expired");
    expect(r.verdict.authority).toBe("expired");
  });

  it("a tick before its not_before reads not_yet_valid", async () => {
    const r = await run({ tick: (t) => void (t.not_before = T0 + 30 * MIN) });
    expectRule(r, "authority.repo_change.tick_not_yet_valid");
    expect(r.verdict.authority).toBe("not_yet_valid");
  });

  it("a tick whose TTL exceeds the grant's max_token_ttl_ms is insufficient", async () => {
    const r = await run({ tick: (t) => void (t.expires_at = T0 + 2 * HOUR) });
    expectRule(r, "authority.repo_change.tick_insufficient");
    expect(r.verdict.authority).toBe("insufficient");
  });

  it("a landed change whose time could not be accepted reads unknown", async () => {
    const r = await run({
      input: (i) => void (i.mode = { kind: "landed", shapeFailures: [], landedAt: null }),
    });
    expectRule(r, "authority.repo_change.time_unavailable");
    expect(r.verdict.authority).toBe("unknown");
    expect(r.verdict.temporalBasis).toBe("operator_recorded");
  });

  it("with no acceptable time, a structurally invalid tick still reads insufficient", async () => {
    const r = await run({
      tick: (t) => void (t.expires_at = T0 + 2 * HOUR),
      input: (i) => void (i.mode = { kind: "landed", shapeFailures: [], landedAt: null }),
    });
    expectRule(r, "authority.repo_change.tick_insufficient");
    expect(r.verdict.authority).toBe("insufficient");
  });

  describe("an evaluation time that is not a finite number is no time at all", () => {
    for (const [label, value] of [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ] as const) {
      it(`pull_request now = ${label} reads unknown`, async () => {
        const r = await run({
          input: (i) => void (i.mode = { kind: "pull_request", shapeFailures: [], now: value }),
        });
        expectRule(r, "authority.repo_change.time_unavailable");
        expect(r.verdict.authority).toBe("unknown");
      });
      it(`landed landedAt = ${label} reads unknown`, async () => {
        const r = await run({
          input: (i) => void (i.mode = { kind: "landed", shapeFailures: [], landedAt: value }),
        });
        expectRule(r, "authority.repo_change.time_unavailable");
        expect(r.verdict.authority).toBe("unknown");
      });
    }
    it("a landed mode with no landedAt (a JS caller) reads unknown, never the local clock", async () => {
      const r = await run({
        input: (i) =>
          void (i.mode = { kind: "landed", shapeFailures: [] } as unknown as typeof i.mode),
      });
      expectRule(r, "authority.repo_change.time_unavailable");
      expect(r.verdict.authority).toBe("unknown");
    });
  });

  it("a grant issued in the future reads not_yet_valid at the evaluation time", async () => {
    const r = await run({
      grant: (g) => {
        g.issued_at = T0 + 30 * DAY;
        g.expires_at = T0 + 31 * DAY;
      },
      tick: (t) => {
        t.issued_at = T0 + 30 * DAY;
        t.expires_at = T0 + 30 * DAY + HOUR;
      },
    });
    expectRule(r, "authority.repo_change.grant_not_yet_valid");
    expect(r.verdict.authority).toBe("not_yet_valid");
  });

  it("a tick issued in the future (no not_before) reads not_yet_valid", async () => {
    const r = await run({
      tick: (t) => {
        t.issued_at = T0 + 30 * MIN;
        t.expires_at = T0 + 90 * MIN;
      },
    });
    expectRule(r, "authority.repo_change.tick_not_yet_valid");
    expect(r.verdict.authority).toBe("not_yet_valid");
  });

  it("a tick back-dated before its grant is insufficient", async () => {
    const r = await run({
      grant: (g) => void (g.max_token_ttl_ms = 400 * DAY),
      tick: (t) => {
        t.issued_at = T0 - 365 * DAY;
        t.expires_at = T0 + HOUR;
      },
    });
    expectRule(r, "authority.repo_change.tick_predates_grant");
    expect(r.verdict.authority).toBe("insufficient");
  });

  it("a grant that starts after it expires is insufficient", async () => {
    const r = await run({
      grant: (g) => {
        g.issued_at = T0;
        g.expires_at = T0 - HOUR;
        g.cadence_ms = 0;
      },
    });
    expectRule(r, "authority.repo_change.window_inverted", "grant starts");
  });

  it("a tick that starts after it expires is insufficient", async () => {
    const r = await run({ tick: (t) => void (t.not_before = T0 + 2 * HOUR) });
    expectRule(r, "authority.repo_change.window_inverted", "tick starts");
  });

  it("the grant lifetime counts from its activation (not_before)", async () => {
    const r = await run({
      grant: (g) => {
        g.not_before = T0 + HOUR;
        g.expires_at = T0 + 24 * HOUR;
        g.cadence_ms = 23 * HOUR;
      },
      tick: (t) => {
        t.issued_at = T0 + HOUR;
        t.expires_at = T0 + 2 * HOUR;
      },
      input: (i) => void (i.mode = { kind: "pull_request", shapeFailures: [], now: T0 + 90 * MIN }),
    });
    expect(r.diagnostics.failures).toEqual([]);
    expect(isFullyVerified(r.verdict)).toBe(true);
  });

  it("a grant activated late still may not live more than 24 hours after activation", async () => {
    const r = await run({
      grant: (g) => {
        g.not_before = T0 + HOUR;
        g.expires_at = T0 + 26 * HOUR;
        g.cadence_ms = 26 * HOUR;
      },
    });
    expectRule(r, "authority.repo_change.lifetime_exceeded");
  });

  describe("a structural tick failure outranks a time before the window", () => {
    const breaches: readonly [string, Opts][] = [
      [
        "a TTL over max_token_ttl_ms",
        { tick: (t) => void (t.expires_at = t.issued_at + 2 * HOUR) },
      ],
      ["a grant_id of another grant", { tick: (t) => void (t.grant_id = OTHER_GRANT_ID) }],
      [
        "a delegator other than the grant's",
        { tick: (t) => void (t.delegator_id = "someone-else") },
      ],
      ["a scope wider than the grant's", { grant: (g) => void (g.scope = "repo_read_blob") }],
    ];
    const timings: readonly [string, Opts][] = [
      [
        "before the grant starts",
        {
          input: (i) => void (i.mode = { kind: "pull_request", shapeFailures: [], now: T0 - MIN }),
        },
      ],
      [
        "before the tick starts",
        {
          tick: (t) => {
            t.issued_at = T0 + 30 * MIN;
            t.expires_at = T0 + 90 * MIN;
          },
        },
      ],
    ];
    for (const [breach, b] of breaches) {
      for (const [timing, w] of timings) {
        it(`${breach}, evaluated ${timing}, reads insufficient`, async () => {
          const r = await run({
            ...b,
            ...w,
            tick: (t) => {
              w.tick?.(t);
              b.tick?.(t);
            },
          });
          expectRule(r, "authority.repo_change.tick_insufficient");
          expect(r.verdict.authority).toBe("insufficient");
        });
      }
    }
  });

  it("a time after the grant expired reads the tick as expired", async () => {
    const r = await run({
      grant: (g) => {
        g.expires_at = T0 + 2 * HOUR;
        g.cadence_ms = 2 * HOUR;
        g.max_token_ttl_ms = 3 * HOUR;
      },
      tick: (t) => void (t.expires_at = T0 + 3 * HOUR),
      input: (i) =>
        void (i.mode = { kind: "pull_request", shapeFailures: [], now: T0 + 150 * MIN }),
    });
    expectRule(r, "authority.repo_change.tick_expired");
  });

  it("a tick that outlives its grant is insufficient", async () => {
    const r = await run({
      grant: (g) => {
        g.expires_at = T0 + 2 * HOUR;
        g.cadence_ms = 2 * HOUR;
      },
      tick: (t) => {
        t.issued_at = T0 + 90 * MIN;
        t.expires_at = T0 + 150 * MIN;
      },
      input: (i) =>
        void (i.mode = { kind: "pull_request", shapeFailures: [], now: T0 + 100 * MIN }),
    });
    expectRule(r, "authority.repo_change.tick_outlives_grant");
  });

  it("a grant with no subject_binding is insufficient", async () => {
    const r = await run({ grant: (g) => void delete g.subject_binding });
    expectRule(r, "authority.repo_change.subject_binding_absent");
    expect(r.verdict.authority).toBe("insufficient");
  });

  it("a subject_binding of another artifact schema is insufficient", async () => {
    const r = await run({
      grant: (g) =>
        void (g.subject_binding = {
          ...g.subject_binding!,
          artifact_schema: "motebit.monitor-scope.v1",
        }),
    });
    expectRule(r, "authority.repo_change.subject_binding_wrong_schema");
  });

  it("a grant with another subject is insufficient", async () => {
    const r = await run({ grant: (g) => void (g.subject = "research:thesis=acme") });
    expectRule(r, "authority.repo_change.subject_wrong");
  });

  it("a grant scope naming a tool outside the two is insufficient", async () => {
    const r = await run({ grant: (g) => void (g.scope = `${BOTH},read_file`) });
    expectRule(r, "authority.repo_change.scope_tools_outside", "grant.scope");
  });

  it("a wildcard grant scope is insufficient", async () => {
    const r = await run({ grant: (g) => void (g.scope = "*") });
    expectRule(r, "authority.repo_change.scope_tools_outside", "grant.scope");
  });

  it("a tick scope not in its one spelling is insufficient", async () => {
    const r = await run({
      tick: (t) => void (t.scope = "repo_read_blob, repo_write_path"),
    });
    expectRule(r, "authority.repo_change.scope_tools_outside", "tick.scope");
  });

  it("a grant scope naming a tool twice is insufficient", async () => {
    const r = await run({
      grant: (g) => void (g.scope = "repo_read_blob,repo_read_blob,repo_write_path"),
    });
    expectRule(r, "authority.repo_change.scope_tools_outside", "grant.scope");
  });

  it("a grant living longer than 24 hours is insufficient", async () => {
    const r = await run({
      grant: (g) => {
        g.expires_at = T0 + 25 * HOUR;
        g.cadence_ms = 25 * HOUR;
      },
    });
    expectRule(r, "authority.repo_change.lifetime_exceeded");
  });

  it("a grant with a spend_ceiling is insufficient", async () => {
    const r = await run({
      grant: (g) =>
        void (g.spend_ceiling = { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 0 }),
    });
    expectRule(r, "authority.repo_change.spend_ceiling_present");
  });

  it("a grant whose cadence_ms is below its lifetime is insufficient", async () => {
    const r = await run({ grant: (g) => void (g.cadence_ms = HOUR) });
    expectRule(r, "authority.repo_change.cadence_below_lifetime");
  });

  it("a scope for another repository is insufficient", async () => {
    const r = await run({ input: (i) => void (i.expectedRepo = "someone/else") });
    expectRule(r, "authority.repo_change.repo_mismatch");
  });

  it("B5b: a grant whose bundle already landed is spent", async () => {
    const r = await run({ input: (i) => void (i.spent = true) });
    expectRule(r, "authority.repo_change.grant_spent");
    expect(r.verdict.authority).toBe("insufficient");
  });

  it("a receipt with no delegated_scope is insufficient", async () => {
    const r = await run({ receipt: (b) => void delete b.delegated_scope });
    expectRule(r, "authority.repo_change.delegated_scope_outside");
  });

  it("a delegated_scope wider than the tick's is insufficient", async () => {
    const r = await run({
      tick: (t) => void (t.scope = "repo_read_blob"),
      tools: (t) => void t.splice(1, 1),
      receipt: (b) => {
        b.tools_used = ["repo_read_blob"];
        b.delegated_scope = BOTH;
      },
    });
    expectRule(r, "authority.repo_change.delegated_scope_outside");
  });

  it("tools_used naming a tool outside the tick's scope is insufficient", async () => {
    const r = await run({ receipt: (b) => void b.tools_used.push("read_file") });
    expectRule(r, "authority.repo_change.tools_used_outside");
  });

  it("a completed tool receipt naming a tool outside the tick's scope is insufficient", async () => {
    const r = await run({
      tools: (t) => void (t[0]!.tool_name = "read_file"),
      receipt: (b) => void (b.tools_used = ["read_file", "repo_write_path"]),
    });
    expectRule(r, "authority.repo_change.tool_receipt_outside_scope");
  });

  it("tools_used missing a tool a receipt that is not denied names is insufficient", async () => {
    const r = await run({ receipt: (b) => void (b.tools_used = ["repo_read_blob"]) });
    expectRule(r, "authority.repo_change.tools_used_mismatch");
  });

  it("tools_used naming a tool only a denied receipt names is insufficient", async () => {
    const r = await run({
      tools: (t) => void (t[1]!.status = "denied"),
      receipt: (b) => void (b.tools_used = ["repo_write_path"]),
    });
    expectRule(r, "authority.repo_change.tools_used_mismatch");
  });

  it("a run that formed a memory is insufficient", async () => {
    const r = await run({ receipt: (b) => void (b.memories_formed = 1) });
    expectRule(r, "authority.repo_change.memories_formed");
  });

  it("an allowed path the predicate refuses is insufficient", async () => {
    const r = await run({ scope: (s) => void s.allowed_paths.push(".ci/workflows/x.yml") });
    expectRule(r, "authority.repo_change.scope_path_not_permitted");
  });

  describe("a change entry outside the scope", () => {
    const entry = (e: Partial<RepoChangeComputedEntry>): RepoChangeComputedEntry => ({
      kind: "modify",
      path: enc.encode("docs/a.md"),
      mode: "100644",
      previousMode: "100644",
      blob: BLOB,
      containsNul: false,
      ...e,
    });

    it("a deletion is outside the scope", async () => {
      const r = await run({ input: (i) => void (i.entries = [entry({ kind: "delete" })]) });
      expectRule(r, "authority.repo_change.entry_not_add_or_modify");
    });

    it("a symlink is outside the scope", async () => {
      const r = await run({
        input: (i) =>
          void (i.entries = [entry({ kind: "add", mode: "120000", previousMode: undefined })]),
      });
      expectRule(r, "authority.repo_change.entry_symlink");
    });

    it("a submodule is outside the scope", async () => {
      const r = await run({
        input: (i) =>
          void (i.entries = [entry({ kind: "add", mode: "160000", previousMode: undefined })]),
      });
      expectRule(r, "authority.repo_change.entry_submodule");
    });

    it("an executable file is outside the scope", async () => {
      const r = await run({
        input: (i) =>
          void (i.entries = [entry({ kind: "add", mode: "100755", previousMode: undefined })]),
      });
      expectRule(r, "authority.repo_change.entry_mode", "has mode 100755");
    });

    it("a mode change is outside the scope", async () => {
      const r = await run({ input: (i) => void (i.entries = [entry({ previousMode: "100755" })]) });
      expectRule(r, "authority.repo_change.entry_mode", "changes mode");
    });

    it("content with a NUL byte is outside the scope", async () => {
      const r = await run({ input: (i) => void (i.entries = [entry({ containsNul: true })]) });
      expectRule(r, "authority.repo_change.entry_binary");
    });

    it("a tracked path that is not UTF-8 fails the case-collision rule closed", async () => {
      const r = await run({
        input: (i) => void (i.trackedPaths = [...i.trackedPaths, new Uint8Array([0x64, 0xff])]),
      });
      expectRule(r, "authority.repo_change.entry_case_collision", "not valid UTF-8");
    });

    it("a path that collides by case with a tracked directory is outside the scope", async () => {
      const r = await run({
        input: (i) => void (i.trackedPaths = [...i.trackedPaths, enc.encode("Docs/b.md")]),
      });
      expectRule(r, "authority.repo_change.entry_case_collision");
    });

    it("a path a Unicode case fold aliases (Kelvin sign) is outside the scope", async () => {
      const r = await run({
        scope: (s) => void (s.allowed_paths = ["docs/k.md"]),
        record: (x) => void (x.entries = [{ path: "docs/k.md", mode: "100644", blob: BLOB }]),
        input: (i) => {
          i.entries = [
            entry({ path: enc.encode("docs/k.md"), kind: "add", previousMode: undefined }),
          ];
          i.trackedPaths = [enc.encode("docs/K.md")];
        },
      });
      expectRule(r, "authority.repo_change.entry_case_collision");
    });

    it("a path a Unicode case fold aliases (long s, U+017F) is outside the scope", async () => {
      const r = await run({
        scope: (s) => void (s.allowed_paths = ["docs/s.md"]),
        record: (x) => void (x.entries = [{ path: "docs/s.md", mode: "100644", blob: BLOB }]),
        input: (i) => {
          i.entries = [
            entry({ path: enc.encode("docs/s.md"), kind: "add", previousMode: undefined }),
          ];
          i.trackedPaths = [enc.encode("docs/\u017f.md")];
        },
      });
      expectRule(r, "authority.repo_change.entry_case_collision");
    });

    it("a path not byte-equal to an allowed path is outside the scope", async () => {
      const r = await run({
        record: (x) => void (x.entries = [{ path: "docs/b.md", mode: "100644", blob: BLOB }]),
        input: (i) =>
          void (i.entries = [
            entry({ path: enc.encode("docs/b.md"), kind: "add", previousMode: undefined }),
          ]),
      });
      expectRule(r, "authority.repo_change.entry_path_not_allowed");
    });

    it("an allowed path the predicate refuses is outside the scope", async () => {
      const r = await run({
        scope: (s) => void (s.allowed_paths = [".ci/x.yml"]),
        record: (x) => void (x.entries = [{ path: ".ci/x.yml", mode: "100644", blob: BLOB }]),
        input: (i) => void (i.entries = [entry({ path: enc.encode(".ci/x.yml") })]),
      });
      expectRule(r, "authority.repo_change.entry_path_not_permitted");
    });

    it("a path whose bytes are not UTF-8 is outside the scope", async () => {
      const r = await run({
        input: (i) =>
          void (i.entries = [
            entry({ path: new Uint8Array([0x64, 0xff]), kind: "add", previousMode: undefined }),
          ]),
        record: (x) => void (x.entries = []),
      });
      expectRule(r, "authority.repo_change.entry_path_not_permitted");
      expectRule(r, "authority.repo_change.entry_path_not_allowed");
      expectRule(r, "authority.repo_change.entries_mismatch");
    });

    it("more entries than max_changed_files is outside the scope", async () => {
      const r = await run({
        scope: (s) => void s.allowed_paths.push("docs/b.md"),
        record: (x) => void x.entries.push({ path: "docs/b.md", mode: "100644", blob: BLOB }),
        input: (i) =>
          void i.entries.push(
            entry({ path: enc.encode("docs/b.md"), kind: "add", previousMode: undefined }),
          ),
      });
      expectRule(r, "authority.repo_change.entries_exceed_max");
    });

    it("recorded entries that differ from the computed ones are insufficient", async () => {
      const r = await run({ record: (x) => void (x.entries[0]!.blob = "cd".repeat(20)) });
      expectRule(r, "authority.repo_change.entries_mismatch");
    });

    it("a computed entry the record omits is insufficient", async () => {
      const r = await run({ record: (x) => void (x.entries = []) });
      expectRule(r, "authority.repo_change.entries_mismatch");
    });
  });
});

// ---------------------------------------------------------------------------
// revocation
// ---------------------------------------------------------------------------

describe("verifyRepoChange revocation", () => {
  async function revocationBy(k: KeyPair, grantId = GRANT_ID): Promise<DelegationRevocation> {
    return signDelegationRevocation(
      { grant_id: grantId, delegator_id: F_ID, delegator_public_key: hex(k), revoked_at: T0 + MIN },
      k.privateKey,
    );
  }

  it("no revocation set reads unchecked, never fresh", async () => {
    const r = await run({ input: (i) => void (i.revocations = undefined) });
    expectRule(r, "revocation.repo_change.unchecked");
    expect(r.verdict.revocation.status).toBe("unchecked");
  });

  it("a file that failed the caller's strict parse makes revocation unchecked", async () => {
    const r = await run({
      input: (i) =>
        void (i.revocations = {
          ...i.revocations!,
          failures: [".motebit/revocations/x.json: file name != grant_id"],
        }),
    });
    expectRule(r, "revocation.repo_change.set_malformed", "file name != grant_id");
    expect(r.verdict.revocation.status).toBe("unchecked");
  });

  it("a revocation with a re-spelled signature makes revocation unchecked", async () => {
    const r = await run({
      input: async (i, k) => {
        const rev = await revocationBy(k.f, OTHER_GRANT_ID);
        i.revocations = { ...i.revocations!, set: [{ ...rev, signature: respell(rev.signature) }] };
      },
    });
    expectRule(r, "revocation.repo_change.set_malformed", "revocations[0]");
    expect(r.verdict.revocation.status).toBe("unchecked");
  });

  it("a revocation whose signature does not verify makes revocation unchecked", async () => {
    const r = await run({
      input: async (i, k) => {
        const rev = await revocationBy(k.f, OTHER_GRANT_ID);
        i.revocations = { ...i.revocations!, set: [{ ...rev, revoked_at: rev.revoked_at + 1 }] };
      },
    });
    expectRule(r, "revocation.repo_change.set_malformed", "revocations[0]");
  });

  it("a revocation whose grant_id is not a lowercase UUID makes revocation unchecked", async () => {
    const r = await run({
      input: async (i, k) => {
        i.revocations = { ...i.revocations!, set: [await revocationBy(k.f, "grant-not-a-uuid")] };
      },
    });
    expectRule(r, "revocation.repo_change.set_malformed", "revocations[0]");
  });

  it("a revocation with a key the spec does not name makes revocation unchecked", async () => {
    const r = await run({
      input: async (i, k) => {
        // Signed WITH the extra key, so its signature verifies: only the strict shape refuses it.
        const rev = await signDelegationRevocation(
          {
            grant_id: OTHER_GRANT_ID,
            delegator_id: F_ID,
            delegator_public_key: hex(k.f),
            revoked_at: T0,
            note: "x",
          } as Parameters<typeof signDelegationRevocation>[0],
          k.f.privateKey,
        );
        i.revocations = { ...i.revocations!, set: [rev] };
      },
    });
    expectRule(r, "revocation.repo_change.set_malformed", "revocations[0]");
  });

  it("B6: a revocation of the grant by its delegator reads revoked", async () => {
    const r = await run({
      input: async (i, k) =>
        void (i.revocations = { ...i.revocations!, set: [await revocationBy(k.f)] }),
    });
    expectRule(r, "revocation.repo_change.revoked");
    expect(r.verdict.revocation.status).toBe("revoked");
    expect(r.verdict.authority).toBe("valid");
  });

  it("revoked wins over a malformed file", async () => {
    const r = await run({
      input: async (i, k) =>
        void (i.revocations = {
          ...i.revocations!,
          set: [await revocationBy(k.f)],
          failures: ["junk.json: not JSON"],
        }),
    });
    expect(r.verdict.revocation.status).toBe("revoked");
    expect(codes(r)).toContain("revocation.repo_change.set_malformed");
  });
});

// The fixture's digests: the record's grant/tick/scope digests are the
// verifier's own recomputation, not test-side constants.
describe("verifyRepoChange fixture sanity", () => {
  it("the fixture's scope digest is the grant's subject_binding digest", async () => {
    const { bundle } = await makeCase();
    expect(bundle.grant.subject_binding?.digest).toBe(await subjectBindingDigest(bundle.scope));
  });
});
