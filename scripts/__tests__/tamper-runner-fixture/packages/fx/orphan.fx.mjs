// Binds the port the self-test hands it (FX_PORT), then leaves a process
// behind that holds that port for FX_HOLD ms: in the test's own process group,
// or (FX_PGRP=1) in a process group of its own inside the test's session
// (setpgid, through perl: what a job-control shell or a native pnpm does to
// the command it runs), or (FX_DETACH=1) in a session of its own. Each
// holder's pid is appended to FX_STATE-orphans; with FX_PGRP, "<pid> <pgid>"
// as perl saw them just before it exec'd node, to FX_STATE-pgrp. The next run
// of this file fails to bind while one lives.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("binds the port, then leaves a holder behind", async () => {
  const port = Number(process.env.FX_PORT);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => server.close(r));
  const node = [
    process.execPath,
    "-e",
    `require("node:net").createServer().listen(${port}, "127.0.0.1");` +
      `setTimeout(() => process.exit(0), ${Number(process.env.FX_HOLD ?? 1500)});`,
  ];
  const holder =
    process.env.FX_PGRP === "1"
      ? spawn(
          "perl",
          [
            "-e",
            "setpgrp(0, 0) or die $!; open(my $f, '>>', $ENV{FX_PGRP_FILE}) or die $!; " +
              'print $f "$$ " . getpgrp() . "\\n"; close($f); exec { $ARGV[0] } @ARGV or die $!',
            ...node,
          ],
          {
            stdio: "ignore",
            env: { ...process.env, FX_PGRP_FILE: `${process.env.FX_STATE}-pgrp` },
          },
        )
      : spawn(process.execPath, node.slice(1), {
          detached: process.env.FX_DETACH === "1",
          stdio: "ignore",
        });
  holder.unref();
  appendFileSync(`${process.env.FX_STATE}-orphans`, `${holder.pid}\n`);
  expect(sum(2, 3)).toBe(5);
});
