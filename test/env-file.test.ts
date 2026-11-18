/**
 * Trail runs inside checkouts other people wrote, so the working folder's `.env` must set nothing
 * for it: a `GIT_CONFIG_*` there would make the person's git run the checkout's script, and a
 * `NODE_OPTIONS` would reach the Node programs trail starts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the working folder's .env sets nothing for trail", (t) => {
  const here = mkdtempSync(join(tmpdir(), "env-file-"));
  t.after(() => rmSync(here, { recursive: true, force: true }));
  writeFileSync(join(here, ".env"), "GRAFT_UPDATE_CHECK=1\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: here, USERPROFILE: here };
  delete env.GRAFT_UPDATE_CHECK;
  delete env.DO_NOT_TRACK;
  delete env.DOTENV_CONFIG_PATH;
  const r = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "telemetry", "status"],
    { cwd: here, env, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /update check: off/, "GRAFT_UPDATE_CHECK=1 in the working folder's .env turned the update check on");
});
