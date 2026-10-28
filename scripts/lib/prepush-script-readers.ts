/**
 * prepush-script-readers — which workspace packages READ a changed `scripts/`
 * path, derived from the tree at hook time (no manifest that can drift).
 *
 * Why (2026-10-28): `.husky/pre-push` widens its test phase to every package
 * whenever a changed path sits outside every package (deny by default). A
 * `scripts/` path is outside every package, so each gate edit ran all 74
 * suites (measured: 592s of an 18-minute push), although almost none of the
 * ~230 scripts/ files is read by any package. This helper narrows that ONE
 * class: a changed `scripts/` path widens the test phase to the packages that
 * reference it (directly or through scripts/'s own import closure), and to
 * EVERY package whenever the derivation is not sure.
 *
 * The derivation:
 *   1. References. Every tracked or untracked text file of every workspace
 *      package (pnpm-workspace.yaml roots, dirs with a package.json; not
 *      node_modules/, dist/, markdown or binaries) is scanned for
 *      `scripts/<path>`: `../`-relative (resolved against the file's dir, and
 *      the package dir for package-level config), `$TURBO_ROOT$/scripts/…`,
 *      or bare `scripts/…` — the root's scripts/ unless the package has that
 *      path itself (`tsx scripts/x.ts` from the repo root,
 *      `resolve(REPO_ROOT, "scripts/x")`, a string a test checks). A
 *      full-line comment is not a reference; everything else is
 *      (over-approximation is the safe direction).
 *   2. Readers. A reference in a test-only file (`__tests__/`, `tamper/`,
 *      `*.test.*`, `*.tampers.*`, a vitest config) makes its package a
 *      reader. A reference anywhere else (src, package.json, a vite config)
 *      can reach a DEPENDENT through an import or `^build`, so the package
 *      and every workspace package depending on it are readers.
 *   3. Closure. A reference from an executable file (JS/TS, shell, YAML,
 *      package.json / vercel.json / turbo.json / tsconfig) reads the
 *      script's forward closure inside scripts/: relative import / require /
 *      import() specifiers, `scripts/…` mentions in code, and relative
 *      string literals naming an existing scripts/ file. So a change to
 *      `scripts/lib/a.ts` that `tamper-runner.ts` imports counts as a change
 *      to `tamper-runner.ts`. A reference from a data file (.txt, other
 *      .json — a mention, not an execution) reads that exact path only. A
 *      closure that cannot be followed (a non-literal import/require, or a
 *      relative import leaving scripts/) makes its reader read EVERY script.
 *      Same for a package file that builds a path from a bare `"scripts"`
 *      segment in a join/resolve call.
 *   4. Fail closed to ALL packages when a changed scripts/ path matches a
 *      turbo.json `globalDependencies` entry (a path or a glob; `!`
 *      exclusions ignored); when it lies in the closure of a reference from
 *      a root config a package build/test reads (every tracked root-level
 *      non-markdown file and config/**, except ROOT_ONLY_FILES; root
 *      package.json minus its non-lifecycle `scripts`) — turbo.json is one,
 *      so a globalDependency's closure lands here; when such a root-config
 *      closure cannot be followed; when a package file invokes a root
 *      package.json script (`pnpm -w`, `--workspace-root`, `-C` / `--dir` /
 *      `--prefix` to `../`); and on ANY error.
 *
 * Aperture (stated, not hidden): markdown is not scanned (as the hook's
 * docs/ allowlist); a bare `scripts/` directory mention in a data file is
 * prose, not a read; a path assembled from separate segments inside a
 * scripts/ file (`join(__dirname, "lib", "x.json")`) is not followed; a
 * package spawning a root script with `cwd: <repo root>` and no literal
 * script path or pnpm root flag is not seen; a trailing (end-of-line)
 * comment counts as code. CI is the authority and runs every suite.
 *
 * CLI: changed paths on stdin, one per line, repo-root-relative; run from the
 * repo root. Prints the reader package dirs one per line, or one line
 * `__ALL__ <reason>`, then `__END__`. The hook treats a non-zero exit, a
 * missing `__END__` or an `__ALL__` line as ALL.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./differential-tree.js";

export type ReaderResult = { all: true; reason: string } | { all: false; dirs: string[] };

/** Root-level files no package build or test reads, each with its reason. */
export const ROOT_ONLY_FILES: Record<string, string> = {
  "vitest.config.mts": "applies only to vitest runs whose cwd is the repo root (see its header)",
  "knip.jsonc": "read only by the root `check-unused` command",
  ".gitignore": "ignore rules, read by no package build or test",
  ".prettierignore": "read by prettier (the hook's format phase), not by a package test",
  ".dockerignore": "docker build context, not a package task",
  "docker-compose.federation.yml": "manual federation harness, not a package task",
};

