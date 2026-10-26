#!/usr/bin/env tsx
/**
 * classify-autonomy-tier — the deterministic T0/T1 classifier of the repo
 * autonomy design (docs/proposals/repo-autonomy-v1.md, PR #1163).
 *
 * T0 (a machine reviewer may approve) only when EVERY changed path is unowned
 * in `.github/CODEOWNERS` AND no T0 exclusion fires; anything else is T1
 * (founder only). The exclusions are a floor: when in doubt, T1.
 *
 *   codeowners    a changed path (old or new name) has an owner.
 *   exclusion-1   a test or fixture whose SUBJECT is owned: it sits under an
 *                 owned directory (carved out only by the test exclusions at
 *                 the end of CODEOWNERS), its name names an owned file, or it
 *                 imports from an owned file or from a package on the
 *                 money/identity path (`scripts/money-identity-path.ts`).
 *   exclusion-2   `.github/**`.
 *   exclusion-3   dependencies / toolchain: any package.json field outside a
 *                 small descriptive allowlist (dependencies, overrides,
 *                 packageManager, scripts, engines, pnpm, ... all count),
 *                 lockfiles, Cargo, .npmrc, .nvmrc, pnpm patches, Dockerfiles;
 *                 and environment templates (`.env*`, `*.env.example`, ...):
 *                 their defaults are security posture, so they are T1 by an
 *                 explicit rule, not only by the unrecognised-extension close.
 *   exclusion-4   enforcement itself: `scripts/check*`, `scripts/lib/**`, the
 *                 tamper / outcome / coverage machinery, hooks, lint-staged,
 *                 lint / type / test / format config, test setup files, a test
 *                 whose subject is enforcement code, and any added
 *                 check-suppression directive (`eslint-disable`, `@ts-ignore`,
 *                 coverage-ignore, ...).
 *   exclusion-5   test weakening: net loss of `expect(` / `assert` calls in a
 *                 changed test file, a new `.skip` / `.only` / `.todo` /
 *                 `.fails` / `skipIf` / `xit`..., a deleted test file, a new or
 *                 changed timeout / retry (a raise cannot be told from a new
 *                 value without a baseline, so any change counts).
 *   self-expansion  agent instructions and doctrine: every `CLAUDE.md` /
 *                 `AGENTS.md` anywhere, `DOCTRINE.md`, `docs/doctrine/**` (an
 *                 agent editing its own instructions under T0 is the
 *                 self-expansion the design forbids).
 *   fail-closed   a rename (both names are judged, and the rename itself is
 *                 T1), a deletion, a binary or unrecognised file type, a
 *                 submodule or symlink, an empty or unparseable diff, file
 *                 content the classifier needed but could not read, and its own
 *                 error.
 *
 * It classifies the whole diff — content, not only the file list.
 *
 * PURE core (`classifyDiff`): diff text + CODEOWNERS text + an injected file
 * reader in, verdict out. CODEOWNERS matching is `scripts/lib/codeowners.ts`;
 * the money/identity registry is `scripts/money-identity-path.ts`; neither is
 * re-implemented here.
 *
 * CLI:
 *   tsx scripts/classify-autonomy-tier.ts --repo <dir> --base <rev> --head <rev>
 *   tsx scripts/classify-autonomy-tier.ts --diff <file|-> [--repo <dir> --base <rev> --head <rev>]
 * CODEOWNERS and the workspace package map are read from THIS script's checkout
 * (the trusted base), never from the diff's head. Prints one JSON line, then a
 * one-line summary. Exit 0 on any classification (T0 or T1); exit 2 only on a
 * classifier error, after printing a T1 `classifier-error` verdict — callers
 * treat a non-zero exit as T1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decidingRule, parseCodeowners, type CodeownersRule } from "./lib/codeowners.js";
import { cleanEnv } from "./lib/differential-tree.js";
import { MONEY_IDENTITY_PATH } from "./money-identity-path.js";

// ── Rules ────────────────────────────────────────────────────────────────────

export type RuleCategory =
  | "codeowners"
  | "exclusion-1"
  | "exclusion-2"
  | "exclusion-3"
  | "exclusion-4"
  | "exclusion-5"
  | "self-expansion"
  | "fail-closed";

/**
 * Every rule that can send a diff to T1. Closed: a firing can only name a key
 * of this table, and the test suite requires a must-T1 fixture for every key
 * and every category, so a rule cannot be added untested.
 */
