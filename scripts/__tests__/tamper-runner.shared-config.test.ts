/**
 * tamper-runner against the REPO'S OWN vitest config (vitest.shared.ts).
 *
 * The other self-tests drive the runner over fixture packages with bare vitest
 * configs, so none of them saw #1062 add `["json", { outputFile:
 * TEST_RESULTS_FILE }]` to MOTEBIT_TEST_REPORTERS: a CLI `--reporter=json`
 * keeps a config's options for a reporter of the same name, the config's
 * outputFile beat the runner's `--outputFile.json`, and from then on every
 * vitest-mode tamper file in the repo aborted at baseline ("vitest wrote no
 * JSON report"). This test builds a package whose `vitest.config.ts` is the
 * real shape — `defineMotebitTest` from a byte-for-byte copy of the CURRENT
 * vitest.shared.ts and vitest.real-model-guard.ts — and runs one vitest-mode
 * tamper through the real runner. Whatever a future change does to the
 * shared reporters, a runner that cannot read its own evidence under them
 * goes red here, in `pnpm test:gates`.
 *
 * The red name is a NESTED describe path, so the RED also proves the runner's
 * report keeps vitest's JSON-reporter full names (describe path + title,
 * space-joined) — the names every tamper file's `red:` is written in.
 *
 * Proven to bite: scripts/tampers/tamper-runner-shared-config.ts restores the
 * pre-fix `--reporter=json --outputFile.json` mechanism and sees this red.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drive, git, setupFixture, teardownFixture, verdicts } from "./tamper-runner.harness";
import type { Fx } from "./tamper-runner.harness";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const MONOREPO = resolve(__dirname, "../..");
const PKG = "shared-config";
const RED_NAME = "value under the shared config answers 42";

let fx: Fx | undefined;
beforeEach(async () => {
  fx = await setupFixture();
  const repo = fx.repo;
  // The shared config itself, as the monorepo has it NOW.
  for (const f of ["vitest.shared.ts", "vitest.real-model-guard.ts"]) {
    copyFileSync(join(MONOREPO, f), join(repo, f));
  }
  const pkg = join(repo, "packages", PKG);
  mkdirSync(join(pkg, "src/__tests__"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: PKG, private: true, type: "module" }, null, 2)}\n`,
  );
  // A real package's config, spelled the way the workspace's are.
  writeFileSync(
    join(pkg, "vitest.config.ts"),
    'import { defineMotebitTest } from "../../vitest.shared.js";\n\n' +
      "export default defineMotebitTest({\n" +
      "  thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },\n" +
      "});\n",
  );
  writeFileSync(join(pkg, "src/value.ts"), "export function value(): number {\n  return 42;\n}\n");
  writeFileSync(
    join(pkg, "src/__tests__/value.test.ts"),
    'import { describe, expect, it } from "vitest";\n\n' +
      'import { value } from "../value.js";\n\n' +
      'describe("value", () => {\n' +
      '  describe("under the shared config", () => {\n' +
      '    it("answers 42", () => {\n' +
      "      expect(value()).toBe(42);\n" +
      "    });\n" +
      "  });\n" +
      '  it("is a number", () => {\n' +
      '    expect(typeof value()).toBe("number");\n' +
      "  });\n" +
      "});\n",
  );
  git(fx, ["add", "-A"]);
  git(fx, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "shared-config package",
  ]);
});
afterEach(() => {
  teardownFixture(fx);
  fx = undefined;
});

describe("tamper-runner under vitest.shared.ts", () => {
  it("a vitest-mode tamper on a package using defineMotebitTest reads its own report and goes RED on the exact nested name", () => {
    const d = drive(
      fx!,
      [
        {
          name: "value answers 41",
          pkg: PKG,
          test: "src/__tests__/value.test.ts",
          red: RED_NAME,
          edits: [{ file: `packages/${PKG}/src/value.ts`, from: "return 42;", to: "return 41;" }],
        },
      ],
      1,
    );
    expect(d.out).not.toContain("BASELINE NOT GREEN");
    expect(d.out).not.toContain("wrote no JSON report");
    expect(verdicts(d), d.out).toEqual(["RED"]);
    expect(d.out).toMatch(/^RED \(ok\) +value answers 41$/m);
    expect(d.code).toBe(0);
  });
});