const BINARY =
  /\.(png|jpe?g|gif|svg|webp|ico|icns|woff2?|ttf|otf|eot|wasm|mp3|mp4|wav|ogg|webm|pdf|zip|gz|tgz|br|jar|keystore|p12|der|bin|node|so|dylib|dll|exe)$/i;
const JS_FAMILY = /\.(m|c)?(j|t)sx?$/i;
const HASH_COMMENTS = /\.(sh|bash|ya?ml|toml|py|rb)$|(^|\/)\.[^/]*rc$/i;
const EXECUTABLE =
  /\.((m|c)?(j|t)sx?|sh|bash|ya?ml|html)$|(^|\/)(package|vercel|turbo|tsconfig[^/]*)\.json$/i;
const TEST_ONLY =
  /(^|\/)(__tests__|__mocks__|__fixtures__|tamper|test|tests|e2e)\/|\.(test|spec|tampers|e2e)\.(m|c)?(j|t)sx?$|(^|\/)vitest\.[^/]*config\.[^/]+$/;
const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish"]);

/**
 * `scripts/<rest>` with any `../` / `./` prefix; `$TURBO_ROOT$/` marks the
 * root. Not preceded by a name char or `name/` (`apps/x/scripts/…` names that
 * dir's own scripts, never the root's).
 */
const SCRIPT_REF =
  /(?<![A-Za-z0-9_.@-])(?<![A-Za-z0-9_@-]\/)(\$TURBO_ROOT\$\/)?((?:\.\.?\/)*)scripts\/([A-Za-z0-9_.@+/-]*)/g;
