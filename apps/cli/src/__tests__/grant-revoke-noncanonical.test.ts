/**
 * `motebit grant revoke` on a stored grant whose delegator key is not in its
 * canonical spelling (64 lowercase hex). Such a grant verifies nowhere — the
 * verifiers reject the spelling — and `signDelegationRevocation` refuses to
 * sign over it, so before this guard the command died with a raw stack after
 * the passphrase prompt. It now says, in one calm line, that the grant is
 * already inert, and exits non-zero without touching the stored grant.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, bytesToHex } from "@motebit/encryption";

// The passphrase prompt is not under test: hand back the delegator's key so a
// missing guard reaches the signer (and its raw throw) instead of stdin.
const keyHolder: { privateKey?: Uint8Array } = {};
vi.mock("../identity.js", async (orig) => ({
  ...(await orig<typeof import("../identity.js")>()),
  loadActiveSigningKey: async () => ({ privateKey: keyHolder.privateKey!.slice() }),
}));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "motebit-grant-revoke-noncanonical-"));
  vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
  vi.stubEnv("MOTEBIT_SYNC_URL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("grant revoke — a stored grant with a non-canonical delegator key", () => {
  it("prints one calm line that the grant is already inert and exits non-zero, leaving the store untouched", async () => {
    vi.resetModules();
    const grantMod = await import("../subcommands/grant.js");
    const kp = await generateKeypair();
    keyHolder.privateKey = kp.privateKey;
    const upper = bytesToHex(kp.publicKey).toUpperCase();
    const grantId = "grant-noncanonical";
    const stored = {
      grant: {
        grant_id: grantId,
        delegator_id: "mote-legacy",
        delegator_public_key: upper,
        delegate_id: "mote-legacy",
        delegate_public_key: upper,
        scope: "transfer_funds",
        subject: "billing:vendor=acme",
        cadence_ms: 86_400_000,
        issued_at: Date.now() - 1000,
        not_before: null,
        expires_at: Date.now() + 86_400_000,
        max_token_ttl_ms: 3_600_000,
        suite: "motebit-jcs-ed25519-b64-v1",
        signature: "x",
      },
      ticks: [],
    };
    const grantsDir = join(dir, grantMod.GRANTS_DIR_NAME);
    mkdirSync(grantsDir, { recursive: true });
    const file = join(grantsDir, `${grantId}.json`);
    writeFileSync(file, JSON.stringify(stored));

    const errors: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(grantMod.handleGrantRevoke(grantId)).rejects.toThrow("exit:1");
    } finally {
      err.mockRestore();
      exit.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/non-canonical delegator key/);
    expect(errors[0]).toMatch(/already inert/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(stored);
  });
});
