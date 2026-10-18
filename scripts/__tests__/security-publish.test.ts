/**
 * security-publish — every refusal of the plan check behind release.yml's
 * `security-publish` job, plus the job's own wiring: dispatch-only, in the
 * `npm-publish` environment, the train never on a dispatch, inputs reaching
 * shell only through the environment, and no other workflow holding an npm
 * publish path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { PublishablePackage, RegistryAnswer } from "../lib/publish-freshness.js";
import { parsePackageList, planSecurityPublish } from "../lib/security-publish.js";

function pkg(name: string, version: string, deps: Record<string, string> = {}): PublishablePackage {
  return { name, version, dir: `packages/${name}`, raw: { name, version, dependencies: deps } };
}

const crypto = pkg("@m/crypto", "4.0.1");
const verifier = pkg("@m/verifier", "1.14.2", { "@m/crypto": "workspace:*" });
const sdk = pkg("@m/sdk", "2.10.0");
const cli = pkg("cli", "2.2.2", { "@m/verifier": "workspace:^", "@m/sdk": "workspace:*" });
const workspace = [crypto, verifier, sdk, cli];

const published = (latest: string): RegistryAnswer => ({ kind: "published", latest });
const registry = new Map<string, RegistryAnswer>([
  ["@m/crypto", published("4.0.0")],
  ["@m/verifier", published("1.14.1")],
  ["@m/sdk", published("2.10.0")],
  ["cli", published("2.2.1")],
]);

function refusals(requested: string[], reg = registry, ws = workspace): string[] {
  const plan = planSecurityPublish(requested, ws, reg);
  return plan.ok ? [] : plan.refusals;
}

describe("planSecurityPublish", () => {
  it("accepts a dependency-ordered patch and records what it replaces", () => {
    const plan = planSecurityPublish(["@m/crypto", "@m/verifier", "cli"], workspace, registry);
    expect(plan).toEqual({
      ok: true,
      packages: [
        { name: "@m/crypto", version: "4.0.1", dir: "packages/@m/crypto", previous: "4.0.0" },
        { name: "@m/verifier", version: "1.14.2", dir: "packages/@m/verifier", previous: "1.14.1" },
        { name: "cli", version: "2.2.2", dir: "packages/cli", previous: "2.2.1" },
      ],
    });
  });

  it("refuses an empty list and a duplicate", () => {
    expect(refusals([])).toEqual(["the package list is empty"]);
    expect(refusals(["@m/crypto", "@m/crypto"])).toContain("@m/crypto is listed twice");
  });

  it("refuses a package that is not public in the workspace", () => {
    expect(refusals(["@m/market"])).toEqual(["@m/market is not a public workspace package"]);
  });

  it("refuses a version that is current, behind the registry, or a pre-release", () => {
    expect(refusals(["@m/sdk"])[0]).toMatch(/not ahead of the registry \(latest 2\.10\.0\)/);
    const ahead = new Map(registry).set("@m/crypto", published("4.1.0"));
    expect(refusals(["@m/crypto"], ahead)[0]).toMatch(/not ahead of the registry/);
    const pre = [pkg("@m/crypto", "4.0.1-rc.1"), verifier, sdk, cli];
    expect(refusals(["@m/crypto"], registry, pre)).toContain(
      "@m/crypto@4.0.1-rc.1 is not a plain x.y.z release",
    );
  });

  it("refuses a first publish and an unclean registry answer", () => {
    const absent = new Map(registry).set("@m/crypto", { kind: "absent" });
    expect(refusals(["@m/crypto"], absent)[0]).toMatch(/never been published/);
    const down = new Map(registry).set("@m/crypto", { kind: "unreachable", detail: "HTTP 503" });
    expect(refusals(["@m/crypto"], down)[0]).toMatch(/did not answer cleanly \(HTTP 503\)/);
    expect(refusals(["@m/crypto"], new Map())[0]).toMatch(/not asked/);
  });

  it("refuses a dependency listed after its dependent", () => {
    expect(refusals(["@m/verifier", "@m/crypto"])).toEqual([
      "@m/verifier depends on @m/crypto, so @m/crypto must be listed before it",
    ]);
  });

  it("refuses an unlisted dependency the registry has not got at the workspace version", () => {
    expect(refusals(["@m/verifier"])[0]).toMatch(
      /depends on @m\/crypto@4\.0\.1, which is not listed and is not the registry's latest \(4\.0\.0\)/,
    );
  });

  it("accepts an unlisted dependency that is current on the registry", () => {
    expect(refusals(["@m/crypto", "@m/verifier", "cli"])).toEqual([]); // @m/sdk unlisted, current
  });

  it("ignores non-workspace and private dependencies", () => {
    const ws = [
      pkg("@m/crypto", "4.0.1", { "@noble/ed25519": "^2.0.0", "@m/private": "workspace:*" }),
    ];
    expect(refusals(["@m/crypto"], registry, ws)).toEqual([]);
  });

  it("splits the dispatch input on spaces and commas", () => {
    expect(parsePackageList(" @m/crypto,@m/verifier \n cli ")).toEqual([
      "@m/crypto",
      "@m/verifier",
      "cli",
    ]);
  });
});

describe("the workflow wiring", () => {
  const wf = join(__dirname, "..", "..", ".github", "workflows");
  const release = readFileSync(join(wf, "release.yml"), "utf8");
  const job = release.slice(release.indexOf("\n  security-publish:"));

  it("the train runs only on push, the security job only on dispatch, in npm-publish", () => {
    expect(release).toMatch(/\n  release:\n    if: github\.event_name == 'push'\n/);
    expect(job).toMatch(/\n    if: github\.event_name == 'workflow_dispatch'\n/);
    expect(job).toMatch(/\n    environment: npm-publish\n/);
    expect(job).toMatch(/permissions:\n      contents: read\n      id-token: write\n/);
  });

  it("push runs and dispatches never share a concurrency group", () => {
    expect(release).toMatch(
      /\nconcurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name \}\}\n/,
    );
  });

  it("never versions or publishes changesets, and uses no remote build cache", () => {
    expect(job).not.toMatch(/changeset/);
    expect(job).toMatch(/TURBO_TOKEN: ""/);
    expect(job).not.toMatch(/^\s*NODE_AUTH_TOKEN\s*:/m);
  });

  it("dispatch inputs reach run scripts only through the environment", () => {
    const runBlocks = job.split(/\n\s+- (?:name|uses):/).filter((s) => /\brun:/.test(s));
    for (const block of runBlocks)
      expect(block.slice(block.indexOf("run:"))).not.toMatch(/\$\{\{[^}]*\binputs\./);
  });

  it("no other workflow holds an npm publish path", () => {
    const others = readdirSync(wf)
      .filter((f) => f !== "release.yml" && /\.ya?ml$/.test(f))
      .filter((f) =>
        readFileSync(join(wf, f), "utf8")
          .split("\n")
          .filter((line) => !/^\s*#/.test(line))
          .some((line) =>
            /\b(npm|pnpm|changeset)\b(\s+--?\S+(\s+[^-\s]\S*)?)*\s+publish\b/.test(line),
          ),
      );
    expect(others).toEqual([]);
  });
});