export const RULES = {
  "codeowners-owned": { category: "codeowners", what: "a changed path has a CODEOWNERS owner" },
  "owned-subject": {
    category: "exclusion-1",
    what: "a test or fixture whose subject is an owned path or a money/identity package",
  },
  "github-config": { category: "exclusion-2", what: "a change under .github/" },
  "dependency-toolchain": {
    category: "exclusion-3",
    what: "a dependency, lockfile, package.json non-descriptive field or toolchain pin",
  },
  "env-template": {
    category: "exclusion-3",
    what: "an environment template (.env*, *.env.example): its defaults are security posture",
  },
  "enforcement-config": {
    category: "exclusion-4",
    what: "enforcement code or config (gates, hooks, lint/type/test/format config, test setup), or a test of it",
  },
  "check-suppression": {
    category: "exclusion-4",
    what: "an added lint / type / coverage suppression directive",
  },
  "test-assertion-loss": {
    category: "exclusion-5",
    what: "a net loss of expect( / assert calls in a changed test file",
  },
  "test-skip-added": {
    category: "exclusion-5",
    what: "a new .skip / .only / .todo / .fails / skipIf / runIf / xit / fit",
  },
  "test-deleted": { category: "exclusion-5", what: "a deleted test file" },
  "test-timeout-retry": { category: "exclusion-5", what: "a new or changed test timeout / retry" },
  "agent-instructions": {
    category: "self-expansion",
    what: "agent instructions or doctrine (CLAUDE.md / AGENTS.md anywhere, DOCTRINE.md, docs/doctrine/)",
  },
  rename: { category: "fail-closed", what: "a renamed path" },
  deletion: { category: "fail-closed", what: "a deleted file" },
  binary: { category: "fail-closed", what: "a binary file" },
  "unrecognised-type": {
    category: "fail-closed",
    what: "a file type the classifier does not recognise",
  },
  submodule: { category: "fail-closed", what: "a submodule change" },
  symlink: { category: "fail-closed", what: "a symlink change" },
  "unparseable-diff": { category: "fail-closed", what: "a diff the classifier cannot parse" },
  "empty-diff": {
    category: "fail-closed",
    what: "an empty diff (nothing to classify, or a failed fetch)",
  },
  "content-unavailable": {
    category: "fail-closed",
    what: "file content the classifier needed could not be read or parsed",
  },
  "classifier-error": { category: "fail-closed", what: "the classifier's own error" },
} as const satisfies Record<string, { category: RuleCategory; what: string }>;

export type RuleId = keyof typeof RULES;

export interface Firing {
  rule: RuleId;
  path: string | null;
  detail: string;
}

