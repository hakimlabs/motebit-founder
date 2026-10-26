#!/usr/bin/env node
// Tamper check for dispute-evidence-window-guarantee.test.ts.
//
// Each entry reverts (part of) one fix and names the test expected to go red.
// The shared runner (scripts/lib/tamper-runner.ts) applies each tamper in an
// isolated copy of the tree and fails if a tamper did not apply or the named
// test stayed green.
//
//   node services/relay/src/__tests__/dispute-evidence-window-guarantee.tampers.mjs
//
// Run from anywhere; paths resolve relative to this file.

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const DISPUTES = join(pkg, "src", "disputes.ts");
const MIDDLEWARE = join(pkg, "src", "middleware.ts");
const TEST = join(here, "dispute-evidence-window-guarantee.test.ts");

const RESOLVE = "dispute /resolve is refused while the evidence window is open (§5.3)";
const FREEZE = "the emergency freeze does not consume the evidence window (rule 30, §5.4)";

const TAMPERS = [
  {
    name: "the /resolve evidence-window check removed",
    file: DISPUTES,
    text: "    if (Date.now() < evidenceDeadline) {",
    replacement: "    if ((false as boolean) && Date.now() < evidenceDeadline) {",
    red: `${RESOLVE} a resolve before evidence_deadline is 409 DISPUTE_EVIDENCE_WINDOW_OPEN and changes no state and no money`,
  },
  {
    name: "the /resolve evidence-window check removed (federation path)",
    file: DISPUTES,
    text: "    if (Date.now() < evidenceDeadline) {",
    replacement: "    if ((false as boolean) && Date.now() < evidenceDeadline) {",
    red: `${RESOLVE} the federation path (the relay is a party) is refused too, before the arbitration transition or any orchestration row`,
  },
  {
    name: "the window closes one millisecond late (<= instead of <)",
    file: DISPUTES,
    text: "    if (Date.now() < evidenceDeadline) {",
    replacement: "    if (Date.now() <= evidenceDeadline) {",
    red: `${RESOLVE} the window is measured on the relay's clock: refused at deadline − 1 ms, resolved at the deadline`,
  },
  {
    name: "the freeze exemption for the evidence POST removed",
    file: MIDDLEWARE,
    text: '    if (c.req.method === "POST" && DISPUTE_EVIDENCE_PATH.test(c.req.path)) {',
    replacement:
      '    if ((false as boolean) && c.req.method === "POST" && DISPUTE_EVIDENCE_PATH.test(c.req.path)) {',
    red: `${FREEZE} evidence POST under an active freeze is accepted and recorded`,
  },
  {
    name: "the exemption widened to every dispute route (resolve passes the freeze)",
    file: MIDDLEWARE,
    text: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\/[^/]+\\/evidence$/;",
    replacement: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\//;",
    red: `${FREEZE} resolve under an active freeze is still refused 503, with the evidence window closed`,
  },
  {
    name: "the exemption widened to every dispute route (appeal passes the freeze)",
    file: MIDDLEWARE,
    text: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\/[^/]+\\/evidence$/;",
    replacement: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\//;",
    red: `${FREEZE} appeal under an active freeze is still refused 503`,
  },
  {
    name: "the exemption widened to a prefix (filing passes the freeze)",
    file: MIDDLEWARE,
    text: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\/[^/]+\\/evidence$/;",
    replacement: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/(disputes|allocations)\\//;",
    red: `${FREEZE} filing under an active freeze is still refused 503`,
  },
  {
    name: "the exemption unanchored (a lookalike path passes the freeze)",
    file: MIDDLEWARE,
    text: "const DISPUTE_EVIDENCE_PATH = /^\\/api\\/v1\\/disputes\\/[^/]+\\/evidence$/;",
    replacement: "const DISPUTE_EVIDENCE_PATH = /\\/evidence/;",
    red: `${FREEZE} the exemption is the evidence route only: a lookalike path under the freeze is still refused 503`,
  },
];

// Run as a command with a red marker, not as a vitest entry: the relay's vitest
// config pins the JSON reporter's outputFile, so the runner's own report is
// never written (the precedent is services/relay/tamper/*.mjs). `-t`, anchored
// to the exact full name, narrows each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name,
    command: [
      "pnpm",
      "--filter",
      "@motebit/relay",
      "exec",
      "vitest",
      "run",
      relative(pkg, TEST),
      "-t",
      `^${escapeRegExp(t.red)}$`,
    ],
    redMarker: "Test Files  1 failed",
    edits: [{ file: t.file, from: t.text, to: t.replacement }],
  })),
  { root: here },
);
