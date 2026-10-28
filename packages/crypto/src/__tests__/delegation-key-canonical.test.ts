/**
 * Delegation family — a public key verifies only in its ONE canonical spelling
 * (64 lowercase hex; spec/standing-delegation-v1 §3.1 / §5.1, the committed
 * JSON Schemas' `^[0-9a-f]{64}$`).
 *
 * The defect this pins: `findGrantRevocation` binds a revocation to a grant by
 * EXACT string equality of `delegator_public_key`, while the verifiers decoded
 * keys leniently (`"AB"` ≡ `"ab"`, `"0g"` ≡ `"00"`). So a revocation the
 * delegator really signed, with its key spelled differently from the grant's,
 * VERIFIED yet bound nothing — and a grant spelled in uppercase verified yet
 * could not be revoked by the delegator's canonical revocation: the token
 * verdict reported `revocation: fresh`, `isFullyVerified: true` for a revoked
 * grant. The fix rejects every non-canonical key at verify, so "verifies" and
 * "binds" are one statement.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  signBySuite,
  toBase64Url,
  signDelegation,
  verifyDelegation,
  signStandingDelegation,
  verifyStandingDelegation,
  signDelegationRevocation,
  verifyDelegationRevocation,
  findGrantRevocation,
  deriveSovereignMotebitId,
  verifyDelegationTokenVerdict,
  isFullyVerified,
} from "../index.js";
import type { DelegationRevocation, DelegationToken, StandingDelegation } from "@motebit/protocol";

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

/**
 * Sign any delegation-family body BY HAND, whatever its key spelling — what a
 * foreign producer could emit. The motebit signers refuse a non-canonical key,
 * so a test of the VERIFIER cannot go through them.
 */
async function handSign<T extends object>(
  body: T,
  privateKey: Uint8Array,
): Promise<T & { suite: typeof SUITE; signature: string }> {
  const withSuite = { ...body, suite: SUITE };
  const sig = await signBySuite(
    SUITE,
    new TextEncoder().encode(canonicalJson(withSuite)),
    privateKey,
  );
  return { ...withSuite, signature: toBase64Url(sig) };
}

async function makeGrant(
  delegator: Kp,
  delegate: Kp,
  keys: { delegator?: string; delegate?: string } = {},
): Promise<StandingDelegation> {
  const delegatorHex = bytesToHex(delegator.publicKey);
  return handSign(
    {
      grant_id: "grant-1",
      delegator_id: await deriveSovereignMotebitId(delegatorHex),
      delegator_public_key: keys.delegator ?? delegatorHex,
      delegate_id: "mote-delegate",
      delegate_public_key: keys.delegate ?? bytesToHex(delegate.publicKey),
      scope: "web.search,brief.compose",
      subject: "research:thesis=x",
      cadence_ms: DAY,
      issued_at: NOW - 1000,
      not_before: null,
      expires_at: NOW + 30 * DAY,
      max_token_ttl_ms: HOUR,
    },
    delegator.privateKey,
  );
}

/**
 * Sign a revocation BY HAND with an arbitrary key spelling — what a foreign
 * producer could emit. `signDelegationRevocation` refuses a non-canonical key,
 * so the test cannot go through it.
 */