export interface Classification {
  tier: "T0" | "T1";
  /** The headline rule (earliest in RULES order among the firings), or null for T0. */
  rule: RuleId | null;
  category: RuleCategory | null;
  /** Every firing, in diff order. */
  firings: Firing[];
  /** Files in the diff. */
  files: number;
  summary: string;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────

export interface FileDiff {
  oldPath: string | null; // null = added
  newPath: string | null; // null = deleted
  renamed: boolean;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  added: string[];
  removed: string[];
}

class DiffParseError extends Error {}

function stripPrefix(p: string, prefix: "a/" | "b/"): string | null {
  if (p === "/dev/null") return null;
  if (p.startsWith('"')) throw new DiffParseError(`quoted path ${p} (unusual characters)`);
  if (!p.startsWith(prefix)) throw new DiffParseError(`path ${p} lacks the ${prefix} prefix`);
  return p.slice(2);
}

/** `---`/`+++` lines may carry a trailing tab + timestamp from some tools. */
function headerPath(line: string, marker: "--- " | "+++ "): string {
  return line.slice(marker.length).replace(/\t.*$/, "");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` / `gh pr diff` output. Throws DiffParseError on anything it does not understand. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (!head.startsWith("diff --git ")) {
      throw new DiffParseError(
        `line ${i + 1}: expected \`diff --git\`, got ${JSON.stringify(head.slice(0, 80))}`,
      );
    }
    const f: FileDiff = {
      oldPath: null,
      newPath: null,
      renamed: false,
      binary: false,
      oldMode: null,
      newMode: null,
      added: [],
      removed: [],
    };
    let sawOld = false;
    let sawNew = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let isNew = false;
    let isDeleted = false;
    i++;
    // Extended header.
    while (
      i < lines.length &&
      !lines[i]!.startsWith("diff --git ") &&
      !lines[i]!.startsWith("@@")
    ) {
      const l = lines[i]!;
      let m: RegExpExecArray | null;
      if ((m = /^new file mode (\d+)$/.exec(l))) {
        isNew = true;
        f.newMode = m[1]!;
      } else if ((m = /^deleted file mode (\d+)$/.exec(l))) {
        isDeleted = true;
        f.oldMode = m[1]!;
      } else if ((m = /^old mode (\d+)$/.exec(l))) f.oldMode = m[1]!;
      else if ((m = /^new mode (\d+)$/.exec(l))) f.newMode = m[1]!;
      else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(l))) {
        if (m[1]) {
          f.oldMode ??= m[1];
          f.newMode ??= m[1];
        }
      } else if (/^(similarity|dissimilarity) index \d+%$/.test(l)) {
        /* informational */
      } else if ((m = /^rename from (.+)$/.exec(l))) {
        if (m[1]!.startsWith('"')) throw new DiffParseError(`quoted rename path ${m[1]}`);
        renameFrom = m[1]!;
      } else if ((m = /^rename to (.+)$/.exec(l))) {
        if (m[1]!.startsWith('"')) throw new DiffParseError(`quoted rename path ${m[1]}`);
        renameTo = m[1]!;
      } else if ((m = /^copy from (.+)$/.exec(l))) {
        renameFrom = m[1]!; // judged like a rename source (both names)
      } else if ((m = /^copy to (.+)$/.exec(l))) {
        renameTo = m[1]!;
      } else if (/^Binary files .* differ$/.test(l)) {
        f.binary = true;
        const bm = /^Binary files (.+) and (.+) differ$/.exec(l);
        if (bm) {
          f.oldPath ??= stripPrefix(bm[1]!, "a/");
          f.newPath ??= stripPrefix(bm[2]!, "b/");
          sawOld = sawNew = true;
        }
      } else if (l === "GIT binary patch") {
        f.binary = true;
        // Skip the literal/delta payload up to the next file.
        while (i + 1 < lines.length && !lines[i + 1]!.startsWith("diff --git ")) i++;
      } else if (l.startsWith("--- ")) {
        f.oldPath = stripPrefix(headerPath(l, "--- "), "a/");
        sawOld = true;
      } else if (l.startsWith("+++ ")) {
        f.newPath = stripPrefix(headerPath(l, "+++ "), "b/");
        sawNew = true;
      } else {
        throw new DiffParseError(
          `line ${i + 1}: unrecognised extended header ${JSON.stringify(l.slice(0, 80))}`,
        );
      }
      i++;
    }
    if (renameFrom !== null || renameTo !== null) {
      if (renameFrom === null || renameTo === null)
        throw new DiffParseError("half a rename/copy header");
      f.renamed = true;
      f.oldPath = renameFrom;
      f.newPath = renameTo;
      sawOld = sawNew = true;
    }
    if (!sawOld || !sawNew) {
      // No ---/+++ (mode-only change, empty new/deleted file): the
      // `diff --git a/P b/P` line is unambiguous only when both halves agree.
      const rest = head.slice("diff --git ".length);
      if (rest.startsWith('"')) throw new DiffParseError(`quoted path in ${head}`);
      const half = (rest.length - 1) / 2;
      const a = rest.slice(0, half);
      const b = rest.slice(half + 1);
      if (
        !Number.isInteger(half) ||
        rest[half] !== " " ||
        !a.startsWith("a/") ||
        b !== `b/${a.slice(2)}`
      ) {
        throw new DiffParseError(`cannot read the path from ${JSON.stringify(head)}`);
      }
      const p = a.slice(2);
      f.oldPath = isNew ? null : p;
      f.newPath = isDeleted ? null : p;
    }
    if (isNew && f.oldPath !== null)
      throw new DiffParseError(`new file ${f.newPath} has an old path`);
    if (isDeleted && f.newPath !== null)
      throw new DiffParseError(`deleted file ${f.oldPath} has a new path`);
    if (f.oldPath === null && f.newPath === null) throw new DiffParseError(`no path in ${head}`);
    // Hunks.
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      const hm = HUNK.exec(lines[i]!);
      if (!hm) throw new DiffParseError(`line ${i + 1}: malformed hunk header`);
      let oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      let newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      i++;
      while (oldLeft > 0 || newLeft > 0) {
        if (i >= lines.length) throw new DiffParseError("hunk truncated");
        const l = lines[i]!;
        if (l.startsWith("\\")) {
          i++;
          continue;
        }
        const c = l[0];
        if (c === "+") {
          if (newLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk has more added lines than its header`);
          f.added.push(l.slice(1));
        } else if (c === "-") {
          if (oldLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk has more removed lines than its header`);
          f.removed.push(l.slice(1));
        } else if (c === " " || l === "") {
          if (oldLeft-- <= 0 || newLeft-- <= 0)
            throw new DiffParseError(`line ${i + 1}: hunk context overruns its header`);
        } else {
          throw new DiffParseError(
            `line ${i + 1}: unexpected hunk line ${JSON.stringify(l.slice(0, 80))}`,
          );
        }
        i++;
      }
      while (i < lines.length && lines[i]!.startsWith("\\")) i++;
    }
    if (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      throw new DiffParseError(`line ${i + 1}: trailing content after ${f.newPath ?? f.oldPath}`);
    }
    files.push(f);
  }
  return files;
}

