/**
 * #1147 tamper checks — the six tests whose outcome depended on machine load
 * were rewritten to wait on events (or to carry only their own work under a
 * budget). Each rewrite must still guard what it guarded: break the guarded
 * behaviour, and the rewritten test goes red.
 *
 *   node scripts/tampers/1147-wall-clock-tests.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Run as a command with a red marker, written while vitest entries could not
 * run (#1062: vitest.shared.ts's JSON reporter outputFile overrode the
 * runner's). Vitest entries work again since the runner names its own
 * reporter (tamper-runner.ts META_REPORTER); command mode remains valid.
 * `-t` narrows the run to the one
 * test that must go red, anchored to its exact full name.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entry(o: {
  name: string;
  pkg: string;
  test: string;
  red: string;
  edits: TamperEntry["edits"];
}): TamperEntry {
  return {
    name: o.name,
    edits: o.edits,
    command: [
      "pnpm",
      "--filter",
      o.pkg,
      "exec",
      "vitest",
      "run",
      o.test,
      "-t",
      `^${escapeRegExp(o.red)}$`,
    ],
    redMarker: "Test Files  1 failed",
  };
}

const TAMPERS: TamperEntry[] = [
  entry({
    name: "web #962: a device the relay was down for is never registered once it is up (no retry)",
    pkg: "@motebit/web",
    test: "src/__tests__/every-configured-surface-pushes-962.test.ts",
    red: "#962 — every configured WEB surface pushes (matrix) web | fresh | down→up | token (self-minted)",
    edits: [
      {
        file: "apps/web/src/web-app.ts",
        from: "    if (!registered) this.retryRegistration(relayUrl);",
        to: "    void registered;",
      },
    ],
  }),
  entry({
    name: "spatial #962: a device the relay was down for is never registered once it is up (no retry)",
    pkg: "@motebit/spatial",
    test: "src/__tests__/every-configured-surface-pushes-962.test.ts",
    red: "#962 — every configured SPATIAL surface pushes (matrix) spatial | fresh | down→up | token (tokenFactory)",
    edits: [
      {
        file: "apps/spatial/src/sync-controller.ts",
        from: "        if (!registered) this.retryRegistration(relayUrl);",
        to: "        void registered;",
      },
    ],
  }),
  entry({
    // Rule 6 (assess.ts): a memo found at ANY date is reported. Both of its
    // doors are reverted — the verifier's "revoked after signing" (this
    // memo's date, 1e17, is after the receipt's claimed time) and the page's
    // own scan — so a memo dated past the claimed time clears the key.
    name: "verify: a memo dated after the receipt's claimed time is not reported (rule 6)",
    pkg: "@motebit/verify-web",
    test: "src/__tests__/claimed-vs-proven.test.ts",
    red: "claimed vs proven: every signer- or relay-controlled field revocation (independent RPC): a memo with a timestamp past the last representable date → REVOCATION REPORTED, never ignored",
    edits: [
      {
        file: "apps/verify/src/assess.ts",
        from: '    v.revocation === "revoked_after_signing" ||\n    v.binding === "revoked" ||\n    scanFound;',
        to: '    v.binding === "revoked";\n  void scanFound;',
      },
    ],
  }),
  entry({
    name: "relay: a solvency proof says sufficient whatever the balance",
    pkg: "@motebit/relay",
    test: "src/__tests__/solvency-proof.test.ts",
    red: "GET /api/v1/agents/:motebitId/solvency-proof returns sufficient=false when balance insufficient",
    edits: [
      {
        file: "services/relay/src/agents.ts",
        from: "      sufficient: balanceAvailable >= amount,",
        to: "      sufficient: true,",
      },
    ],
  }),
  entry({
    // Both layers: ensureEnrolled's retired-at-head refusal AND the mint
    // path's re-check under the lock. Either alone is covered by the other.
    name: "surface-kit roster: a machine the sovereign retired re-mints itself on its own",
    pkg: "@motebit/surface-kit",
    test: "src/__tests__/machine-roster.test.ts",
    red: "property — a machine the sovereign retired never ends active at the head without `enroll` seed 27: a 12-step sequence (old-key lines may land between the link and a late hook)",
    edits: [
      {
        file: "packages/surface-kit/src/machine-roster.ts",
        from: '    if (status === "retired") {\n      return { kind: "retired", confirmed, presented: await this.present(acq) };',
        to: '    if (false as boolean) {\n      return { kind: "retired", confirmed, presented: await this.present(acq) };',
      },
      {
        file: "packages/surface-kit/src/machine-roster.ts",
        from: '          if (status === "retired") {\n            return { kind: "retired", replica: await persist(frozenAs("not-active")) };',
        to: '          if (false as boolean) {\n            return { kind: "retired", replica: await persist(frozenAs("not-active")) };',
      },
    ],
  }),
  entry({
    name: "molecule-runner: the builder ignores the injected wallet, so the authorized hire never reaches it",
    pkg: "@motebit/molecule-runner",
    test: "src/__tests__/money-runtime-activation.test.ts",
    red: "defaultCreateMoneyRuntime — money-without-authority fails CLOSED at the composition root R4 gates the sovereign WALLET at the composition root: an authorized hire fires the injected payment leg",
    edits: [
      {
        file: "packages/molecule-runner/src/index.ts",
        from: "  const wallet =\n    walletOverride ??\n    createSolanaWalletRail({",
        to: "  const wallet =\n    createSolanaWalletRail({",
      },
    ],
  }),
];

await runTampers(TAMPERS, { root: ROOT });
