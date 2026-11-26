/**
 * Runs the test suite without depending on shell glob expansion.
 *
 * `node --test test/*.test.ts` needs the *shell* to expand that glob, and on
 * Windows nothing does: npm runs scripts through `cmd.exe` regardless of the
 * shell that invoked npm, and Node's `--test` only accepts glob patterns itself
 * from Node 21 (this package supports >=20). The literal pattern reaches Node as
 * a filename and it exits with `Could not find '…\test\*.test.ts'` — so the
 * Windows CI leg reported failure while actually running zero tests.
 *
 * Enumerating the files here instead means `npm test` behaves identically in
 * cmd.exe, PowerShell, bash and CI, on any supported Node.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempHex } from "./temp-dir.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");

// Sorted so a failure is reported in the same order on every platform and run.
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join("test", f)); // relative: 480 absolute paths overflow Windows' 32,767-character command line

if (files.length === 0) {
  console.error(`✗ no test files found in ${testDir}`);
  process.exit(1);
}

// These hold real time limits against real processes: a clean-tree probe gives git 150 ms, as a
// hook must stay quick, and a wait for a workspace has its own limit. Each file passes on its own, but
// with the other files running beside it git took over 150 ms on every call, so they run after
// the rest, one at a time.
const ALONE = [
  "mcp-connector-review",
  "skills-probes",
  "skills-probes-init-paths-1b",
  "skills-probes-trail-files",
  "skills-prompt",
  "skills-prompt-attacks",
  "skills-session-start",
  "trail-connect-cli",
].map((name) => join("test", `${name}.test.ts`));

// CI splits the suite across jobs with TEST_PART=k/n: part k runs every nth file from the kth, and
// the last part also runs the ALONE files, so they still run one at a time.
const partSpec = process.env.TEST_PART;
const part = partSpec ? /^([1-9]\d*)\/([1-9]\d*)$/.exec(partSpec) : null;
if (partSpec && (!part || Number(part[1]) > Number(part[2]))) {
  console.error(`✗ TEST_PART must be k/n with 1 <= k <= n, not '${partSpec}'`);
  process.exit(1);
}
const [k, n] = part ? [Number(part[1]), Number(part[2])] : [1, 1];

// Several tests `git init` a scratch repo and `git commit` into it to exercise the
// incremental/submodule/ingest git paths. Those commits inherit the developer's
// global git config — so a contributor who signs commits (gpg, or gitsign, whose
// x509 flow opens a browser for OIDC on EVERY commit) gets a signing storm from a
// run that has nothing to do with their identity. Inject config via GIT_CONFIG_*
// (git merges these over the user's config for this process tree only) so test
// commits never sign, without touching anyone's global settings.
const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
};

// Node runs one process per test file, `availableParallelism() - 1` at a time, and
// each starts tsx — enough to pin every core of a shared dev box for minutes.
// GRAFT_TEST_CONCURRENCY caps that; unset keeps Node's default (CI is unchanged).
// A bad value stops the run rather than silently falling back to all cores.
const concurrencyArgs = [];
const rawConcurrency = process.env.GRAFT_TEST_CONCURRENCY;
if (rawConcurrency !== undefined && rawConcurrency !== "") {
  if (!/^[1-9]\d*$/.test(rawConcurrency)) {
    console.error(`✗ GRAFT_TEST_CONCURRENCY must be a positive integer, got '${rawConcurrency}'`);
    process.exit(1);
  }
  concurrencyArgs.push(`--test-concurrency=${rawConcurrency}`);
}

// Tests make thousands of scratch repos and homes under the temp folder and
// don't all remove them: a day of runs left over 50,000 folders (6 GB). Give the
// run its own temp folder and remove it at the end, whatever the outcome.
// Hex-named, as tests' commands hold paths under it (see temp-dir.mjs). For the same reason, off Windows, a
// temp root with an upper-case letter (a `mktemp -d` TMPDIR such as /tmp/tmp.Y07cIIzaIM) is passed over for
// /tmp: under a root with none the secret check can't find a random-looking string in a path. Windows splits
// its paths on '\', so its root is used as it is.
const root = process.platform !== "win32" && /[A-Z]/.test(tmpdir()) ? "/tmp" : tmpdir();
const runTmp = mkdtempHex(join(root, "trail-test-run-"));
const tmpEnv = { TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp };

// The suite runs `init`, hook and skill code that writes to the person's home, so
// no test may see the real one: a run once rewrote ~/.claude/settings.json. Every
// way the code finds a home points inside the run's temp folder, set here before
// any test loads, so it goes with that folder at the end.
const home = join(runTmp, "home");
mkdirSync(home);
// With no global git config of their own, the tests' commits still need a name.
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Trail Tests\n\temail = tests@example.invalid\n[init]\n\tdefaultBranch = main\n");
const homeEnv = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TRAIL_HOME: join(home, ".trail"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
};

// A graft repo moves to trail when a session opens on a machine with the trail
// command, so a contributor who has trail installed would see test repos move.
// Off for the run; the tests of the move turn it back on.
// `npm test -- --coverage` also writes each run's coverage to coverage-<run>.lcov
// for the Codecov upload. V8 writes raw coverage from every process, and c8 maps
// it back to the TypeScript through tsx's source maps. Node's own
// --experimental-test-coverage applies the offsets of tsx's output to the .ts
// file on disk, so it marked comments as missed and executed lines as unrun.
const coverage = process.argv.slice(2).includes("--coverage");
const v8Dir = (run) => join(runTmp, `v8-${run}`);
const runFiles = (list, run, ...flags) =>
  spawnSync(process.execPath, ["--import", "tsx", "--test", ...concurrencyArgs, ...flags, ...list], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...gitEnv,
      ...tmpEnv,
      ...homeEnv,
      GRAFT_NO_TRAIL_SWITCH: "1",
      ...(coverage ? { NODE_V8_COVERAGE: v8Dir(run) } : {}),
    },
  });
const report = (run) =>
  spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "c8", "bin", "c8.js"),
      "report",
      `--temp-directory=${v8Dir(run)}`,
      `--reports-dir=${join(runTmp, `report-${run}`)}`,
      "--reporter=lcovonly",
      "--exclude-after-remap",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
const shared = files.filter((f) => !ALONE.includes(f)).filter((_, i) => i % n === k - 1);
const alone = k === n ? files.filter((f) => ALONE.includes(f)) : [];
const runs = [["main", shared, []]];
if (alone.length > 0) runs.push(["alone", alone, ["--test-concurrency=1"]]);
const results = runs.map(([run, list, flags]) => runFiles(list, run, ...flags));
if (coverage) {
  for (const [run] of runs) {
    const result = report(run);
    results.push(result);
    if (result.status === 0) copyFileSync(join(runTmp, `report-${run}`, "lcov.info"), join(repoRoot, `coverage-${run}.lcov`));
  }
}
try {
  rmSync(runTmp, { recursive: true, force: true });
} catch {
  /* best effort: a locked file on Windows must not fail the run */
}

for (const result of results) {
  if (result.error) {
    console.error(`✗ could not start the test runner: ${result.error.message}`);
    process.exit(1);
  }
  // A signal-killed run reports null status; treat anything non-zero as failure.
  if (result.status !== 0) process.exit(result.status ?? 1);
}