// ── Path predicates ──────────────────────────────────────────────────────────

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Extensions a T0 change may touch. Anything else (no extension, images, toml, ...) is T1. */
export const RECOGNISED_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yml",
  "yaml",
  "css",
  "scss",
  "html",
  "svg",
  "sh",
  "py",
  "rs",
  "swift",
  "kt",
]);

export function extensionOf(path: string): string | null {
  const b = base(path);
  const dot = b.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like `.npmrc`
  return b.slice(dot + 1).toLowerCase();
}

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|__fixtures__|__mocks__|fixtures|test|tests|test-vectors|testdata)\//.test(
      path,
    ) || /\.(test|spec|harness|tampers)\.[cm]?[jt]sx?$/.test(path)
  );
}

const DEPENDENCY_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.toml",
  "Cargo.lock",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
  "Podfile",
  "Podfile.lock",
  "gradle.properties",
]);

/** Environment templates anywhere: `.env`, `.env.example`, `relay.env.example`, `env.sample`. */
export function isEnvTemplatePath(path: string): boolean {
  const b = base(path);
  return (
    /^\.env(\.|$)/.test(b) ||
    /\.env(\.[^/]*)?$/.test(b) ||
    /^env\.(example|sample|template)$/.test(b)
  );
}

/** Agent instructions and doctrine: what tells an agent how to act. */
export function isAgentInstructionsPath(path: string): boolean {
  const b = base(path);
  return (
    b === "CLAUDE.md" ||
    b === "AGENTS.md" ||
    path === "DOCTRINE.md" ||
    path.startsWith("docs/doctrine/")
  );
}

export function isDependencyPath(path: string): boolean {
  const b = base(path);
  return (
    DEPENDENCY_BASENAMES.has(b) ||
    /^requirements.*\.txt$/.test(b) ||
    /^Dockerfile/.test(b) ||
    /\.(podspec|gradle|gradle\.kts)$/.test(b) ||
    /^patches\//.test(path) ||
    path === ".changeset/config.json"
  );
}

/** Repo-root enforcement machinery: the gates and what they read or run. */
const ENFORCEMENT_PATHS: readonly RegExp[] = [
  /^scripts\/check[^/]*$/,
  /^scripts\/lib\//,
  /^scripts\/tampers\//,
  /^scripts\/verify-[^/]*$/,
  /^scripts\/test-outcome-floors\.json$/,
  /^scripts\/test-coverage-shards\.ts$/,
  /^scripts\/coverage-graduation\.ts$/,
  /^scripts\/gate-timing-hint\.json$/,
  /^scripts\/money-identity-path\.ts$/,
  /^scripts\/classify-autonomy-tier\.ts$/,
  /^scripts\/autonomy-tier-verdict\.ts$/,
  /^coverage-graduation\.json$/,
  /^\.husky\//,
];

