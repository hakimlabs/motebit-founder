/**
 * pre-push scripts/ readers tamper checks (2026-10-28) — each rule of the
 * derivation in scripts/lib/prepush-script-readers.ts, and each fail-closed
 * branch of the hook's scope_script_readers, removed, must turn its test red.
 *
 *   node scripts/tampers/prepush-script-readers.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "scripts/lib/prepush-script-readers.ts";
const HOOK = ".husky/pre-push";
const GATE = "scripts/check-prepush-subset.ts";
const UNIT = "scripts/__tests__/prepush-script-readers.test.ts";
const HOOK_TEST = "scripts/__tests__/pre-push-hook.test.ts";

const REAL = "prepush-script-readers — the real repo";
const REFS = "prepush-script-readers — references and closure";
const CLOSED = "prepush-script-readers — fail closed to every package";
const CALLS = "prepush-script-readers — the hook calls it";
const R2 = "prepush-script-readers — review round 2 (F1–F5)";
const SCEN = "pre-push hook — path shapes and exit status (scenarios on the real hook)";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run as a command with a red marker (the root vitest config pins the JSON
 * reporter's outputFile; precedent: scripts/tampers/1147-wall-clock-tests.ts),
 * `-t` anchored to the exact full name of the test that must go red.
 */
function entry(o: {
  name: string;
  test: string;
  red: string;
  file: string;
  from: string;
  to: string;
  /** Further edits that must land together (two rules that each cover the case). */
  also?: TamperEntry["edits"];
}): TamperEntry {
  return {
    name: o.name,
    edits: [{ file: o.file, from: o.from, to: o.to }, ...(o.also ?? [])],
    command: ["pnpm", "exec", "vitest", "run", o.test, "-t", `^${escapeRegExp(o.red)}$`],
    redMarker: "Test Files  1 failed",
  };
}

/** The closure step, whole: no file of scripts/ is read beyond the start. */
const CLOSURE_STEP = {
  file: HELPER,
  from: "      for (const f of this.byKey.get(k) ?? []) {",
  to: "      for (const f of [] as string[]) {",
};

