/**
 * Tamper checks for "the tamper runner owns where its vitest report goes" —
 * each removal, applied alone, must turn the named test red.
 *
 *   1. The pre-fix mechanism restored: vitest's own `--reporter=json` with
 *      `--outputFile.json=<runner path>`, and the runner's reporter no longer
 *      writing the per-test report. Under vitest.shared.ts the config's
 *      `["json", { outputFile: TEST_RESULTS_FILE }]` wins (#1062), the
 *      runner's report is never written and every vitest-mode tamper aborts
 *      at baseline — what every such tamper file in the repo did from #1062
 *      until this fix.
 *   2. The runner's report drops the describe path from a test's full name:
 *      a `red:` written as vitest's JSON reporter names the test (describe
 *      path + title) no longer matches anything.
 *
 *   node scripts/tampers/tamper-runner-shared-config.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = "scripts/lib/tamper-runner.ts";
const TEST = {
  test: "scripts/__tests__/tamper-runner.shared-config.test.ts",
  red: "tamper-runner under vitest.shared.ts a vitest-mode tamper on a package using defineMotebitTest reads its own report and goes RED on the exact nested name",
};

const TAMPERS: TamperEntry[] = [
  {
    name: "1 vitest's json reporter + --outputFile.json (the pre-fix mechanism) restored",
    ...TEST,
    edits: [
      {
        file: RUNNER,
        from: "    writeFileSync(process.env.TAMPER_RUNNER_JSON, JSON.stringify(jsonReport(modules)));\n",
        to: "",
      },
      {
        file: RUNNER,
        from: "    `--reporter=${reporterPath}`,\n  );",
        to: '    "--reporter=json",\n    `--outputFile.json=${jsonPath}`,\n    `--reporter=${reporterPath}`,\n  );',
      },
    ],
  },
  {
    name: "2 the report's full name drops the describe path",
    ...TEST,
    edits: [
      {
        file: RUNNER,
        from: 'fullName: t.name ? [...ancestorTitles, t.name].join(" ") : ancestorTitles.join(" "),',
        to: 'fullName: t.name ? t.name : ancestorTitles.join(" "),',
      },
    ],
  },
];

void runTampers(TAMPERS, { root: ROOT });
