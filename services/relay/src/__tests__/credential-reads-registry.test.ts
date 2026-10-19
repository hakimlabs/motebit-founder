/**
 * Every mention of `relay_credentials` in the relay's source is accounted for
 * (GHSA-7pgw-2976-r236).
 *
 * The table is evidence, not a trust source: rows stored before the issuer
 * binding, and kept because they are anchored, can name an issuer that never
 * signed them. A read that presents, counts or weighs a credential as issued
 * by its issuer must pass its SQL, as a literal, to `readBoundCredentials`
 * (`credential-reads.ts`). Every other mention (schema, writes, reads that
 * confer nothing) is registered here with its reason.
 *
 * How it closes the set: the scan counts EVERY case-insensitive occurrence of
 * the identifier in non-test source of any code file type under
 * services/relay, comments included, whatever the spelling around it
 * (`from`, `"relay_credentials"`, `main.relay_credentials`, a subquery). Bound
 * reads are counted from the `readBoundCredentials` calls themselves, one per
 * call, so a raw read added to a file that already has bound reads changes the
 * file's other-mention count and fails. Out of scope: a table name assembled
 * at runtime (`"relay_" + "credentials"`). This test guards against drift;
 * deliberate evasion is a review matter.
 *
 * The behaviour of each bound reader is proven in
 * `credential-issuer-binding.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "tamper"]);
const CODE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const MENTION = /relay_credentials(?![a-z0-9_])/gi;
const MENTIONS_TABLE = /relay_credentials(?![a-z0-9_])/i;
const BOUND_CALL =
  /read(?:Bound|Verified)Credentials(?:<[^>]*>)?\(\s*(?:"(?:current|history)"\s*,\s*)?db\s*,\s*(["'`])([\s\S]*?)\1/g;

/** Per file: bound reads, and every other mention with its reason. */
const REGISTRY: Record<string, { bound: number; other: Array<{ count: number; why: string }> }> = {
  "src/agents.ts": {
    bound: 1, // discovery's hardware-attestation badge
    other: [{ count: 2, why: "comment: enrichWithHardwareAttestation's doc" }],
  },
  "src/federation.ts": {
    bound: 0,
    other: [{ count: 1, why: "comment: names issuer_did in a doc comment" }],
  },
  "src/credential-reads.ts": {
    bound: 0,
    other: [{ count: 2, why: "comment: the boundary module's own docs" }],
  },
  "src/task-routing.ts": { bound: 2, other: [] }, // reputation and hardware routing weight
  "src/migration.ts": {
    bound: 2, // departure count (bound), migration export (verified)
    other: [
      {
        count: 1,
        why: "evidence: counts stored credentials so the export reports how many it excluded",
      },
    ],
  },
  "src/credentials.ts": {
    bound: 2, // the relay's signed presentation (2 queries, verified)
    other: [
      {
        count: 2,
        why: "evidence: the owner's credential list shows every stored credential, each with its issuer_bound status",
      },
      {
        count: 1,
        why: "write: credentials/submit stores a verified credential (v59 triggers enforce the binding)",
      },
      {
        count: 1,
        why: "evidence: submit idempotency compares a re-submission to the stored bytes",
      },
      {
        count: 1,
        why: "evidence: revoke-credential authority reads issuer_did/subject; revoking a stored forgery confers nothing",
      },
    ],
  },
  "src/credential-anchoring.ts": {
    bound: 0,
    other: [
      { count: 1, why: "comment: the anchor_batch_id migration note" },
      { count: 1, why: "schema: adds anchor_batch_id" },
      { count: 1, why: "write: stamps anchor_batch_id on rows cut into a batch" },
      {
        count: 7,
        why: "evidence: batching, counts and inclusion proofs attest that a row was recorded, never that its issuer signed it",
      },
    ],
  },
  "src/migrations.ts": {
    bound: 0,
    other: [
      { count: 2, why: "comment: the anchor_batch_id migration notes" },
      { count: 6, why: "schema: create, indexes, column add and the v59 triggers" },
      { count: 1, why: "schema: PRAGMA table_info" },
      { count: 2, why: "v59: finds and removes unanchored forgeries" },
    ],
  },
  "src/tasks.ts": {
    bound: 0,
    other: [{ count: 1, why: "write: the relay's own reputation credential" }],
  },
  "src/federation-callbacks.ts": {
    bound: 0,
    other: [{ count: 1, why: "write: the relay's own reputation credential for a federated task" }],
  },
  "src/transparency.ts": {
    bound: 0,
    other: [
      { count: 1, why: "declaration: names the table in the operator's retention declaration" },
    ],
  },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(path);
    return CODE.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const found = new Map<string, { mentions: number; bound: number; unfiltered: number }>();
for (const path of sources(ROOT)) {
  // Comments are NOT stripped: a regex comment-stripper can swallow real code
  // (a string containing "/*" opens a "comment"), which would hide a read.
  // Mentions in comments are registered as such instead.
  const text = readFileSync(path, "utf8");
  const mentions = text.match(MENTION)?.length ?? 0;
  if (mentions === 0) continue;
  const boundSql = [...text.matchAll(BOUND_CALL)]
    .map((m) => m[2]!)
    .filter((sql) => MENTIONS_TABLE.test(sql));
  found.set(relative(ROOT, path), {
    mentions,
    bound: boundSql.length,
    // A bound read filters in SQL, before any LIMIT, so a stored forgery
    // never takes a valid credential's place in the window.
    unfiltered: boundSql.filter((sql) => !sql.includes("${BOUND_ISSUER_SQL}")).length,
  });
}

describe("every mention of relay_credentials is registered", () => {
  it("no file mentions the table without being registered", () => {
    expect([...found.keys()].filter((f) => !(f in REGISTRY))).toEqual([]);
  });

  it("each file's bound reads are exactly its readBoundCredentials calls", () => {
    for (const [file, { bound }] of found) {
      expect({ file, bound }).toEqual({ file, bound: REGISTRY[file]!.bound });
    }
  });

  it("each file's other mentions match their registered reasons", () => {
    for (const [file, { mentions, bound }] of found) {
      const other = REGISTRY[file]!.other.reduce((n, e) => n + e.count, 0);
      expect({ file, other: mentions - bound }).toEqual({ file, other });
    }
  });

  it("every bound read applies BOUND_ISSUER_SQL in its WHERE clause", () => {
    for (const [file, { unfiltered }] of found)
      expect({ file, unfiltered }).toEqual({ file, unfiltered: 0 });
  });

  it("no registration is stale", () => {
    expect(Object.keys(REGISTRY).filter((f) => !found.has(f))).toEqual([]);
  });
});
