/**
 * One module owns the credential table (GHSA-7pgw-2976-r236).
 *
 * The table is evidence, not a trust source: rows stored before the issuer
 * binding, and kept because they are anchored, can name an issuer that never
 * signed them. So every SQL statement against it lives in
 * `credential-store.ts`, as a named function that is either EVIDENCE (raw
 * rows, conferring nothing) or BOUND / VERIFIED (what a trust-bearing
 * consumer reads). A caller cannot write the wrong read, because it cannot
 * write a read at all.
 *
 * The rule: outside `src/credential-store.ts` and the schema migrations
 * (`src/migrations.ts`), no non-test relay source mentions the table's name,
 * in any spelling (`from`, `"..."`, `main.`, a subquery, a comment).
 *
 * Aperture: every file under services/relay ending .ts/.tsx/.js/.mjs/.cjs/.sql,
 * except `.test.` files and the node_modules, dist, coverage, __tests__ and
 * tamper directories; the identifier is matched case-insensitively, comments
 * included (a regex comment-stripper can swallow real code). Out of scope: a
 * table name assembled at runtime (`"relay_" + "credentials"`) and every
 * other package. This test guards against drift; deliberate evasion is a
 * review matter.
 *
 * Inside the store, every bound or verified read applies `BOUND_ISSUER_SQL`
 * in its WHERE clause, so a LIMIT counts bound rows only, and every exported
 * function's name says which kind it is. The behaviour of each bound reader
 * is proven in `credential-issuer-binding.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "tamper"]);
const CODE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const MENTION = /relay_credentials(?![a-z0-9_])/gi;
const MENTIONS_TABLE = /relay_credentials(?![a-z0-9_])/i;
const STORE = "src/credential-store.ts";
/** The only files allowed to name the table, and why. */
const OWNERS: Record<string, string> = {
  [STORE]: "the credential store: every statement against the table",
  "src/migrations.ts":
    "the schema migrations: create, indexes, column add, v59 triggers and cleanup",
};
const BOUND_CALL =
  /read(?:Bound|Verified)Credentials(?:<[^>]*>)?\(\s*(?:"(?:current|history)"\s*,\s*)?db\s*,\s*(["'`])([\s\S]*?)\1/g;
/**
 * Every store function that WRITES the table, and the only files that may call
 * it (call sites per file). A write is authority over a stored row, so the
 * callers are a closed set: a new caller is a new door, and must be added here
 * with its reason (check-identity-authority-writers registers the SQL itself).
 */
const WRITER_CALLERS: Record<string, Record<string, number>> = {
  // credentials/submit: the owner is a BoundIdentity (#850).
  insertSubmittedCredential: { "src/credentials.ts": 1 },
  // The relay issuing its own reputation credential from a verified receipt.
  insertRelayIssuedCredentialEvidence: { "src/tasks.ts": 1, "src/federation-callbacks.ts": 1 },
  // Credential anchoring: the loop's batch cut and the schema column.
  assignCredentialEvidenceToBatch: { "src/credential-anchoring.ts": 1 },
  addCredentialEvidenceAnchorColumn: { "src/credential-anchoring.ts": 1 },
};
/** Exported store functions whose names need not say their kind, and why. */
const NAME_EXEMPT: Record<string, string> = {
  insertSubmittedCredential:
    "the #850 bound writer; its name is registered in check-identity-authority-writers and relay rule 26",
};
const REPAIR =
  "Move the statement into src/credential-store.ts as a named function (an `...Evidence...` " +
  "function when it confers nothing; a `...Bound...`/`...Verified...` function when a consumer " +
  "presents, counts or weighs a credential as issued by its issuer) and call it. A comment that " +
  "names the table should say `the credential store` instead.";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(path);
    return CODE.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const scanned = sources(ROOT);
const mentions = new Map<string, number>();
for (const path of scanned) {
  const count = readFileSync(path, "utf8").match(MENTION)?.length ?? 0;
  if (count > 0) mentions.set(relative(ROOT, path), count);
}
const store = readFileSync(join(ROOT, STORE), "utf8");

describe("one module owns the credential table", () => {
  it("scans the relay's sources (aperture)", () => {
    // Guards the aperture itself: a scan that found nothing proves nothing.
    expect(scanned.length).toBeGreaterThan(100);
    expect(mentions.has(STORE)).toBe(true);
  });

  it("no source outside the store and the migrations mentions the table", () => {
    const strays = [...mentions.keys()]
      .filter((file) => !(file in OWNERS))
      .map((file) => `${file} (${mentions.get(file)} mention(s)) — ${REPAIR}`);
    expect(strays).toEqual([]);
  });

  it("every bound or verified read in the store filters in SQL, before any LIMIT", () => {
    const bound = [...store.matchAll(BOUND_CALL)]
      .map((m) => m[2]!)
      .filter((sql) => MENTIONS_TABLE.test(sql));
    expect(bound.length).toBeGreaterThan(0);
    const unfiltered = bound.filter((sql) => !sql.includes("${BOUND_ISSUER_SQL}"));
    expect(
      unfiltered,
      "add `AND ${BOUND_ISSUER_SQL}` to the WHERE clause, before ORDER BY / LIMIT",
    ).toEqual([]);
  });

  it("the raw bound/verified readers stay private to the store", () => {
    // Exported, they would take SQL from a caller again.
    expect(store).not.toMatch(/export\s+(async\s+)?function\s+read(Bound|Verified)Credentials\b/);
  });

  it("every exported function names its kind", () => {
    const exported = [...store.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
      (m) => m[1]!,
    );
    // Evidence confers nothing; Bound/Verified confer attribution; the binding
    // rule itself (isBoundRow, boundCredentialRows) is a predicate.
    const unnamed = exported.filter(
      (name) => !/evidence|bound|verified/i.test(name) && !(name in NAME_EXEMPT),
    );
    expect(
      unnamed,
      "name an exported store function `...Evidence...` (raw rows) or `...Bound...`/`...Verified...`",
    ).toEqual([]);
  });

  it("every store writer is registered, and called only from its registered doors", () => {
    // A function body runs from its `export function` to the next doc comment
    // or export, so doc text never counts as a write.
    const writers = [
      ...store.matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)([\s\S]*?)(?=\n\/\*\*|\nexport\s|$)/g,
      ),
    ]
      .filter((m) => /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER)\b/.test(m[2]!))
      .map((m) => m[1]!)
      .sort();
    expect(writers, "register each store writer in WRITER_CALLERS with its callers").toEqual(
      Object.keys(WRITER_CALLERS).sort(),
    );
    const found: Record<string, Record<string, number>> = {};
    for (const name of writers) {
      found[name] = {};
      const call = new RegExp(`(?<!function\\s)\\b${name}\\(`, "g");
      for (const path of scanned) {
        const file = relative(ROOT, path);
        if (file === STORE) continue;
        const n = readFileSync(path, "utf8").match(call)?.length ?? 0;
        if (n > 0) found[name][file] = n;
      }
    }
    expect(
      found,
      "a new caller of a store writer is a new door: add it to WRITER_CALLERS with its reason",
    ).toEqual(WRITER_CALLERS);
  });
});