/** A package invoking a root package.json script by name. */
const ROOT_SCRIPT_CALL = [
  /\b(?:pnpm|npm)\b.*?[\s"'`[,](?:-w|--workspace-root)(?=[\s"'`,\]]|$)/,
  /\b(?:pnpm|npm)\b.*?[\s"'`[,](?:-C|--dir|--prefix)[\s"'`,=]+(?:\.\.\/)+/,
];
/** A path built from a bare "scripts" segment: which script is unresolvable. */
const SEGMENT_CALL = /\b(?:join|resolve)\(([^)]*,)?\s*["'`]scripts["'`]/;

const stripExt = (p: string): string => p.replace(/\.(d\.)?(m|c)?(j|t)sx?$/, "");
/** Changed key `c` is `k` itself or under the directory `k`. */
const covers = (k: string, c: string): boolean => c === k || c.startsWith(`${k}/`);

function listFiles(root: string): string[] {
  const r = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", env: cleanEnv(), maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

function readText(root: string, rel: string): string | null {
  try {
    const abs = join(root, rel);
    return statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
  } catch {
    return null; // deleted in the working tree
  }
}

/** The file's lines minus full-line comments (`//`, `/*`, ` *`, or `#`). */
function codeLines(rel: string, text: string): string[] {
  const lines = text.split("\n");
  if (JS_FAMILY.test(rel) || /\.jsonc?$/i.test(rel))
    return lines.filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  if (HASH_COMMENTS.test(rel)) return lines.filter((l) => !/^\s*#/.test(l));
  return lines;
}

function workspaceRoots(root: string): string[] {
  const roots: string[] = [];
  for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\s*(#.*)?$/.test(line) || /^packages:\s*$/.test(line)) continue;
    const m = /^\s*-\s*["']?([A-Za-z0-9_.-]+)\/\*["']?\s*$/.exec(line);
    if (!m) throw new Error(`pnpm-workspace.yaml line not mappable: ${line}`);
    roots.push(m[1]!);
  }
  if (roots.length === 0) throw new Error("pnpm-workspace.yaml names no workspace root");
  return roots;
}

/** Glob → RegExp for turbo globalDependencies (`*`, `**`, `?`, `{a,b}`). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(/.*)?$`);
}

/**
 * Root scripts/ targets (extension-stripped; `scripts` = the whole dir) that
 * `lines` of file `rel` reference. `pkgDir` is the file's package ("" for a
 * root or scripts/ file); a path the package has itself is not the root's.
 */
function extractRefs(root: string, rel: string, pkgDir: string, lines: string[]): string[] {
  const out: string[] = [];
  const fileDir = posix.dirname(rel);
  for (const line of lines) {
    for (const m of line.matchAll(SCRIPT_REF)) {
      const prefix = m[2] ?? "";
      // Trailing `.` / `/` is punctuation or a dir mention (`scripts/` = the dir).
      const tail = `scripts/${(m[3] ?? "").replace(/[./]+$/, "")}`.replace(/\/$/, "");
      let target: string | null = null;
      if (m[1] != null) target = tail;
      else if (prefix.includes("..")) {
        for (const base of [fileDir, pkgDir || "."]) {
          const t = posix.normalize(posix.join(base, prefix + tail));
          if (t === "scripts" || t.startsWith("scripts/")) target = t;
        }
      } else if (pkgDir) {
        const local = [posix.join(fileDir, prefix + tail), posix.join(pkgDir, tail)];
        if (!local.some((p) => existsSync(join(root, p)))) target = tail;
      } else target = tail;
      if (target != null) out.push(stripExt(target));
    }
  }
  return out;
}

/** import / export-from / require() / import() specifiers; opaque = a non-literal one. */
function importSpecifiers(lines: string[]): { literal: string[]; opaque: string | null } {
  const literal: string[] = [];
  let opaque: string | null = null;
  const text = lines.join("\n");
  const STATIC =
    /\b(?:import|export)\s[^;'"`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(STATIC)) literal.push((m[1] ?? m[2])!);
  // Prettier writes calls with no space before `(`; prose ("the import (x)") has one.
  const CALL = /(?<![A-Za-z0-9_$.])(require|import)\(([^)]*)\)/g;
  for (const m of text.matchAll(CALL)) {
    const arg = (m[2] ?? "").trim();
    const lit = /^(["'])([^"']*)\1$|^`([^`$]*)`$/.exec(arg);
    if (lit) literal.push((lit[2] ?? lit[3])!);
    else opaque ??= `${m[1]}(${arg.slice(0, 60)})`;
  }
  return { literal, opaque };
}

interface Closure {
  keys: Set<string>;
  /** Why the closure cannot be followed, or null. */
  opaque: string | null;
}

class ScriptsGraph {
  private readonly byKey = new Map<string, string[]>();
  private readonly memo = new Map<string, Closure>();

  constructor(
    private readonly root: string,
    files: string[],
  ) {
    for (const f of files) {
      if (!f.startsWith("scripts/")) continue;
      const k = stripExt(f);
      this.byKey.set(k, [...(this.byKey.get(k) ?? []), f]);
    }
  }

  /** `target` plus everything it reads inside scripts/, transitively. */
  closure(target: string): Closure {
    const hit = this.memo.get(target);
    if (hit) return hit;
    const keys = new Set<string>();
    let opaque: string | null = null;
    const stack = [target];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (keys.has(k)) continue;
      keys.add(k);
      for (const ik of this.byKey.keys()) if (ik.startsWith(`${k}/`)) stack.push(ik);
      for (const f of this.byKey.get(k) ?? []) {
        const text = readText(this.root, f);
        if (text == null || !EXECUTABLE.test(f)) continue;
        const lines = codeLines(f, text);
        if (JS_FAMILY.test(f)) {
          const spec = importSpecifiers(lines);
          if (spec.opaque) opaque ??= `${f}: non-literal ${spec.opaque}`;
          for (const s of spec.literal) {
            if (!s.startsWith(".")) continue; // a bare module or node: builtin
            const t = posix.normalize(posix.join(posix.dirname(f), s));
            if (t.startsWith("scripts/")) stack.push(stripExt(t));
            else opaque ??= `${f} imports ${s}, outside scripts/ (not followed there)`;
          }
          // Relative string literals naming a scripts/ file (an fs read).
          for (const m of lines.join("\n").matchAll(/["'`](\.\.?\/[^"'`\s$]+)["'`]/g)) {
            const t = stripExt(posix.normalize(posix.join(posix.dirname(f), m[1]!)));
            if (t.startsWith("scripts/") && this.byKey.has(t)) stack.push(t);
          }
        }
        for (const r of extractRefs(this.root, f, "", lines)) stack.push(r);
      }
    }
    const c = { keys, opaque };
    this.memo.set(target, c);
    return c;
  }
}

export function scriptReaders(root: string, changed: string[]): ReaderResult {
  const changedPaths = [...new Set(changed.filter((p) => p.startsWith("scripts/")))];
  if (changedPaths.length === 0) return { all: false, dirs: [] };
  const changedKeys = changedPaths.map(stripExt);
  const files = listFiles(root);
  const graph = new ScriptsGraph(root, files);
  /** Does a reference to `target` from file `rel` read a changed script? */
  const reads = (target: string, rel: string): { hit: boolean; opaque: string | null } => {
    if (!EXECUTABLE.test(rel)) {
      // A mention in a data file names that path only; a bare `scripts/`
      // there is prose about the directory, not a read of every file in it.
      if (target === "scripts") return { hit: false, opaque: null };
      return { hit: changedKeys.some((c) => covers(target, c)), opaque: null };
    }
    const c = graph.closure(target);
    return {
      hit: changedKeys.some((ch) => [...c.keys].some((k) => covers(k, ch))),
      opaque: c.opaque,
    };
  };

  // --- ALL: turbo.json globalDependencies ----------------------------------
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
    globalDependencies?: unknown;
  };
  const globals = turbo.globalDependencies ?? [];
  if (!Array.isArray(globals)) throw new Error("turbo.json globalDependencies is not an array");
  for (const g of globals) {
    if (typeof g !== "string")
      throw new Error("a turbo.json globalDependencies entry is not a string");
    if (g.startsWith("!")) continue; // an exclusion only narrows; ignoring it is the safe side
    const glob = g.replace(/^\$TURBO_ROOT\$\//, "");
    const matched = changedPaths.find((p) => globToRegExp(glob).test(p));
    if (matched)
      return { all: true, reason: `${matched} matches turbo.json globalDependencies "${g}"` };
  }
  // A literal entry's import CLOSURE is reached by the root-config scan
  // below: turbo.json is a root config, and its text names the entry.

  // --- ALL: root configs a package build/test reads -------------------------
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const f of files) {
    if (f.includes("/") && !f.startsWith("config/")) continue;
    if (/\.mdx?$/i.test(f) || BINARY.test(f) || f in ROOT_ONLY_FILES) continue;
    let text = readText(root, f);
    if (text == null) continue;
    if (f === "package.json") {
      // Root `scripts` run only when invoked (by the hook, CI, or a package by
      // name — that last case is checked per package below); lifecycle
      // scripts run on every install, so they stay.
      const lifecycle = Object.entries(rootPkg.scripts ?? {}).filter(([k]) => LIFECYCLE.has(k));
      text = JSON.stringify({ ...rootPkg, scripts: Object.fromEntries(lifecycle) }, null, 2);
    }
    for (const t of extractRefs(root, f, "", codeLines(f, text))) {
      const r = reads(t, f);
      if (r.hit)
        return {
          all: true,
          reason: `root config ${f} reads ${t}, whose closure holds a changed script`,
        };
      if (r.opaque)
        return {
          all: true,
          reason: `root config ${f} reads ${t}: closure not followable (${r.opaque})`,
        };
    }
  }

  // --- Workspace packages ----------------------------------------------------
  const wsRoots = workspaceRoots(root);
  const pkgDirs = new Set<string>();
  for (const f of files) {
    const m = /^([^/]+)\/([^/]+)\/package\.json$/.exec(f);
    if (m && wsRoots.includes(m[1]!) && existsSync(join(root, f))) pkgDirs.add(`${m[1]}/${m[2]}`);
  }
  const nameToDir = new Map<string, string>();
  const depNames = new Map<string, string[]>();
  for (const d of pkgDirs) {
    const pj = JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof pj.name === "string") nameToDir.set(pj.name, d);
    const names: string[] = [];
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const o = pj[field];
      if (o && typeof o === "object") names.push(...Object.keys(o));
    }
    depNames.set(d, names);
  }
  /** `start` and every workspace package depending on it, transitively. */
  const withDependents = (start: string): Set<string> => {
    const out = new Set([start]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [d, names] of depNames) {
        if (!out.has(d) && names.some((n) => out.has(nameToDir.get(n) ?? ""))) {
          out.add(d);
          grew = true;
        }
      }
    }
    return out;
  };

  const readers = new Set<string>();
  const addReader = (pkg: string, rel: string): void => {
    if (TEST_ONLY.test(rel.slice(pkg.length + 1))) readers.add(pkg);
    else for (const d of withDependents(pkg)) readers.add(d);
  };
  for (const f of files) {
    const m = /^([^/]+\/[^/]+)\//.exec(f);
    if (!m || !pkgDirs.has(m[1]!)) continue;
    if (/(^|\/)(node_modules|dist)\//.test(f) || BINARY.test(f) || /\.mdx?$/i.test(f)) continue;
    const pkg = m[1]!;
    const text = readText(root, f);
    if (text == null || !/scripts|pnpm|npm/.test(text)) continue;
    const lines = codeLines(f, text);
    for (const line of lines) {
      if (ROOT_SCRIPT_CALL.some((re) => re.test(line))) {
        return {
          all: true,
          reason: `${f} invokes a root package.json script: ${line.trim().slice(0, 120)}`,
        };
      }
      if (SEGMENT_CALL.test(line)) addReader(pkg, f); // reads an unresolvable script: all of them
    }
    for (const t of extractRefs(root, f, pkg, lines)) {
      const r = reads(t, f);
      if (r.hit || r.opaque) addReader(pkg, f); // opaque closure: reads every script
    }
  }
  return { all: false, dirs: [...readers].sort() };
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let out: string;
  try {
    const changed = readFileSync(0, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const r = scriptReaders(process.cwd(), changed);
    out = r.all ? `__ALL__ ${r.reason}\n` : r.dirs.map((d) => `${d}\n`).join("");
  } catch (err) {
    out = `__ALL__ helper error: ${err instanceof Error ? err.message : String(err)}\n`;
  }
  process.stdout.write(`${out}__END__\n`);
}
