/**
 * security-publish — every refusal of the plan check behind release.yml's
 * `security-publish` job, and the publish authority of every workflow: the
 * only jobs that can publish to npm (an id-token, a publish command, or a
 * changesets `publish:` input) are the two in release.yml that wait in the
 * founder-approved `npm-publish` environment. An ordinary push to main runs
 * only the prepare job, which has neither.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { parse } from "yaml";

import type { PublishablePackage, RegistryAnswer } from "../lib/publish-freshness.js";
import { packagesAhead, parsePackageList, planSecurityPublish } from "../lib/security-publish.js";

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

  it("a rehearsal (dry run) accepts a version equal to latest, and nothing else extra", () => {
    const plan = planSecurityPublish(["@m/sdk"], workspace, registry, { rehearsal: true });
    expect(plan).toMatchObject({ ok: true, packages: [{ name: "@m/sdk", previous: "2.10.0" }] });
    const behind = new Map(registry).set("@m/sdk", published("2.11.0"));
    expect(planSecurityPublish(["@m/sdk"], workspace, behind, { rehearsal: true }).ok).toBe(false);
    const absent = new Map(registry).set("@m/sdk", { kind: "absent" });
    expect(planSecurityPublish(["@m/sdk"], workspace, absent, { rehearsal: true }).ok).toBe(false);
  });

  it("packagesAhead lists behind and never-published packages, and refuses to guess", () => {
    expect(packagesAhead(workspace, registry)).toEqual([
      "@m/crypto@4.0.1",
      "@m/verifier@1.14.2",
      "cli@2.2.2",
    ]);
    const first = new Map(registry).set("@m/sdk", { kind: "absent" });
    expect(packagesAhead(workspace, first)).toContain("@m/sdk@2.10.0");
    const down = new Map(registry).set("@m/sdk", { kind: "unreachable", detail: "x" });
    expect(packagesAhead(workspace, down)).toBeNull();
  });

  it("splits the dispatch input on spaces and commas", () => {
    expect(parsePackageList(" @m/crypto,@m/verifier \n cli ")).toEqual([
      "@m/crypto",
      "@m/verifier",
      "cli",
    ]);
  });
});

interface Job {
  if?: string;
  environment?: string | { name?: string };
  permissions?: Record<string, string> | string;
  needs?: string | string[];
  steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
}

const wf = join(__dirname, "..", "..", ".github", "workflows");
const workflows = readdirSync(wf)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const text = readFileSync(join(wf, file), "utf8");
    const doc = parse(text) as { jobs?: Record<string, Job>; concurrency?: unknown };
    return { file, text, doc };
  });
const release = workflows.find((w) => w.file === "release.yml")!;
const jobs = release.doc.jobs!;

const PUBLISH_COMMAND = /\b(npm|pnpm|changeset)\b(\s+--?\S+(\s+[^-\s]\S*)?)*\s+(publish|release)\b/;
function envName(job: Job): string | undefined {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}
function canPublish(job: Job): string[] {
  const why: string[] = [];
  const perms = job.permissions;
  if (perms === "write-all" || (typeof perms === "object" && perms["id-token"] === "write"))
    why.push("id-token: write");
  for (const step of job.steps ?? []) {
    const lines = (step.run ?? "").split("\n").filter((l) => !/^\s*#/.test(l));
    if (lines.some((l) => PUBLISH_COMMAND.test(l))) why.push(`publishes in "${step.name}"`);
    if (step.uses?.startsWith("changesets/action") && step.with && "publish" in step.with)
      why.push(`changesets publish: in "${step.name}"`);
  }
  return why;
}

describe("publish authority across every workflow", () => {
  it("every job able to publish to npm waits in the npm-publish environment", () => {
    const unapproved = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([, job]) => envName(job) !== "npm-publish")
        // publish-images signs container images with cosign keyless (Sigstore
        // OIDC), which needs id-token; it has no npm publish path.
        .filter(([name]) => !(file === "publish-images.yml" && name === "relay"))
        .map(([name, job]) => ({ job: `${file}:${name}`, why: canPublish(job) }))
        .filter((j) => j.why.length > 0),
    );
    expect(unapproved).toEqual([]);
  });

  it("publish-images is exempt only because it publishes nothing to npm", () => {
    const images = workflows.find((w) => w.file === "publish-images.yml")!;
    for (const job of Object.values(images.doc.jobs ?? {}))
      expect(canPublish(job).filter((w) => w !== "id-token: write")).toEqual([]);
  });

  it("only release.yml's train-publish and security-publish jobs are in npm-publish", () => {
    const inEnv = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([, job]) => envName(job) === "npm-publish")
        .map(([name]) => `${file}:${name}`),
    );
    expect(inEnv.sort()).toEqual(["release.yml:security-publish", "release.yml:train-publish"]);
  });

  it("a push runs prepare, which cannot publish; train-publish follows it, never in version mode", () => {
    expect(jobs.release!.if).toBe("github.event_name == 'push'");
    expect(canPublish(jobs.release!)).toEqual([]);
    expect(jobs["train-publish"]!.needs).toBe("release");
    expect(jobs["train-publish"]!.if).toBe(
      "needs.release.outputs.state != 'version-mode' && needs.release.outputs.ahead != '0'",
    );
  });

  it("a dispatch runs only security-publish, read-only on contents", () => {
    expect(jobs["security-publish"]!.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(jobs["security-publish"]!.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
  });

  it("push runs and dispatches never share a concurrency group", () => {
    expect(release.doc.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}",
      "cancel-in-progress": false,
    });
  });

  it("the security job never versions or publishes changesets, and uses no remote build cache", () => {
    const job = jobs["security-publish"]! as Job & { env?: Record<string, string> };
    const runs = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/changeset/);
    expect(job.env?.TURBO_TOKEN).toBe("");
    expect(job.env).not.toHaveProperty("NODE_AUTH_TOKEN");
  });

  it("release.yml's dispatch inputs reach run scripts only through the environment", () => {
    for (const { file, doc } of [release])
      for (const [name, job] of Object.entries(doc.jobs ?? {}))
        for (const step of job.steps ?? [])
          expect({ at: `${file}:${name}:${step.name}`, run: step.run ?? "" }).not.toMatchObject({
            run: expect.stringMatching(/\$\{\{[^}]*\binputs\./),
          });
  });
});