/** Config basenames anywhere in the tree. */
const ENFORCEMENT_BASENAMES: readonly RegExp[] = [
  /^\.eslintrc/,
  /^\.eslintignore$/,
  /^eslint\.config\./,
  /^tsconfig.*\.json$/,
  /^vitest\.(config|workspace|shared)[^/]*$/,
  /^vite\.config[^/]*$/,
  /^jest\.config[^/]*$/,
  /^playwright\.config[^/]*$/,
  /^turbo\.json$/,
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^prettier\.config\./,
  /^\.lintstagedrc/,
  /^lint-staged\.config\./,
  /^knip\.jsonc?$/,
  /^api-extractor[^/]*\.json$/,
  /^\.gitattributes$/,
  // Test setup files run before every test and can redefine expect / assert.
  /^(.*[.-])?(setup|global-setup|test-setup|setup-tests|setupTests|vitest-setup)\.[cm]?[jt]sx?$/,
];

export function isEnforcementPath(path: string): boolean {
  if (ENFORCEMENT_PATHS.some((r) => r.test(path))) return true;
  const b = base(path);
  return ENFORCEMENT_BASENAMES.some((r) => r.test(b));
}

/** package.json fields a T0 change may touch; every other field is exclusion 3. */
export const DESCRIPTIVE_PACKAGE_FIELDS = new Set([
  "description",
  "keywords",
  "homepage",
  "bugs",
  "author",
  "contributors",
  "funding",
]);

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const SUPPRESSION =
  /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|(istanbul|c8|v8)\s+ignore|prettier-ignore|biome-ignore|knip-ignore|oxlint-disable/;

const ASSERTION = /\bexpect\s*(?:\.\s*\w+\s*)*\(|\bassert\w*\s*(?:\.\s*\w+\s*)*\(/g;

const SKIP =
  /\b(?:it|test|describe|suite|bench|context)\s*(?:\.\s*\w+\s*)*\.\s*(?:skip|only|todo|fails|skipIf|runIf|concurrent\.skip)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bctx\.skip\s*\(/;

const TIMEOUT =
  /\b(?:timeout|testTimeout|hookTimeout|teardownTimeout|retry|retries|repeats)\b\s*[:=(]|\bvi\s*\.\s*setConfig\s*\(|^\s*\}\s*,\s*[\d_]+\s*\)\s*;?\s*$|\.\s*retry\s*\(/;

function count(lines: readonly string[], re: RegExp): number {
  let n = 0;
  for (const l of lines) n += (l.match(re) ?? []).length;
  return n;
}

/** Added lines matching `re` whose text (trimmed) is not also a removed line — new, not moved. */
function newMatches(f: FileDiff, re: RegExp): string[] {
  const removed = new Set(f.removed.map((l) => l.trim()));
  return f.added.filter((l) => re.test(l) && !removed.has(l.trim()));
}

// ── Import resolution (exclusion 1 / 4 subjects) ─────────────────────────────

const IMPORT_SPECIFIERS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|importActual|importMock|unmock)\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g,
];

export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_SPECIFIERS) for (const m of source.matchAll(re)) out.add(m[1]!);
  return [...out];
}

/** Every repo path a relative specifier may name (TS `.js`→`.ts` mapping, index files). */
export function resolveRelative(fromFile: string, spec: string): string[] {
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  if (joined.startsWith("..")) return [];
  const stem = joined.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const out = new Set<string>([joined]);
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]) {
    out.add(stem + ext);
    out.add(`${joined}/index${ext}`);
  }
  return [...out];
}

// ── The classifier ───────────────────────────────────────────────────────────

export interface ClassifyInput {
  diff: string;
  /** Text of `.github/CODEOWNERS` (from the trusted base). */
  codeowners: string;
  /** `@motebit/<name>` → repo-relative package dir. */
  workspacePackages?: ReadonlyMap<string, string>;
  /** Money/identity registry; defaults to `MONEY_IDENTITY_PATH`. */
  moneyIdentityPath?: ReadonlyMap<string, unknown>;
  /** File content at the diff's base or head; null when unavailable. */
  readFile?: (rev: "base" | "head", path: string) => string | null;
}

