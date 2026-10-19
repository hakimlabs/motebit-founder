/**
 * Reading `relay_credentials` (GHSA-7pgw-2976-r236).
 *
 * The table is EVIDENCE, not a trust source. A row stored before the verifier
 * bound a credential's issuer to its proof's signer can name an issuer that
 * never signed it; v59 removes such rows unless they are already anchored,
 * because removing an anchored leaf would break the inclusion proofs of the
 * honest credentials in its batch.
 *
 * What "bound" establishes, and what it does not:
 * - The issuer a credential names IS the key that signed it
 *   (`proof.verificationMethod` before `#` equals the issuer DID). This is
 *   AUTHENTICITY of attribution, not validity and not authority.
 * - The signature itself was verified when the row was written. Every writer
 *   is listed in the PR that introduced this module: `credentials/submit`
 *   verifies before it stores (it has since the route was written), and the
 *   relay's own reputation issuance (tasks.ts, federation-callbacks.ts) signs
 *   with the relay key. Nothing else inserts into the table.
 * - Revocation, freshness and issuer trust are NOT applied here. The deciding
 *   consumer applies them (the routing aggregators: `checkRevoked`,
 *   freshness, issuer trust).
 * - `readVerifiedCredentials` re-verifies each credential in full (signature,
 *   binding, validity window) for outputs the relay vouches for: its signed
 *   presentation and the migration export.
 *
 * Every mention of the table is registered in
 * `__tests__/credential-reads-registry.test.ts`, a DRIFT DEFENSE (not an access
 * control): a trust-bearing read passes its SQL, as a literal, to one of the
 * functions here, and every other mention is registered with its reason.
 */
import { verifyVerifiableCredential, type VerifiableCredential } from "@motebit/encryption";
import { boundIssuerDid } from "@motebit/market";

/** The issuer DID a stored credential names, in SQL (`issuer`, or `issuer.id`). */
const ISSUER_SQL = `CASE json_type(credential_json, '$.issuer')
  WHEN 'text' THEN json_extract(credential_json, '$.issuer')
  WHEN 'object' THEN CASE json_type(credential_json, '$.issuer.id')
    WHEN 'text' THEN json_extract(credential_json, '$.issuer.id') END
END`;
const VM_SQL = `json_extract(credential_json, '$.proof.verificationMethod')`;

/**
 * The binding rule as a SQL predicate over a `relay_credentials` row, for a
 * WHERE clause, so a LIMIT applies to bound rows only. It mirrors
 * `boundIssuerDid` and v59's triggers; `boundCredentialRows` re-applies the
 * TypeScript rule to whatever it returns, and a row must pass both.
 */
export const BOUND_ISSUER_SQL = `(json_valid(credential_json) = 1
  AND json_type(credential_json, '$.proof.verificationMethod') = 'text'
  AND COALESCE((${ISSUER_SQL}) <> '', 0)
  AND (CASE WHEN instr(${VM_SQL}, '#') > 0
        THEN substr(${VM_SQL}, 1, instr(${VM_SQL}, '#') - 1)
        ELSE ${VM_SQL} END) = (${ISSUER_SQL})
  AND issuer_did = (${ISSUER_SQL}))`;

/** The parsed credential, or null when the stored text is ambiguous or not an object. */
function parseCanonical(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Every writer stores JSON.stringify output. Text that does not round-trip
  // (duplicate keys, which SQLite's json_extract and JSON.parse resolve
  // differently) is ambiguous, and fails closed.
  if (JSON.stringify(parsed) !== text) return null;
  return parsed as Record<string, unknown>;
}

/** Whether a stored row's credential names, as issuer, the key that signed it. */
export function isBoundRow(row: { credential_json: string }): boolean {
  const vc = parseCanonical(row.credential_json);
  if (vc == null) return false;
  const proof = vc.proof as { verificationMethod?: unknown } | undefined;
  return boundIssuerDid({ issuer: vc.issuer, proof }) !== undefined;
}

/** Rows whose stored credential's proof signer IS its named issuer. */
export function boundCredentialRows<T extends { credential_json: string }>(
  rows: readonly T[],
): T[] {
  return rows.filter(isBoundRow);
}

type ReadDb = { prepare(sql: string): { all(...params: unknown[]): unknown[] } };

/**
 * A bound read: `sql` must include `BOUND_ISSUER_SQL` in its WHERE clause
 * (before any LIMIT); the rows are filtered again in TypeScript.
 */
export function readBoundCredentials<T extends { credential_json: string }>(
  db: ReadDb,
  sql: string,
  ...params: unknown[]
): T[] {
  return boundCredentialRows(db.prepare(sql).all(...params) as T[]);
}

/**
 * A verified read, for outputs the relay vouches for: bound rows whose
 * credential's signature and issuer binding verify.
 *
 * `validity`:
 * - "current" (the relay's signed presentation): the credential must also be
 *   within its validity window now. An expired credential would make the
 *   presentation fail verification.
 * - "history" (the migration export): the validity window is NOT applied.
 *   Expired credentials are the agent's history, and spec/migration-v1.md
 *   §6.2 forbids withholding credentials issued to the agent. The check runs
 *   as of the credential's own `validFrom`, so only signature and binding
 *   decide.
 */
export async function readVerifiedCredentials<T extends { credential_json: string }>(
  validity: "current" | "history",
  db: ReadDb,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const out: T[] = [];
  for (const row of readBoundCredentials<T>(db, sql, ...params)) {
    const vc = JSON.parse(row.credential_json) as VerifiableCredential;
    const asOf =
      validity === "history" && typeof vc.validFrom === "string"
        ? Date.parse(vc.validFrom)
        : undefined;
    const now = asOf !== undefined && Number.isFinite(asOf) ? asOf : undefined;
    if (await verifyVerifiableCredential(vc, now !== undefined ? { now } : undefined)) {
      out.push(row);
    }
  }
  return out;
}
