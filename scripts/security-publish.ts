#!/usr/bin/env tsx
/**
 * security-publish — the three steps release.yml's `security-publish` job runs
 * around `npm publish`. See `scripts/lib/security-publish.ts` for what makes a
 * list publishable.
 *
 *   plan    PACKAGES (env) → <out>/plan.json, or exit 1 with every refusal.
 *   pack    <out>/plan.json → one tarball per package + <out>/artifacts.json
 *           (name, version, tarball, sha512 integrity). Refuses a tarball whose
 *           manifest is not the planned name@version or still says `workspace:`.
 *   verify  <out>/artifacts.json → polls the registry until each version is
 *           served with EXACTLY the integrity that was packed and carries a
 *           provenance attestation, then installs them all into an empty
 *           project and runs `npm audit signatures`.
 *
 * Inputs arrive through the environment, never through the command line the
 * workflow assembles, so a dispatch input cannot become shell.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  askRegistry,
  publishablePackages,
  workspaceGlobs,
  type RegistryAnswer,
} from "./lib/publish-freshness.js";
import {
  parsePackageList,
  planSecurityPublish,
  registryQuestions,
  type PlannedPackage,
} from "./lib/security-publish.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const REGISTRY = "https://registry.npmjs.org";

interface Artifact {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
}

function fail(lines: string[]): never {
  for (const line of lines) console.error(`  ✗ ${line}`);
  process.exit(1);
}

function outDir(): string {
  const dir = process.argv[3];
  if (!dir) fail(["usage: security-publish.ts <plan|pack|verify> <out-dir>"]);
  mkdirSync(dir, { recursive: true });
  return resolve(dir);
}

async function plan(out: string): Promise<void> {
  const requested = parsePackageList(process.env.PACKAGES ?? "");
  const workspace = publishablePackages(REPO_ROOT, workspaceGlobs(REPO_ROOT));
  const registry = new Map<string, RegistryAnswer>();
  for (const name of registryQuestions(requested, workspace))
    registry.set(name, await askRegistry(REGISTRY, name, fetch));
  const result = planSecurityPublish(requested, workspace, registry);
  if (!result.ok) {
    console.error(`Refusing to publish ${requested.join(" ") || "(nothing)"}:`);
    fail(result.refusals);
  }
  for (const p of result.packages) console.log(`  ✓ ${p.name} ${p.previous} → ${p.version}`);
  writeFileSync(join(out, "plan.json"), JSON.stringify(result.packages, null, 2));
}

function pack(out: string): void {
  const planned = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as PlannedPackage[];
  const artifacts: Artifact[] = [];
  const problems: string[] = [];
  for (const p of planned) {
    const dest = join(out, "tarballs", p.name.replace("/", "__"));
    mkdirSync(dest, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", dest], {
      cwd: join(REPO_ROOT, p.dir),
      stdio: ["ignore", "inherit", "inherit"],
    });
    const files = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
    if (files.length !== 1) {
      problems.push(`${p.name}: expected one tarball, found ${files.length}`);
      continue;
    }
    const tarball = join(dest, files[0]!);
    const manifestText = execFileSync("tar", ["-xzOf", tarball, "package/package.json"], {
      encoding: "utf8",
    });
    const manifest = JSON.parse(manifestText) as { name?: string; version?: string };
    if (manifest.name !== p.name || manifest.version !== p.version)
      problems.push(
        `${p.name}: the tarball says ${manifest.name}@${manifest.version}, the plan says ${p.version}`,
      );
    if (manifestText.includes("workspace:"))
      problems.push(`${p.name}: the packed manifest still contains a workspace: range`);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    console.log(`  ✓ ${p.name}@${p.version} ${integrity}`);
    artifacts.push({ name: p.name, version: p.version, tarball, integrity });
  }
  if (problems.length > 0) fail(problems);
  writeFileSync(join(out, "artifacts.json"), JSON.stringify(artifacts, null, 2));
}

function npmDist(
  name: string,
  version: string,
): { integrity?: string; provenance: boolean } | null {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "dist", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dist = JSON.parse(out) as {
      integrity?: string;
      attestations?: { provenance?: { predicateType?: string } };
    };
    return {
      integrity: dist.integrity,
      provenance: !!dist.attestations?.provenance?.predicateType,
    };
  } catch {
    return null;
  }
}

async function verify(out: string): Promise<void> {
  const artifacts = JSON.parse(readFileSync(join(out, "artifacts.json"), "utf8")) as Artifact[];
  const problems: string[] = [];
  for (const a of artifacts) {
    let dist = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      dist = npmDist(a.name, a.version);
      if (dist?.integrity) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!dist?.integrity) problems.push(`${a.name}@${a.version} is not served after 300s`);
    else if (dist.integrity !== a.integrity)
      problems.push(
        `${a.name}@${a.version} is served with ${dist.integrity}, but ${a.integrity} was packed`,
      );
    else if (!dist.provenance)
      problems.push(`${a.name}@${a.version} is served without a provenance attestation`);
    else console.log(`  ✓ ${a.name}@${a.version} served as packed, with provenance`);
  }
  if (problems.length > 0) fail(problems);

  const project = mkdtempSync(join(tmpdir(), "security-publish-verify-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "verify", private: true }));
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      ...artifacts.map((a) => `${a.name}@${a.version}`),
    ],
    { cwd: project, stdio: "inherit" },
  );
  execFileSync("npm", ["audit", "signatures"], { cwd: project, stdio: "inherit" });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const out = outDir();
  if (mode === "plan") await plan(out);
  else if (mode === "pack") pack(out);
  else if (mode === "verify") await verify(out);
  else fail([`unknown mode ${mode ?? "(none)"}; expected plan, pack or verify`]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
