/**
 * verify-lock — one CPU-heavy verification run per MACHINE at a time.
 *
 * Why a lock and not a note: on 2026-10-25 three pushes in a row failed their
 * pre-push hook for one reason — two full verification runs (a pre-push suite
 * and a second push's suite, or a tamper run) shared one Mac, and wall-clock
 * bounded tests timed out under the combined load (#1147). Each failure cost
 * a 15–35 minute rerun. "Don't run two at once" was remembered, then
 * forgotten; it has to be enforced.
 *
 * Sibling of `probe-lock.ts`, not a mode of it. probe-lock is about
 * CORRECTNESS inside one working tree (a probe mutates files a reader must
 * not see), so it is per repo root and refuses at once. This lock is about
 * LOAD across every worktree on the machine, so it lives outside any tree and
 * WAITS: a second push queues behind the first instead of failing. Editing,
 * building lanes in other worktrees and cheap commands are never serialized —
 * only what a caller wraps.
 *
 * Mechanics are probe-lock's: one file created with O_EXCL (atomic); its
 * contents name the holder and pid; a lock whose pid is gone is stale and is
 * reclaimed; processes the holder spawns inherit `MOTEBIT_VERIFY_LOCK_PID` and
 * pass straight through (the pre-push hook re-runs itself under the lock).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERIFY_LOCK_ENV = "MOTEBIT_VERIFY_LOCK_PID";
/** Override the lock path (tests, or a machine that wants it elsewhere). */
export const VERIFY_LOCK_FILE_ENV = "MOTEBIT_VERIFY_LOCK_FILE";
/** Override how long a waiter waits before giving up (ms). */
export const VERIFY_LOCK_TIMEOUT_ENV = "MOTEBIT_VERIFY_LOCK_TIMEOUT_MS";

/** Longer than the slowest full pre-push run seen (≈83 min under contention). */
export const DEFAULT_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 2000;

export interface VerifyLockRecord {
  pid: number;
  holder: string;
  startedAt: string;
  /** The command the holder runs (with-verify-lock's child). The lock is held
   *  while EITHER is alive: a holder killed with SIGKILL cannot release, and
   *  its command keeps running, so its pid alone would hand the machine to a
   *  second run mid-flight. */
  childPid?: number;
}

/** A record is live while its holder or the command it started is alive. */
export function recordAlive(record: VerifyLockRecord): boolean {
  return pidAlive(record.pid) || (record.childPid != null && pidAlive(record.childPid));
}

export function verifyLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[VERIFY_LOCK_FILE_ENV];
  if (override != null && override !== "") return override;
  return join(homedir(), ".cache", "motebit", "verify.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readVerifyLock(path: string): VerifyLockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as VerifyLockRecord;
  } catch {
    return null;
  }
}

/** One attempt: take the lock, reclaiming a dead holder's. Returns the live
 *  holder's record when someone else has it. */
function tryAcquire(path: string, holder: string): VerifyLockRecord | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      const record: VerifyLockRecord = {
        pid: process.pid,
        holder,
        startedAt: new Date().toISOString(),
      };
      writeSync(fd, JSON.stringify(record));
      closeSync(fd);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readVerifyLock(path);
      // A record not yet written (the holder is between open and write) reads
      // as null: treat it as held, never as stale.
      if (existing == null) return { pid: -1, holder: "(starting)", startedAt: "" };
      if (recordAlive(existing)) return existing;
      try {
        unlinkSync(path);
      } catch {
        /* raced with another reclaimer */
      }
    }
  }
  return readVerifyLock(path) ?? { pid: -1, holder: "(unknown)", startedAt: "" };
}

/** Releases the lock; `recordChild` names the command the holder started. */
export type VerifyLockRelease = (() => void) & { recordChild?: (childPid: number) => void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for and take the machine-wide verification lock. Re-entrant through
 * `MOTEBIT_VERIFY_LOCK_PID` for processes the holder spawns. Resolves to a
 * release function (also run on exit and SIGINT/SIGTERM). Rejects after the
 * wait timeout, naming the holder.
 */
export async function acquireVerifyLock(
  holder: string,
  opts: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): Promise<VerifyLockRelease> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const inherited = env[VERIFY_LOCK_ENV];
  if (inherited != null && inherited !== "") return () => {};

  const path = verifyLockPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const timeoutMs = Number(env[VERIFY_LOCK_TIMEOUT_ENV] ?? "") || DEFAULT_WAIT_TIMEOUT_MS;
  const start = Date.now();
  let announced = "";
  for (;;) {
    const blocker = tryAcquire(path, holder);
    if (blocker == null) break;
    const key = `${blocker.pid}`;
    if (key !== announced) {
      announced = key;
      log(
        `⏳ ${holder}: waiting for the machine's verification lock — held by \`${blocker.holder}\` ` +
          `(pid ${blocker.pid}${blocker.startedAt ? `, since ${blocker.startedAt}` : ""}). ` +
          `Two full verification runs on one machine time each other out (#1147); this one starts when that one ends.`,
      );
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `${holder}: gave up after ${Math.round(timeoutMs / 60000)} min waiting for the verification lock ` +
          `held by \`${blocker.holder}\` (pid ${blocker.pid}). Fix: let that run finish or stop it. ` +
          `Never delete ${path} while its pid is alive; a dead holder's lock is reclaimed automatically.`,
      );
    }
    await sleep(POLL_MS);
  }

  env[VERIFY_LOCK_ENV] = String(process.pid);
  const ownRecord = readVerifyLock(path);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (readVerifyLock(path)?.pid === process.pid) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("exit", release);
  return Object.assign(release, {
    /** Record the command this holder started, so the lock outlives a
     *  holder killed before it could release. */
    recordChild(childPid: number): void {
      if (ownRecord?.pid !== process.pid) return;
      writeFileSync(path, JSON.stringify({ ...ownRecord, childPid }));
    },
  });
}
