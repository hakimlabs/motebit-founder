#!/usr/bin/env node
/**
 * #1147 tamper checks for the two tamper-runner self-tests that failed under
 * the pre-push hook's load (2026-10-25). Each fix must still guard what it
 * guards: revert it, and the named self-test goes red.
 *
 *   node scripts/__tests__/tamper-runner.load-tampers.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers } from "../lib/tamper-runner.ts";
import type { TamperEntry } from "../lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));

const TAMPERS: TamperEntry[] = [
  {
    name: "C1's FX_PORT comes from listen(0) again (the ephemeral range another process can be handed)",
    test: "scripts/__tests__/tamper-runner.isolation.test.ts",
    red: "tamper-runner isolation C1: the fixed port is one the kernel never hands out by itself (below the ephemeral range)",
    edits: [
      {
        file: "scripts/__tests__/tamper-runner.harness.ts",
        from: "    port: await fixedPort(),",
        to:
          "    port: await new Promise<number>((res) => {\n" +
          "      const s = createServer();\n" +
          '      s.listen(0, "127.0.0.1", () => {\n' +
          "        const a = s.address();\n" +
          '        s.close(() => res(typeof a === "object" && a != null ? a.port : 0));\n' +
          "      });\n" +
          "    }),",
      },
    ],
  },
  {
    name: "only: the narrowing (-t) matches no test, so the narrowed red test never runs",
    test: "scripts/__tests__/tamper-runner.test.ts",
    red: "tamper-runner evidence only: the narrowed red test still runs, and its failure is a RED",
    edits: [
      {
        file: "scripts/lib/tamper-runner.ts",
        from: 'if (only != null) args.push("-t", `^${escapeRegExp(only)}$`);',
        to: 'if (only != null) args.push("-t", `^${escapeRegExp(only)} NEVER$`);',
      },
    ],
  },
];

// Each self-test builds its own fixture, so each entry runs only its red test.
await runTampers(
  TAMPERS.map((t) => ({ ...t, only: true })),
  { root: here },
);
