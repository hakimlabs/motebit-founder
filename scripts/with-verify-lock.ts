/**
 * with-verify-lock — run a command under the machine-wide verification lock
 * (`scripts/lib/verify-lock.ts`).
 *
 *   npx tsx scripts/with-verify-lock.ts <holder> -- <command> [args…]
 *
 * Waits for the lock, runs the command with `MOTEBIT_VERIFY_LOCK_PID` set (so
 * anything it spawns that also asks for the lock passes straight through),
 * forwards stdin/stdout/stderr and SIGINT/SIGTERM, releases the lock, and
 * exits with the command's code. The pre-push hook re-runs itself through
 * this; wrap any other CPU-heavy verification (a tamper run, a full suite) the
 * same way.
 */

import { spawn } from "node:child_process";

import { cleanEnv } from "./lib/differential-tree.js";
import { acquireVerifyLock } from "./lib/verify-lock.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep !== 1 || argv.length < 3) {
    process.stderr.write("usage: with-verify-lock.ts <holder> -- <command> [args…]\n");
    process.exit(64);
  }
  const holder = argv[0]!;
  const [cmd, ...args] = argv.slice(sep + 1);

  let release: () => void;
  try {
    release = await acquireVerifyLock(holder);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(75);
  }

  // No inherited GIT_* reaches the command (#835): the pre-push hook scrubs
  // before it re-runs itself here, and this spawn scrubs again for any caller.
  const child = spawn(cmd!, args, { stdio: "inherit", env: cleanEnv(process.env) });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("error", (err) => {
    release();
    process.stderr.write(`✗ ${holder}: could not start ${cmd}: ${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    release();
    process.exit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
  });
}

void main();
