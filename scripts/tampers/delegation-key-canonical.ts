/**
 * Tamper checks for "delegation-family keys verify only in their canonical
 * spelling" (spec/standing-delegation-v1 §5 "Keys have one spelling") — each
 * removal, applied alone, must turn the named test red.
 *
 *   1. `verifyDelegationRevocation` canonical-key check removed: an UPPERCASE
 *      revocation the delegator signed verifies yet binds nothing.
 *   2. `verifyStandingDelegation` canonical-key check removed: an UPPERCASE-key
 *      grant verifies (and the delegator's canonical revocation cannot bind it).
 *   3. `verifyDelegation` canonical-key check removed: a non-canonical token verifies.
 *   4. `signDelegationRevocation` refusal removed: a producer emits a revocation
 *      every verifier rejects.
 *   5. Grant + token checks removed together: the token verdict reports a
 *      canonically-revoked UPPERCASE-key grant as fully verified.
 *   6. Same, through the runtime's money gate (`verifyGrantForTurn` returns a
 *      verified grant for a revoked grant). Reads crypto's dist — rebuilt.
 *   7. Revocation check removed, through the relay's binder: the relay binds an
 *      UPPERCASE-key revocation. Reads crypto's dist — rebuilt.
 *
 * Entries are `command` entries (the key-binding-malformed-succession.ts
 * shape): on this tree the runner's vitest mode reads no JSON report, because
 * `vitest.shared.ts` pins the json reporter's `outputFile` and the CLI
 * `--outputFile.json` the runner passes does not override it. Each command
 * runs ONE test (`-t` on its exact full name) and is RED only when that file
 * reports a failure.
 *
 *   npx tsx scripts/tampers/delegation-key-canonical.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vitestCommand(
  pkg: string,
  test: string,
  fullName: string,
): Pick<TamperEntry, "command" | "redMarker"> {
  return {
    command: [
      "pnpm",
      "--filter",
      pkg,
      "exec",
      "vitest",
      "run",
      test,
      "-t",
      `^${escapeRegExp(fullName)}$`,
    ],
    redMarker: "Test Files  1 failed",
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACTS = "packages/crypto/src/artifacts.ts";
const CRYPTO_TEST = "src/__tests__/delegation-key-canonical.test.ts";
const D = "delegation family — keys verify only in their canonical spelling";

const REVOCATION_CHECK: TamperEdit = {
  file: ARTIFACTS,
  from: "  if (!isCanonicalPublicKeyHex(revocation.delegator_public_key)) return false;\n",
  to: "",
};
const GRANT_CHECK: TamperEdit = {
  file: ARTIFACTS,
  from: "    !isCanonicalPublicKeyHex(grant.delegator_public_key) ||\n    !isCanonicalPublicKeyHex(grant.delegate_public_key)\n",
  to: "    (false as boolean)\n",
};
const TOKEN_CHECK: TamperEdit = {
  file: ARTIFACTS,
  from: "    !isCanonicalPublicKeyHex(delegation.delegator_public_key) ||\n    !isCanonicalPublicKeyHex(delegation.delegate_public_key)\n",
  to: "    (false as boolean)\n",
};
const SIGNER_REFUSAL: TamperEdit = {
  file: ARTIFACTS,
  from: "  if (!isCanonicalPublicKeyHex(revocation.delegator_public_key)) {\n    throw new Error(",
  to: "  if ((false as boolean) && !isCanonicalPublicKeyHex(revocation.delegator_public_key)) {\n    throw new Error(",
};

const TAMPERS: TamperEntry[] = [
  {
    name: "crypto: verifyDelegationRevocation canonical-key check removed",
    edits: [REVOCATION_CHECK],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${D} a revocation the delegator signed with its key in UPPERCASE never verifies without binding`,
    ),
  },
  {
    name: "crypto: verifyStandingDelegation canonical-key check removed",
    edits: [GRANT_CHECK],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${D} a grant whose delegator key is spelled in UPPERCASE does not verify (the delegator's canonical revocation could never bind it)`,
    ),
  },
  {
    name: "crypto: verifyDelegation canonical-key check removed",
    edits: [TOKEN_CHECK],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${D} a delegation token whose delegator or delegate key is not canonical does not verify`,
    ),
  },
  {
    name: "crypto: signDelegationRevocation refusal removed",
    edits: [SIGNER_REFUSAL],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${D} signDelegationRevocation refuses a non-canonical delegator key`,
    ),
  },
  {
    name: "crypto verdict: grant + token canonical-key checks removed",
    edits: [GRANT_CHECK, TOKEN_CHECK],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${D} verdict: an UPPERCASE-key grant the delegator revoked canonically is never isFullyVerified`,
    ),
  },
  {
    name: "runtime verifyGrantForTurn: grant + token canonical-key checks removed",
    edits: [GRANT_CHECK, TOKEN_CHECK],
    ...vitestCommand(
      "@motebit/runtime",
      "src/__tests__/grant-verifier.test.ts",
      "verifyGrantForTurn returns null for a grant whose delegator key is spelled in UPPERCASE, revoked by the delegator's canonical revocation",
    ),
    rebuild: ["@motebit/crypto"],
  },
  {
    name: "relay bindByDelegationRevocation: revocation canonical-key check removed",
    edits: [REVOCATION_CHECK],
    ...vitestCommand(
      "@motebit/relay",
      "src/__tests__/credential-and-revocation-binding-850.test.ts",
      "a delegation revocation binds to a key the relay holds for its delegator (#850 item 2) a revocation whose OWN key is spelled UPPER-case is not a statement this relay binds or caches",
    ),
    rebuild: ["@motebit/crypto"],
  },
];

void runTampers(TAMPERS, { root: ROOT });