async function handSignRevocation(
  grant: StandingDelegation,
  delegator: Kp,
  keySpelling: string,
): Promise<DelegationRevocation> {
  const body = {
    grant_id: grant.grant_id,
    delegator_id: grant.delegator_id,
    delegator_public_key: keySpelling,
    revoked_at: NOW - 500,
    suite: SUITE,
  };
  const sig = await signBySuite(
    SUITE,
    new TextEncoder().encode(canonicalJson(body)),
    delegator.privateKey,
  );
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * A non-hex alias of `hex` that the lenient decoder maps to the same bytes:
 * a byte `0N` (< 0x10) re-spelled `Ng` (`parseInt("Ng", 16) === N`). Returns
 * null when the key has no such byte.
 */
function nonHexAlias(hex: string): string | null {
  for (let i = 0; i < hex.length; i += 2) {
    if (hex[i] === "0") return hex.slice(0, i) + hex[i + 1]! + "g" + hex.slice(i + 2);
  }
  return null;
}

async function keypairWithNonHexAlias(): Promise<{ kp: Kp; alias: string }> {
  for (;;) {
    const kp = await generateKeypair();
    const alias = nonHexAlias(bytesToHex(kp.publicKey));
    if (alias !== null) return { kp, alias };
  }
}

describe("delegation family — keys verify only in their canonical spelling", () => {
  it("a revocation the delegator signed with its key in UPPERCASE never verifies without binding", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await handSignRevocation(grant, alice, grant.delegator_public_key.toUpperCase());

    const verifies = await verifyDelegationRevocation(rev);
    const binds = (await findGrantRevocation(grant, [rev])) !== null;
    // The illegal state was verifies=true, binds=false (a revoked-looking
    // artifact the consumer silently ignores). They must agree.
    expect(verifies).toBe(binds);
    expect(verifies).toBe(false);
  });

  it("a revocation whose key is a NON-HEX alias of the delegator key (0N spelled Ng) does not verify", async () => {
    const { kp: alice, alias } = await keypairWithNonHexAlias();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await handSignRevocation(grant, alice, alias);

    expect(await verifyDelegationRevocation(rev)).toBe(false);
    expect(await findGrantRevocation(grant, [rev])).toBeNull();
  });

  it("the canonical revocation still verifies and binds (control)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob);
    const rev = await handSignRevocation(grant, alice, grant.delegator_public_key);
    expect(await verifyDelegationRevocation(rev)).toBe(true);
    expect(await findGrantRevocation(grant, [rev])).toEqual(rev);
  });

  it("signDelegationRevocation refuses a non-canonical delegator key", async () => {
    const alice = await generateKeypair();
    const hex = bytesToHex(alice.publicKey);
    for (const spelling of [hex.toUpperCase(), `${hex.slice(0, 63)}G`, hex.slice(2)]) {
      await expect(
        signDelegationRevocation(
          {
            grant_id: "grant-1",
            delegator_id: "mote-alice",
            delegator_public_key: spelling,
            revoked_at: NOW,
          },
          alice.privateKey,
        ),
      ).rejects.toThrow(/canonical/);
    }
  });

  it("signStandingDelegation refuses a non-canonical delegator or delegate key", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const a = bytesToHex(alice.publicKey);
    const b = bytesToHex(bob.publicKey);
    const body = (delegator_public_key: string, delegate_public_key: string) => ({
      grant_id: "grant-1",
      delegator_id: "mote-alice",
      delegator_public_key,
      delegate_id: "mote-bob",
      delegate_public_key,
      scope: "web.search",
      subject: "s",
      cadence_ms: DAY,
      issued_at: NOW,
      not_before: null,
      expires_at: NOW + DAY,
      max_token_ttl_ms: HOUR,
    });
    await expect(signStandingDelegation(body(a, b), alice.privateKey)).resolves.toBeDefined();
    await expect(
      signStandingDelegation(body(a.toUpperCase(), b), alice.privateKey),
    ).rejects.toThrow(/delegator_public_key must be canonical/);
    await expect(
      signStandingDelegation(body(a, b.toUpperCase()), alice.privateKey),
    ).rejects.toThrow(/delegate_public_key must be canonical/);
  });

  it("signDelegation refuses a non-canonical delegator or delegate key", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const a = bytesToHex(alice.publicKey);
    const b = bytesToHex(bob.publicKey);
    const body = (delegator_public_key: string, delegate_public_key: string) => ({
      delegator_id: "mote-alice",
      delegator_public_key,
      delegate_id: "mote-bob",
      delegate_public_key,
      scope: "web.search",
      issued_at: NOW,
      expires_at: NOW + HOUR,
    });
    await expect(signDelegation(body(a, b), alice.privateKey)).resolves.toBeDefined();
    await expect(signDelegation(body(a.toUpperCase(), b), alice.privateKey)).rejects.toThrow(
      /delegator_public_key must be canonical/,
    );
    await expect(signDelegation(body(a, `${b.slice(0, 63)}g`), alice.privateKey)).rejects.toThrow(
      /delegate_public_key must be canonical/,
    );
  });

  it("a grant whose delegator key is spelled in UPPERCASE does not verify (the delegator's canonical revocation could never bind it)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const upper = bytesToHex(alice.publicKey).toUpperCase();
    const grant = await makeGrant(alice, bob, { delegator: upper });
    expect(await verifyStandingDelegation(grant, { now: NOW })).toBe(false);
  });

  it("a grant whose delegate key is not canonical does not verify", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob, {
      delegate: bytesToHex(bob.publicKey).toUpperCase(),
    });
    expect(await verifyStandingDelegation(grant, { now: NOW })).toBe(false);
  });

  it("a grant whose delegator key is a NON-HEX alias does not verify", async () => {
    const { kp: alice, alias } = await keypairWithNonHexAlias();
    const bob = await generateKeypair();
    const grant = await makeGrant(alice, bob, { delegator: alias });
    expect(await verifyStandingDelegation(grant, { now: NOW })).toBe(false);
  });

  it("a delegation token whose delegator or delegate key is not canonical does not verify", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const a = bytesToHex(alice.publicKey);
    const b = bytesToHex(bob.publicKey);
    const tick = (delegator_public_key: string, delegate_public_key: string) =>
      handSign<Omit<DelegationToken, "signature" | "suite">>(
        {
          delegator_id: "mote-alice",
          delegator_public_key,
          delegate_id: "mote-bob",
          delegate_public_key,
          scope: "web.search",
          issued_at: NOW,
          expires_at: NOW + HOUR,
        },
        alice.privateKey,
      );
    expect(await verifyDelegation(await tick(a, b), { now: NOW })).toBe(true); // control
    expect(await verifyDelegation(await tick(a.toUpperCase(), b), { now: NOW })).toBe(false);
    expect(await verifyDelegation(await tick(a, b.toUpperCase()), { now: NOW })).toBe(false);
  });

  it("verdict: an UPPERCASE-key grant the delegator revoked canonically is never isFullyVerified", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const upper = bytesToHex(alice.publicKey).toUpperCase();
    const grant = await makeGrant(alice, bob, { delegator: upper });
    const token = await handSign<Omit<DelegationToken, "signature" | "suite">>(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: grant.delegate_id,
        delegate_public_key: grant.delegate_public_key,
        scope: "web.search",
        issued_at: NOW,
        expires_at: NOW + HOUR,
        grant_id: grant.grant_id,
      },
      alice.privateKey,
    );
    // The delegator's own, canonical revocation (what signDelegationRevocation emits).
    const rev = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: bytesToHex(alice.publicKey),
        revoked_at: NOW - 500,
      },
      alice.privateKey,
    );
    const v = await verifyDelegationTokenVerdict(token, grant, { revocations: [rev], now: NOW });
    expect(isFullyVerified(v)).toBe(false);
  });
});
