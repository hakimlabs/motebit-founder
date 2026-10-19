#!/usr/bin/env node
/**
 * Tamper checks for credential issuer binding: a credential is valid only when
 * the proof's signer IS its issuer (and a presentation's signer its holder).
 * Each entry is (file, text to revert, test expected red), run by the shared
 * runner (scripts/lib/tamper-runner.ts) in an isolated copy of the tree:
 *
 *   - `verifyVerifiableCredential`'s binding removed — the crypto tests go red;
 *   - `verify()`'s credential result ignoring the binding — crypto red;
 *   - `verifyVerifiablePresentation`'s holder binding removed — crypto red;
 *   - `verify()`'s presentation result ignoring the holder binding — crypto red;
 *   - the verifier's binding removed, crypto rebuilt — the relay's submit and
 *     verify routes go red (they inherit the binding; nothing else enforces it);
 *   - the relay's issuer normalization reverted to the string-only read — the
 *     object-issuer self-issuance case goes red;
 *   - the market aggregators' issuer normalization reverted — market red.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/credential-issuer-binding.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const CREDS = "packages/crypto/src/credentials.ts";
const INDEX = "packages/crypto/src/index.ts";
const RELAY = "services/relay/src/credentials.ts";
const MARKET = "packages/market/src/credential-weight.ts";

// Run as commands with a red marker, not as vitest entries: the repo's vitest
// config pins the JSON reporter's outputFile (see federation-recipient-binding.mjs).
const vitest = (pkg, file) => ({
  command: ["pnpm", "--filter", pkg, "exec", "vitest", "run", file],
  redMarker: "Test Files  1 failed",
});
const CRYPTO = vitest("@motebit/crypto", "src/__tests__/credential-issuer-binding.test.ts");
const RELAY_TEST = vitest("@motebit/relay", "src/__tests__/credential-issuer-binding.test.ts");
const MARKET_TEST = vitest("@motebit/market", "src/__tests__/credential-issuer-form.test.ts");

const VC_BINDING = {
  file: CREDS,
  from: "  if (!proofSignerIs(vc.proof, namedDidOf(vc.issuer))) return false;\n",
  to: "",
};
const VERIFY_BINDING = {
  file: INDEX,
  from: "    valid: proofValid && issuerBound && !expired && !notYetValid,",
  to: "    valid: proofValid && !expired && !notYetValid,",
};

const RAW_READER = {
  file: "services/relay/src/credential-reads.ts",
  from: "export function readBoundCredentials<",
  to: "export function readAllCredentials<T>(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, sql: string, ...params: unknown[]): T[] { return db.prepare(sql).all(...params) as T[]; }\nexport function readBoundCredentials<",
};
/**
 * One bound read bypasses BOTH layers of the boundary: its call becomes a raw
 * read and its SQL loses the binding predicate. (Either layer alone still
 * filters, by design, so a tamper of one layer proves nothing.)
 */
const bypass = (name, file, importFrom, importTo, edits) => ({
  name,
  edits: [
    RAW_READER,
    { file, from: importFrom, to: importTo },
    ...edits.map((e) => ({ file, ...e })),
  ],
  ...RELAY_TEST,
});

