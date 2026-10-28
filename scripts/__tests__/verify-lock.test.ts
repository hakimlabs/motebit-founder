/**
 * The machine-wide verification lock (scripts/lib/verify-lock.ts) through its
 * real wrapper, scripts/with-verify-lock.ts, as the pre-push hook runs it.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const WRAPPER = join(ROOT, "scripts", "with-verify-lock.ts");

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function run(
  holder: string,
  shellCmd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string; started: number; ended: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(TSX, [WRAPPER, holder, "--", "sh", "-c", shellCmd], {
      env: { ...process.env, MOTEBIT_VERIFY_LOCK_PID: "", ...env },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stderr, started, ended: Date.now() }));
  });
}

function lockEnv(): Record<string, string> {
  dir = mkdtempSync(join(tmpdir(), "verify-lock-"));
  return { MOTEBIT_VERIFY_LOCK_FILE: join(dir, "verify.lock") };
}

describe("verify-lock", () => {
  it("two runs on one machine never overlap: the second waits for the first", async () => {
    const env = lockEnv();
    const log = join(dir, "log");
    writeFileSync(log, "");
    const body = (tag: string) =>
      `echo "${tag} start" >> ${log}; sleep 1.5; echo "${tag} end" >> ${log}`;
    const [a, b] = await Promise.all([run("A", body("A"), env), run("B", body("B"), env)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    // Strictly nested start/end pairs: no run starts while the other is inside.
    expect(lines).toHaveLength(4);
    expect(lines[0]!.split(" ")[0]).toBe(lines[1]!.split(" ")[0]);
    expect(lines[1]).toMatch(/end$/);
    expect(lines[2]!.split(" ")[0]).toBe(lines[3]!.split(" ")[0]);
    expect(a.stderr + b.stderr).toMatch(/waiting for the machine's verification lock/);
  }, 60_000);

  it("a lock whose holder is dead is reclaimed at once", async () => {
    const env = lockEnv();
    // A pid that cannot be alive.
    writeFileSync(
      env.MOTEBIT_VERIFY_LOCK_FILE!,
      JSON.stringify({ pid: 2_147_483_000, holder: "crashed push", startedAt: "2026-01-01" }),
    );
    const r = await run("after-crash", "true", env);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/waiting/);
  }, 30_000);

  it("a process the holder spawned passes straight through (the hook's re-run)", async () => {
    const env = lockEnv();
    writeFileSync(
      env.MOTEBIT_VERIFY_LOCK_FILE!,
      JSON.stringify({ pid: process.pid, holder: "this test", startedAt: "now" }),
    );
    const r = await run("child", "true", { ...env, MOTEBIT_VERIFY_LOCK_PID: String(process.pid) });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/waiting/);
  }, 30_000);

  it("the command's exit code is the wrapper's, and the lock is released after a failure", async () => {
    const env = lockEnv();
    const failed = await run("fails", "exit 7", env);
    expect(failed.code).toBe(7);
    const next = await run("next", "true", env);
    expect(next.code).toBe(0);
    expect(next.stderr).not.toMatch(/waiting/);
  }, 30_000);

  it("a waiter gives up after its timeout, naming the live holder", async () => {
    const env = lockEnv();
    writeFileSync(
      env.MOTEBIT_VERIFY_LOCK_FILE!,
      JSON.stringify({ pid: process.pid, holder: "a long push", startedAt: "now" }),
    );
    const r = await run("impatient", "true", { ...env, MOTEBIT_VERIFY_LOCK_TIMEOUT_MS: "500" });
    expect(r.code).toBe(75);
    expect(r.stderr).toMatch(/gave up .* held by `a long push`/);
  }, 30_000);

  it("a holder killed with SIGKILL keeps the lock until the command it started ends", async () => {
    const env = lockEnv();
    const log = join(dir, "log");
    writeFileSync(log, "");
    const first = spawn(
      TSX,
      [WRAPPER, "killed", "--", "sh", "-c", `sleep 2; echo "first done" >> ${log}`],
      { env: { ...process.env, MOTEBIT_VERIFY_LOCK_PID: "", ...env } },
    );
    // Wait until the first run holds the lock and has recorded its command.
    const lockFile = env.MOTEBIT_VERIFY_LOCK_FILE!;
    let holderPid = 0;
    for (let i = 0; i < 100 && holderPid === 0; i++) {
      try {
        const rec = JSON.parse(readFileSync(lockFile, "utf-8")) as {
          pid: number;
          childPid?: number;
        };
        if (rec.childPid) holderPid = rec.pid;
      } catch {
        /* not yet */
      }
      if (holderPid === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(holderPid).toBeGreaterThan(0);
    // Kill the HOLDER itself (the recorded pid), not the tsx launcher that
    // started it: SIGKILL gives it no chance to release.
    process.kill(holderPid, "SIGKILL");
    first.kill("SIGKILL");
    const second = await run("next", `echo "second start" >> ${log}`, env);
    expect(second.code).toBe(0);
    expect(second.stderr).toMatch(/waiting/);
    // The orphaned command finished before the second run began.
    expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual(["first done", "second start"]);
  }, 60_000);

  it("fails closed: a lock it cannot create stops the run before the command starts", async () => {
    const env = lockEnv();
    const marker = join(dir, "ran");
    // The lock's parent is a FILE, so the lock can never be created.
    writeFileSync(join(dir, "not-a-dir"), "");
    const r = await run("blocked", `touch ${marker}`, {
      MOTEBIT_VERIFY_LOCK_FILE: join(dir, "not-a-dir", "verify.lock"),
    });
    expect(r.code).toBe(75);
    expect(existsSync(marker)).toBe(false);
    void env;
  }, 30_000);
});