export function classifyDiff(input: ClassifyInput): Classification {
  const firings: Firing[] = [];
  let files = 0;
  try {
    const fire = (rule: RuleId, path: string | null, detail: string): void => {
      firings.push({ rule, path, detail });
    };
    const { rules, errors } = parseCodeowners(input.codeowners);
    if (errors.length > 0)
      throw new Error(`CODEOWNERS has lines the parser refuses: ${errors.join("; ")}`);
    if (rules.length === 0)
      throw new Error("CODEOWNERS has no rules — refusing to classify against nothing");
    const registry = input.moneyIdentityPath ?? MONEY_IDENTITY_PATH;
    const workspace = input.workspacePackages ?? new Map<string, string>();
    const readFile = input.readFile ?? (() => null);

    if (input.diff.trim() === "") {
      fire("empty-diff", null, "the diff is empty");
      return finish(firings, 0);
    }
    let parsed: FileDiff[];
    try {
      parsed = parseUnifiedDiff(input.diff);
    } catch (err) {
      if (!(err instanceof DiffParseError)) throw err;
      fire("unparseable-diff", null, err.message);
      return finish(firings, 0);
    }
    files = parsed.length;

    const owned = (p: string): CodeownersRule | null => {
      const r = decidingRule(rules, p);
      return r && r.owners.length > 0 ? r : null;
    };
    /** An owned ancestor directory: the path is unowned only because a later exclusion carved it out. */
    const ownedAncestor = (p: string): string | null => {
      const parts = p.split("/");
      for (let k = parts.length - 1; k >= 1; k--) {
        const dir = parts.slice(0, k).join("/");
        if (owned(`${dir}/__autonomy_probe__`)) return dir;
      }
      return null;
    };
    const ownedOrEnforcement = (p: string): string | null => {
      const r = owned(p);
      if (r) return `owned by ${r.owners.join(" ")} (CODEOWNERS line ${r.line})`;
      if (isEnforcementPath(p)) return "enforcement code";
      return null;
    };

    for (const f of parsed) {
      const paths = [...new Set([f.oldPath, f.newPath].filter((p): p is string => p !== null))];
      const label = f.newPath ?? f.oldPath!;

      if (f.renamed) fire("rename", label, `renamed ${f.oldPath} → ${f.newPath}`);
      if (f.newPath === null) fire("deletion", f.oldPath, `deleted ${f.oldPath}`);
      if (f.binary) fire("binary", label, "binary content");
      for (const mode of [f.oldMode, f.newMode]) {
        if (mode === "120000") fire("symlink", label, "symlink (mode 120000)");
        if (mode === "160000") fire("submodule", label, "submodule (mode 160000)");
      }

      for (const p of paths) {
        const r = owned(p);
        if (r)
          fire(
            "codeowners-owned",
            p,
            `owned by ${r.owners.join(" ")} (CODEOWNERS line ${r.line}: ${r.pattern})`,
          );
        const anc = ownedAncestor(p);
        if (anc !== null) fire("owned-subject", p, `under owned directory ${anc}/`);
        if (p.startsWith(".github/")) fire("github-config", p, "under .github/");
        if (isDependencyPath(p)) fire("dependency-toolchain", p, "dependency / toolchain file");
        if (isEnvTemplatePath(p)) fire("env-template", p, "environment template");
        if (isAgentInstructionsPath(p))
          fire("agent-instructions", p, "agent instructions / doctrine");
        if (isEnforcementPath(p)) fire("enforcement-config", p, "enforcement code or config");
        const ext = extensionOf(p);
        if (ext === null || !RECOGNISED_EXTENSIONS.has(ext)) {
          fire(
            "unrecognised-type",
            p,
            `unrecognised file type ${ext === null ? "(no extension)" : `.${ext}`}`,
          );
        }
      }

      // Exclusion 3: package.json fields.
      if (paths.some((p) => base(p) === "package.json") && f.newPath !== null) {
        const before = f.oldPath === null ? "{}" : readFile("base", f.oldPath);
        const after = readFile("head", f.newPath);
        if (before === null || after === null) {
          fire(
            "content-unavailable",
            f.newPath,
            "package.json content unavailable — cannot rule out a dependency change",
          );
        } else {
          let a: Record<string, unknown> | null = null;
          let b: Record<string, unknown> | null = null;
          try {
            a = JSON.parse(before) as Record<string, unknown>;
            b = JSON.parse(after) as Record<string, unknown>;
          } catch {
            fire("content-unavailable", f.newPath, "package.json does not parse");
          }
          if (a && b) {
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            const changed = [...keys].filter(
              (k) =>
                !DESCRIPTIVE_PACKAGE_FIELDS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
            );
            if (changed.length > 0)
              fire(
                "dependency-toolchain",
                f.newPath,
                `package.json field(s) changed: ${changed.join(", ")}`,
              );
          }
        }
      }

      // Exclusion 4: suppression directives in code.
      if (paths.some((p) => CODE_EXT.test(p))) {
        const sup = newMatches(f, SUPPRESSION);
        if (sup.length > 0)
          fire("check-suppression", label, `added: ${sup[0]!.trim().slice(0, 100)}`);
      }

      // Test files: exclusions 1, 4 (subject) and 5.
      if (paths.some(isTestPath)) {
        if (f.newPath === null) fire("test-deleted", f.oldPath, `deleted test file ${f.oldPath}`);

        // Subject by name: `x.test.ts` beside or one `__tests__/` above `x.ts`.
        for (const p of paths) {
          const subj = p
            .replace(/\/__tests__\//, "/")
            .replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, "$2");
          if (subj !== p) {
            const why = ownedOrEnforcement(subj);
            if (why)
              fire(
                owned(subj) ? "owned-subject" : "enforcement-config",
                p,
                `subject by name ${subj} is ${why}`,
              );
          }
        }

        // Subject by import (code files only).
        if (paths.some((p) => CODE_EXT.test(p))) {
          const at = f.newPath ?? f.oldPath!;
          const source = readFile(f.newPath !== null ? "head" : "base", at);
          if (source === null) {
            fire(
              "content-unavailable",
              at,
              "test source unavailable — cannot resolve what it imports",
            );
          } else {
            for (const spec of importSpecifiers(source)) {
              if (spec.startsWith(".")) {
                for (const cand of resolveRelative(at, spec)) {
                  const why = ownedOrEnforcement(cand);
                  if (why) {
                    fire(
                      owned(cand) ? "owned-subject" : "enforcement-config",
                      at,
                      `imports ${spec} → ${cand}, ${why}`,
                    );
                    break;
                  }
                }
              } else {
                const m = /^(@motebit\/[^/]+)/.exec(spec);
                if (!m) continue;
                const pkg = m[1]!;
                if (registry.has(pkg)) {
                  fire(
                    "owned-subject",
                    at,
                    `imports ${spec} — ${pkg} is on the money/identity path`,
                  );
                  continue;
                }
                const dir = workspace.get(pkg);
                if (dir !== undefined) {
                  const hit = [`${dir}/src/index.ts`, `${dir}/package.json`].find((p) => owned(p));
                  if (hit) fire("owned-subject", at, `imports ${spec} — its entry ${hit} is owned`);
                }
              }
            }
          }
        }

        // Exclusion 5: weakening.
        const lostAsserts = count(f.removed, ASSERTION) - count(f.added, ASSERTION);
        if (lostAsserts > 0)
          fire("test-assertion-loss", label, `net ${lostAsserts} fewer expect(/assert call(s)`);
        const skips = newMatches(f, SKIP);
        if (skips.length > 0)
          fire("test-skip-added", label, `added: ${skips[0]!.trim().slice(0, 100)}`);
        const timeouts = newMatches(f, TIMEOUT);
        if (timeouts.length > 0)
          fire("test-timeout-retry", label, `added: ${timeouts[0]!.trim().slice(0, 100)}`);
      }
    }
    return finish(firings, files);
  } catch (err) {
    firings.push({
      rule: "classifier-error",
      path: null,
      detail: err instanceof Error ? err.message : String(err),
    });
    return finish(firings, files);
  }
}