const TAMPERS: TamperEntry[] = [
  // --- the closure step ------------------------------------------------------
  entry({
    name: "closure: scripts/ not followed past the referenced script (unit)",
    test: UNIT,
    red: `${REFS} a change to a script the referenced one imports (transitively) reaches its readers`,
    ...CLOSURE_STEP,
  }),
  entry({
    name: "closure: scripts/ not followed past the referenced script (hook)",
    test: HOOK_TEST,
    red: `${SCEN} transitive scripts/lib change tests the reader`,
    ...CLOSURE_STEP,
  }),
  entry({
    // Two rules cover a listed path (the globalDependencies match, and
    // turbo.json read as a root config): both go, or neither does.
    name: "fail closed: globalDependencies neither matched nor read as a root config (real repo)",
    test: UNIT,
    red: `${REAL} every turbo globalDependency under scripts/ fails closed to every package`,
    file: HELPER,
    from: "    if (matched)\n",
    to: "    if (false)\n",
    also: [
      {
        file: HELPER,
        from: "      if (r.hit)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
        to: "      if (false)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
      },
    ],
  }),
  entry({
    name: "closure: the import edge alone dropped (a deleted import target is missed)",
    test: UNIT,
    red: `${REFS} a DELETED module the referenced one imports still reaches its readers`,
    file: HELPER,
    from: "            if (/^scripts\\//i.test(t)) stack.push(key(t));",
    to: "            if (/^scripts\\//i.test(t)) void key(t);",
  }),
  // --- the fail-closed branches of the helper --------------------------------
  entry({
    name: "fail closed: a globalDependencies glob match is not ALL",
    test: UNIT,
    red: `${CLOSED} a path matched by a globalDependencies glob (one naming no scripts/ prefix)`,
    file: HELPER,
    from: "    if (matched)\n",
    to: "    if (false)\n",
  }),
  entry({
    name: "fail closed: a globalDependency's closure hit is not ALL (turbo.json as a root config)",
    test: UNIT,
    red: `${CLOSED} a path in a globalDependency's import closure`,
    file: HELPER,
    from: "      if (r.hit)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
    to: "      if (false)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
  }),
  entry({
    name: "fail closed: an unfollowable root-config / globalDependency closure is not ALL",
    test: UNIT,
    red: `${CLOSED} a globalDependency whose closure cannot be followed (any scripts/ change)`,
    file: HELPER,
    from: "      if (r.opaque)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}: closure",
    to: "      if (false)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}: closure",
  }),
  entry({
    name: "fail closed: a root config's reference is not ALL",
    test: UNIT,
    red: `${CLOSED} a path a root config reads (vitest.shared.ts importing a scripts/ module)`,
    file: HELPER,
    from: "      if (r.hit)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
    to: "      if (false)\n        return {\n          all: true,\n          reason: `root config ${f} reads ${t}, whose",
  }),
  entry({
    name: "fail closed: root lifecycle scripts dropped with the rest of root `scripts`",
    test: UNIT,
    red: `${CLOSED} a root package.json lifecycle script (runs on every install)`,
    file: HELPER,
    from: ".filter(([k]) => LIFECYCLE.has(k));",
    to: '.filter(([k]) => k === "");',
  }),
  entry({
    name: "fail closed: a package running a root script by name is not ALL",
    test: UNIT,
    red: `${CLOSED} a package invoking a root package.json script by name`,
    file: HELPER,
    from: "      if (ROOT_SCRIPT_CALL.some((re) => re.test(line))) {",
    to: "      if (ROOT_SCRIPT_CALL.some((re) => re.test(line)) && false) {",
  }),
  entry({
    name: "fail closed: the CLI prints nothing on a helper error",
    test: UNIT,
    red: `${CLOSED} a helper error (unreadable turbo.json): the CLI prints __ALL__ and __END__`,
    file: HELPER,
    from: "    out = `__ALL__ helper error: ${err instanceof Error ? err.message : String(err)}\\n`;",
    to: '    out = "";',
  }),
  // --- reader rules ------------------------------------------------------------
  entry({
    name: "readers: a non-test reference no longer widens to dependents",
    test: UNIT,
    red: `${REFS} a reference from non-test source also widens to the package's dependents`,
    file: HELPER,
    from: "    else for (const d of withDependents(pkg)) readers.add(d);",
    to: "    else readers.add(pkg);",
  }),
  entry({
    name: "readers: an unfollowable closure no longer makes its reader read everything",
    test: UNIT,
    red: `${REFS} an unfollowable closure (non-literal import): its reader reads every script`,
    file: HELPER,
    from: "      if (r.hit || r.opaque) addReader(pkg, f); // opaque closure",
    to: "      if (r.hit) addReader(pkg, f); // opaque closure",
  }),
  entry({
    name: "readers: a relative import leaving scripts/ is followed as if closed",
    test: UNIT,
    red: `${REFS} a closure that leaves scripts/ by a relative import: its reader reads every script`,
    file: HELPER,
    from: "            else opaque ??= `${f} imports ${s}, outside scripts/ (not followed there)`;",
    to: "            else void s;",
  }),
  entry({
    name: 'readers: a bare "scripts" path segment ignored',
    test: UNIT,
    red: `${REFS} a path built from a bare "scripts" segment: that package reads every script`,
    file: HELPER,
    from: "    if (segment && !provablyLocal) addReader(pkg, f);",
    to: "    if (segment && false) addReader(pkg, f);",
  }),
  entry({
    name: "readers: the package's own scripts/ path taken for the root's",
    test: UNIT,
    red: `${REFS} a bare \`scripts/x\` the package has itself is the package's own, not the root's`,
    file: HELPER,
    from: "        if (!isLocal) target = tail;",
    to: "        target = tail;",
  }),
  entry({
    name: "readers: full-line comments read as references",
    test: UNIT,
    red: `${REFS} a full-line comment is not a reference`,
    file: HELPER,
    from: "  if (JS_FAMILY.test(rel) || /\\.jsonc?$/i.test(rel)) {\n",
    to: "  if (false) {\n",
  }),
  entry({
    name: "readers: a data-file mention follows the closure",
    test: UNIT,
    red: `${REFS} a data-file mention reads that exact path, not its closure`,
    file: HELPER,
    from: "    if (!EXECUTABLE.test(rel)) {",
    to: "    if (false) {",
  }),
  // --- review round 2 ----------------------------------------------------------
  entry({
    name: "F1: a path cut short by ${…} read as its literal head",
    test: UNIT,
    red: `${R2} F1: a path cut short by an interpolation is a prefix of every script it can name`,
    file: HELPER,
    from: '      const partial = PARTIAL_NEXT.test(line[(m.index ?? 0) + m[0].length] ?? "");',
    to: '      const partial = PARTIAL_NEXT.test("");',
  }),
  entry({
    name: "F1: a glob path read as its literal head",
    test: UNIT,
    red: `${R2} F1: a glob path is a prefix of every script it can name`,
    file: HELPER,
    from: '      const partial = PARTIAL_NEXT.test(line[(m.index ?? 0) + m[0].length] ?? "");',
    to: '      const partial = PARTIAL_NEXT.test("");',
  }),
  entry({
    name: 'F2: a multi-line join\'s "scripts" segment ignored',
    test: UNIT,
    red: `${R2} F2: a "scripts" segment in a multi-line join reads the whole root scripts/ dir`,
    file: HELPER,
    from: "    if (segment && !provablyLocal) addReader(pkg, f);",
    to: "    if (segment && false) addReader(pkg, f);",
  }),
  entry({
    name: 'F2: an array-joined "scripts" segment ignored',
    test: UNIT,
    red: `${R2} F2: a "scripts" segment in an array joined into a path`,
    file: HELPER,
    from: "    if (segment && !provablyLocal) addReader(pkg, f);",
    to: "    if (segment && false) addReader(pkg, f);",
  }),
  entry({
    name: 'F2: locality no longer proved (every "scripts" literal is the root\'s)',
    test: UNIT,
    red: `${R2} F2 control: a provably package-local "scripts" (own scripts/ dir, no root) is not the root's`,
    file: HELPER,
    from: "    if (segment && !provablyLocal) addReader(pkg, f);",
    to: "    if (segment) addReader(pkg, f);",
  }),
  entry({
    name: "T1: the relative-string-literal (fs read) edge dropped from the closure",
    test: UNIT,
    red: `${R2} T1: a relative string literal a closure file reads (an fs read) is in the closure`,
    file: HELPER,
    from: '            if (t.startsWith("scripts/") && this.byKey.has(t)) stack.push(t);',
    to: "            void t;",
  }),
  entry({
    name: "T2: scripts/ paths a closure file runs dropped from the closure",
    test: UNIT,
    red: `${R2} T2: a scripts/ path a closure file runs (\`tsx scripts/x\`) is in the closure`,
    file: HELPER,
    from: '        for (const r of extractRefs(this.root, f, "", lines)) stack.push(r);',
    to: "        void extractRefs;",
  }),
  entry({
    name: "T3: a referenced directory not expanded to its files",
    test: UNIT,
    red: `${R2} T3: a referenced directory reads the closure of every file under it`,
    file: HELPER,
    from: "      for (const ik of this.byKey.keys()) if (ik.startsWith(under)) stack.push(ik);",
    to: "      void under;",
  }),
  entry({
    name: "T4: the $TURBO_ROOT$ branch dropped (a package-local twin wins)",
    test: UNIT,
    red: `${R2} T4: \`$TURBO_ROOT$/scripts/…\` is the root's even when the package has that path`,
    file: HELPER,
    from: "      if (m[1] != null) target = tail;",
    to: "      if (false) target = tail;",
  }),
  entry({
    name: "T5: the -C/--dir/--prefix root-run form dropped",
    test: UNIT,
    red: `${R2} T5: a package running pnpm from the repo root (\`--dir ../..\`) is ALL`,
    file: HELPER,
    from: "  /\\b(?:pnpm|npm)\\b.*?[\\s\"'`[,](?:-C|--dir|--prefix)[\\s\"'`,=]+(?:\\.\\.\\/)+/,\n",
    to: "",
  }),
  entry({
    name: "T6: untracked files not listed",
    test: UNIT,
    red: `${R2} T6: an UNTRACKED package file's reference counts`,
    file: HELPER,
    from: '"--cached", "--others", "--exclude-standard"',
    to: '"--cached", "--exclude-standard"',
  }),
  entry({
    name: "F3: non-package files a package reaches not followed",
    test: UNIT,
    red: `${R2} F3: a package file reaching an executable non-package file reads what that file runs`,
    file: HELPER,
    from: "    const reached = EXECUTABLE.test(f) ? outsideRefs(f, pkg, lines) : [];",
    to: "    const reached: string[] = [];",
  }),
  entry({
    name: "F3: non-package files followed one hop only",
    test: UNIT,
    red: `${R2} F3: a package file reaching an executable non-package file reads what that file runs`,
    file: HELPER,
    from: "      stack.push(...e.next);",
    to: "      void e.next;",
  }),
  entry({
    name: "rule 5: a package without its own vitest config not ALL",
    test: UNIT,
    red: `${R2} rule 5: a package with a test script and no vite/vitest config of its own is ALL`,
    file: HELPER,
    from: "      if (!own)\n",
    to: "      if (false)\n",
  }),
  entry({
    name: "F4: code after a closing block comment dropped with the comment",
    test: UNIT,
    red: `${R2} F4: code after a closing block comment on the same line is a reference`,
    file: HELPER,
    from: '        return after.trim() === "" ? [] : [after];',
    to: "        return [];",
  }),
  entry({
    name: "F4: the `cd ../..` root-run form dropped",
    test: UNIT,
    red: `${R2} F4: \`cd ../.. && …\` in a package script is ALL`,
    file: HELPER,
    from: "  /(?:^|[\\s\"'`;&|(])cd\\s+[\"']?\\.\\.(?:\\/|[\"'\\s;&]|$)/,\n",
    to: "",
  }),
  entry({
    name: "F4: the `turbo run //#` root-task form dropped",
    test: UNIT,
    red: `${R2} F4: \`turbo run //#…\` (a root task) in a package script is ALL`,
    file: HELPER,
    from: "  /\\bturbo\\b.*\\/\\/#/,\n",
    to: "",
  }),
  entry({
    name: "F4: keys compared case-sensitively",
    test: UNIT,
    red: `${R2} F4: script paths match case-insensitively (a case-insensitive filesystem)`,
    file: HELPER,
    from: "const key = (p: string): string => stripExt(p).toLowerCase();",
    to: "const key = (p: string): string => stripExt(p);",
  }),
  // --- the hook's fail-closed branches -----------------------------------------
  entry({
    name: "hook: a helper that exits non-zero is read as 'no readers'",
    test: HOOK_TEST,
    red: `${SCEN} helper failure runs every test`,
    file: HOOK,
    from: "|| _sr='__ALL__ the helper exited non-zero'",
    to: "|| _sr=__END__",
  }),
  entry({
    name: "hook: the helper's __ALL__ verdict ignored",
    test: HOOK_TEST,
    red: `${SCEN} globalDependency script runs every test`,
    file: HOOK,
    from: "    if printf '%s\\n' \"$_sr\" | grep -q '^__ALL__'; then",
    to: "    if false; then",
  }),
  entry({
    name: "hook: a printed line that is not a package dir accepted",
    test: HOOK_TEST,
    red: `${SCEN} helper output naming a non-package runs every test`,
    file: HOOK,
    from: "          printf '__ALL__ %s\\n' \"$_d\"",
    to: "          printf '%s\\n' \"$_d\"",
  }),
  // --- check-prepush-subset learned the call -----------------------------------
  entry({
    name: "gate: scope_script_readers accepted with arguments",
    test: UNIT,
    red: `${CALLS} check-prepush-subset accepts the call, and refuses it with arguments`,
    file: GATE,
    from: "        if (cmd.words.length !== 1) {",
    to: "        if (cmd.words.length === 0) {",
  }),
];

await runTampers(TAMPERS, { root: ROOT });
