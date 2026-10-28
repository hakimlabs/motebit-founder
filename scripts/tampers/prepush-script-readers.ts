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
    from: '            if (t.startsWith("scripts/")) stack.push(stripExt(t));',
    to: '            if (t.startsWith("scripts/")) void stripExt(t);',
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
    from: "      if (r.hit || r.opaque) addReader(pkg, f);",
    to: "      if (r.hit) addReader(pkg, f);",
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
    from: "      if (SEGMENT_CALL.test(line)) addReader(pkg, f);",
    to: "      if (SEGMENT_CALL.test(line) && false) addReader(pkg, f);",
  }),
  entry({
    name: "readers: the package's own scripts/ path taken for the root's",
    test: UNIT,
    red: `${REFS} a bare \`scripts/x\` the package has itself is the package's own, not the root's`,
    file: HELPER,
    from: "        if (!local.some((p) => existsSync(join(root, p)))) target = tail;",
    to: "        target = tail;",
  }),
  entry({
    name: "readers: full-line comments read as references",
    test: UNIT,
    red: `${REFS} a full-line comment is not a reference`,
    file: HELPER,
    from: "  if (JS_FAMILY.test(rel) || /\\.jsonc?$/i.test(rel))\n",
    to: "  if (false)\n",
  }),
  entry({
    name: "readers: a data-file mention follows the closure",
    test: UNIT,
    red: `${REFS} a data-file mention reads that exact path, not its closure`,
    file: HELPER,
    from: "    if (!EXECUTABLE.test(rel)) {",
    to: "    if (false) {",
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