function finish(firings: Firing[], files: number): Classification {
  if (firings.length === 0) {
    return {
      tier: "T0",
      rule: null,
      category: null,
      firings,
      files,
      summary: `T0 — ${files} file(s), every path unowned and no exclusion fired`,
    };
  }
  // The headline rule is the most fundamental one that fired (RULES order:
  // ownership first, then exclusions 1–5, then fail-closed), not whichever
  // file happened to come first in the diff.
  const order = Object.keys(RULES);
  const first = firings.reduce((a, b) => (order.indexOf(b.rule) < order.indexOf(a.rule) ? b : a));
  const others = firings.length - 1;
  return {
    tier: "T1",
    rule: first.rule,
    category: RULES[first.rule].category,
    firings,
    files,
    summary:
      `T1 — ${first.rule} (${RULES[first.rule].category})${first.path ? ` at ${first.path}` : ""}: ${first.detail}` +
      (others > 0 ? ` (+${others} more firing(s))` : ""),
  };
}

// ── I/O (CLI and the verdict script) ─────────────────────────────────────────

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `@motebit/<name>` → dir, from the trusted checkout's apps/ packages/ services/. */
export function readWorkspacePackages(root: string = SELF_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of ["apps", "packages", "services"]) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const d of readdirSync(g)) {
      const pj = join(g, d, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const name = (JSON.parse(readFileSync(pj, "utf-8")) as { name?: unknown }).name;
        if (typeof name === "string") out.set(name, `${group}/${d}`);
      } catch {
        /* an unreadable manifest names no package */
      }
    }
  }
  return out;
}