const TAMPERS = [
  {
    name: "verifyVerifiableCredential: issuer/signer binding removed",
    edits: [VC_BINDING],
    ...CRYPTO,
  },
  {
    name: "verify(): credential validity ignores the issuer binding",
    edits: [VERIFY_BINDING],
    ...CRYPTO,
  },
  {
    name: "verifyVerifiablePresentation: holder/signer binding removed",
    edits: [
      {
        file: CREDS,
        from:
          "  if (!proofSignerIs(vp.proof, namedDidOf(vp.holder))) {\n" +
          '    errors.push("Presentation holder is not the presentation signer");\n' +
          "  }\n",
        to: "",
      },
    ],
    ...CRYPTO,
  },
  {
    name: "verify(): presentation validity ignores the holder binding",
    edits: [
      {
        file: INDEX,
        from: "  const allValid = envelopeValid && holderBound && credentialResults.every((c) => c.valid);",
        to: "  const allValid = envelopeValid && credentialResults.every((c) => c.valid);",
      },
    ],
    ...CRYPTO,
  },
  {
    name: "relay routes: the verifier's binding removed (crypto rebuilt)",
    edits: [VC_BINDING],
    rebuild: ["@motebit/crypto"],
    ...RELAY_TEST,
  },
  {
    name: "relay submit: issuer read as a string only",
    edits: [
      {
        file: RELAY,
        from:
          "      const issuerDid =\n" +
          '        typeof rawIssuer === "string"\n' +
          "          ? rawIssuer\n" +
          "          : rawIssuer !== null &&\n" +
          '              typeof rawIssuer === "object" &&\n' +
          '              typeof (rawIssuer as { id?: unknown }).id === "string"\n' +
          "            ? (rawIssuer as { id: string }).id\n" +
          '            : "";',
        to: '      const issuerDid = typeof rawIssuer === "string" ? rawIssuer : "";',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "market aggregators: issuer passed through unnormalized",
    edits: [
      {
        file: MARKET,
        from: '  if (typeof issuer === "string") return issuer.length > 0 ? issuer : undefined;\n',
        to: '  if (typeof issuer !== "symbol") return issuer as string;\n',
      },
    ],
    ...MARKET_TEST,
  },
  {
    name: "market: a stored credential counts without its signer being its issuer",
    edits: [
      {
        file: MARKET,
        from: "  return signerDid === issuerDid ? issuerDid : undefined;",
        to: "  return issuerDid;",
      },
    ],
    ...vitest("@motebit/market", "src/__tests__/credential-stored-binding.test.ts"),
  },
  {
    name: "migration v59: stored forgeries are kept",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "          del.run(row.credential_id);",
        to: "          void del;",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the insert trigger accepts a forgery",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "        BEFORE INSERT ON relay_credentials\n        WHEN json_valid(NEW.credential_json) = 0 OR NOT COALESCE(${bound}, 0)",
        to: "        BEFORE INSERT ON relay_credentials\n        WHEN 0",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the update trigger accepts a rewrite into a forgery",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "        BEFORE UPDATE OF credential_json, issuer_did ON relay_credentials\n        WHEN json_valid(NEW.credential_json) = 0 OR NOT COALESCE(${bound}, 0)",
        to: "        BEFORE UPDATE OF credential_json, issuer_did ON relay_credentials\n        WHEN 0",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: anchored forgeries deleted too (breaks honest anchor proofs)",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: '"SELECT credential_id, credential_json FROM relay_credentials WHERE anchor_batch_id IS NULL"',
        to: '"SELECT credential_id, credential_json FROM relay_credentials"',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the trigger ignores the issuer_did column",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "      ) AND NEW.issuer_did = (",
        to: "      ) AND 1 = 1 AND NULL IS (",
      },
    ],
    ...RELAY_TEST,
  },
  bypass(
    "relay discovery: the hardware-attestation badge reads raw rows",
    "services/relay/src/agents.ts",
    'import { BOUND_ISSUER_SQL, readBoundCredentials } from "./credential-reads.js";',
    'import { BOUND_ISSUER_SQL, readAllCredentials, readBoundCredentials } from "./credential-reads.js";',
    [
      {
        from: "  const boundRows = readBoundCredentials<{",
        to: "  const boundRows = readAllCredentials<{",
      },
      {
        from: "         AND ${BOUND_ISSUER_SQL}\n       ORDER BY issued_at DESC`,",
        to: "       ORDER BY issued_at DESC`,",
      },
    ],
  ),
  bypass(
    "relay: the departure attestation counts raw rows",
    "services/relay/src/migration.ts",
    "  BOUND_ISSUER_SQL,\n  readBoundCredentials,\n  readVerifiedCredentials,\n} from",
    "  BOUND_ISSUER_SQL,\n  readAllCredentials,\n  readBoundCredentials,\n  readVerifiedCredentials,\n} from",
    [
      {
        from: "      const credRows = readBoundCredentials<",
        to: "      const credRows = readAllCredentials<",
      },
      {
        from: "relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL}`,\n        motebitId,",
        to: "relay_credentials WHERE subject_motebit_id = ?`,\n        motebitId,",
      },
    ],
  ),
  {
    name: "registry: an unregistered read spelled lowercase and quoted",
    edits: [
      {
        file: "services/relay/src/agents.ts",
        from: "  if (boundRows.length === 0) return agents;",
        to: "  if (boundRows.length === 0) return agents;\n  void db.prepare('select 1 from \"relay_credentials\"');",
      },
    ],
    ...vitest("@motebit/relay", "src/__tests__/credential-reads-registry.test.ts"),
  },
  {
    name: "relay: the owner's list reports every credential as bound",
    edits: [
      { file: RELAY, from: "      issuer_bound: isBoundRow(r),", to: "      issuer_bound: true," },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the presentation ignores the validity window (an expired credential is presented)",
    edits: [
      {
        file: RELAY,
        from: 'await readVerifiedCredentials<(typeof rows)[number]>(\n        "current",\n        db,\n        `SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL} ORDER BY',
        to: 'await readVerifiedCredentials<(typeof rows)[number]>(\n        "history",\n        db,\n        `SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL} ORDER BY',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the export withholds expired honest credentials (spec/migration-v1.md §6.2)",
    edits: [
      {
        file: "services/relay/src/migration.ts",
        from: '    }>(\n      "history",\n      db,',
        to: '    }>(\n      "current",\n      db,',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the export silently drops what it excluded",
    edits: [
      {
        file: "services/relay/src/migration.ts",
        from: "      excluded_credentials: storedCount - credentials.length,",
        to: "      excluded_credentials: 0,",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "registry: a routing read filters only after its LIMIT",
    edits: [
      {
        file: "services/relay/src/task-routing.ts",
        from: "WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'\n             AND ${BOUND_ISSUER_SQL}",
        to: "WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'",
      },
    ],
    ...vitest("@motebit/relay", "src/__tests__/credential-reads-registry.test.ts"),
  },
  {
    name: "boundary: ambiguous (non-canonical, duplicate-key) JSON accepted",
    edits: [
      {
        file: "services/relay/src/credential-reads.ts",
        from: "  if (JSON.stringify(parsed) !== text) return null;",
        to: "",
      },
    ],
    ...RELAY_TEST,
  },
];

await runTampers(TAMPERS, { root: ROOT });