export function readTrustedCodeowners(root: string = SELF_ROOT): string {
  return readFileSync(join(root, ".github/CODEOWNERS"), "utf-8");
}

/** `git diff --find-renames base...head` in `repo` (three-dot: the PR's own changes). */
export function gitDiff(repo: string, baseRev: string, headRev: string, threeDot = true): string {
  return execFileSync(
    "git",
    [
      "diff",
      "--find-renames",
      "--no-color",
      "--no-ext-diff",
      `${baseRev}${threeDot ? "..." : ".."}${headRev}`,
    ],
    { cwd: repo, env: cleanEnv(), encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
}

/** The merge base of two revisions (the `base` side of a three-dot diff). */
export function gitMergeBase(repo: string, a: string, b: string): string {
  return execFileSync("git", ["merge-base", a, b], {
    cwd: repo,
    env: cleanEnv(),
    encoding: "utf-8",
  }).trim();
}

/** A file at a revision, or null when absent. */
export function gitShow(repo: string, rev: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      cwd: repo,
      env: cleanEnv(),
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Classify `base...head` in a local repository (CODEOWNERS from the trusted checkout). */
export function classifyRevisions(
  repo: string,
  baseRev: string,
  headRev: string,
  threeDot = true,
): Classification {
  let diff: string;
  let mergeBase: string;
  try {
    mergeBase = threeDot ? gitMergeBase(repo, baseRev, headRev) : baseRev;
    diff = gitDiff(repo, baseRev, headRev, threeDot);
  } catch (err) {
    return finish(
      [
        {
          rule: "unparseable-diff",
          path: null,
          detail: `could not fetch the diff: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      0,
    );
  }
  return classifyDiff({
    diff,
    codeowners: readTrustedCodeowners(),
    workspacePackages: readWorkspacePackages(),
    readFile: (rev, path) => gitShow(repo, rev === "base" ? mergeBase : headRev, path),
  });
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: readonly string[]): number {
  try {
    const repo = argValue(argv, "--repo");
    const baseRev = argValue(argv, "--base");
    const headRev = argValue(argv, "--head");
    const diffArg = argValue(argv, "--diff");
    let result: Classification;
    if (diffArg !== undefined) {
      const diff = diffArg === "-" ? readFileSync(0, "utf-8") : readFileSync(diffArg, "utf-8");
      const canRead = repo !== undefined && baseRev !== undefined && headRev !== undefined;
      const mergeBase = canRead ? gitMergeBase(repo, baseRev, headRev) : "";
      result = classifyDiff({
        diff,
        codeowners: readTrustedCodeowners(),
        workspacePackages: readWorkspacePackages(),
        readFile: canRead
          ? (rev, path) => gitShow(repo, rev === "base" ? mergeBase : headRev, path)
          : undefined,
      });
    } else if (repo !== undefined && baseRev !== undefined && headRev !== undefined) {
      result = classifyRevisions(repo, baseRev, headRev);
    } else {
      throw new Error(
        "usage: classify-autonomy-tier --repo <dir> --base <rev> --head <rev> | --diff <file|-> [...]",
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n${result.summary}\n`);
    return result.rule === "classifier-error" ? 2 : 0;
  } catch (err) {
    const result = finish(
      [
        {
          rule: "classifier-error",
          path: null,
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      0,
    );
    process.stdout.write(`${JSON.stringify(result)}\n${result.summary}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
