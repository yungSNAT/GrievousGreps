/**
 * Gaps in src/skills/store.ts: listSkills / findSkill scope filtering (a name not found gives null),
 * readSkill with and without the caller's known state, and every answer nameTaken can give.
 * Each test has its own Trail home in a scratch folder.
 */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BUILT_IN_NAMES, findSkill, forgetSkill, listAllPersonal, listSkills, nameTaken, personalSkillsDir,
  readSkill, restoreSkill, saveHeld,
} from "../src/skills/store.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import { tmpRepo } from "./helpers.js";
import { releaseSkill } from "./skills-recall-fixtures.js";

void mock;
const dirs: string[] = [];
const mk = (tag: string): string => {
  const d = tmpRepo(tag);
  dirs.push(d);
  return d;
};

before(() => { /* each test makes its own home */ });
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Box { env: NodeJS.ProcessEnv; checkout: string }

function box(tag: string): Box {
  const home = mk(`store-gaps-${tag}`);
  const checkout = join(home, "checkout");
  mkdirSync(checkout, { recursive: true });
  return { env: { TRAIL_HOME: join(home, "trail") }, checkout };
}

/** A Trail skill as Trail renders it, put straight into a folder. */
function skillText(name: string, trail: string, applies?: string): string {
  const meta: Record<string, unknown> = { trail };
  if (applies !== undefined) meta.applies = applies;
  return renderSkillMd(releaseSkill(meta as never, { name }) as never);
}

function putPersonal(env: NodeJS.ProcessEnv, name: string, trail: string, applies?: string): string {
  const dir = join(personalSkillsDir(env), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillText(name, trail, applies));
  return dir;
}

describe("listSkills and findSkill", () => {
  test("only skills applying to the repo keys or every repo are listed; an unknown name finds nothing", () => {
    const b = box("list");
    putPersonal(b.env, "deploy-all", "s-0000b1", "every repo");
    putPersonal(b.env, "deploy-other", "s-0000b2", "other-repo");
    putPersonal(b.env, "deploy-shop", "s-0000b3", "shop");
    const ctx = { repoKeys: ["Shop"], checkout: b.checkout, env: b.env };

    const names = listSkills(ctx).map((r) => r.name).sort();
    assert.deepEqual(names, ["deploy-all", "deploy-shop"]);

    const all = listAllPersonal(b.env).map((r) => r.name).sort();
    assert.deepEqual(all, ["deploy-all", "deploy-other", "deploy-shop"]);

    const found = findSkill("deploy-shop", ctx);
    assert.ok(found);
    assert.equal(found.name, "deploy-shop");
    assert.equal(found.id, "s-0000b3");

    assert.equal(findSkill("deploy-other", ctx), null, "out of scope");
    assert.equal(findSkill("no-such-skill", ctx), null, "not there at all");
  });

  test("a home with no skills folder lists nothing", () => {
    const b = box("empty");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    assert.deepEqual(listSkills(ctx), []);
    assert.equal(findSkill("anything", ctx), null);
  });
});

describe("readSkill", () => {
  test("reads a personal skill with the caller's known state, with none, and with no known given", () => {
    const b = box("read");
    putPersonal(b.env, "deploy-shop", "s-0000c1", "shop");
    const [ref] = listAllPersonal(b.env);
    assert.ok(ref);

    const viaNull = readSkill(ref, null);
    assert.equal(viaNull?.meta.trail, "s-0000c1");

    const viaActive = readSkill(ref, { status: "active" });
    assert.equal(viaActive?.meta.trail, "s-0000c1");

    const viaNeedsFix = readSkill(ref, { status: "needs-fix" });
    assert.equal(viaNeedsFix?.meta.trail, "s-0000c1", "the skill still reads");

    const viaState = readSkill(ref);
    assert.equal(viaState?.meta.trail, "s-0000c1");
    assert.equal(viaState?.hash, viaNull?.hash);
  });

  test("a missing file reads as null; a non-personal ref skips the state check", () => {
    const b = box("read2");
    putPersonal(b.env, "deploy-shop", "s-0000c2", "shop");
    const [ref] = listAllPersonal(b.env);
    assert.ok(ref);
    assert.equal(readSkill({ ...ref, file: join(ref.dir, "MISSING.md") }), null);
    const repoRef = { ...ref, scope: "repo" as typeof ref.scope };
    assert.equal(readSkill(repoRef)?.meta.trail, "s-0000c2");
  });
});

describe("nameTaken", () => {
  test("a name that is not one folder name is invalid, and forget/restore treat it as unknown", () => {
    const b = box("invalid");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    assert.equal(nameTaken("a/b", ctx), "invalid");
    assert.equal(nameTaken("..", ctx), "invalid");
    assert.deepEqual(forgetSkill("a/b", b.env), { ok: false, reason: "unknown" });
    assert.deepEqual(restoreSkill("a/b", b.env), { ok: false, reason: "unknown" });
  });

  test("a built-in name is built-in; a free name is null", () => {
    const b = box("builtin");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    const builtIn = [...BUILT_IN_NAMES][0];
    assert.ok(builtIn);
    assert.equal(nameTaken(builtIn, ctx), "built-in");
    assert.equal(nameTaken("zz-free-name-q9", ctx), null);
  });

  test("personal, then retired after forget, then personal again after restore", () => {
    const b = box("retired");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    const now = new Date("2024-05-01T12:00:00Z");
    putPersonal(b.env, "deploy-shop", "s-0000d1", "shop");
    assert.equal(nameTaken("deploy-shop", ctx), "personal");

    const first = forgetSkill("deploy-shop", b.env, now);
    assert.equal(first.ok, true);
    assert.ok(first.ok && existsSync(first.to));
    assert.ok(first.ok && basename(first.to).startsWith("deploy-shop-"));
    assert.equal(nameTaken("deploy-shop", ctx), "retired");

    putPersonal(b.env, "deploy-shop", "s-0000d2", "shop");
    const second = forgetSkill("deploy-shop", b.env, now);
    assert.ok(second.ok && basename(second.to) === `${basename(first.ok ? first.to : "")}-2`);
    assert.deepEqual(forgetSkill("deploy-shop", b.env, now), { ok: false, reason: "unknown" });

    const back = restoreSkill("deploy-shop", b.env, now);
    assert.equal(back.ok, true);
    assert.ok(back.ok && back.ref.name === "deploy-shop");
    assert.ok(back.ok && back.ref.id === "s-0000d2", "the newest copy comes back");
    assert.equal(nameTaken("deploy-shop", ctx), "personal");
    assert.deepEqual(restoreSkill("deploy-shop", b.env, now), { ok: false, reason: "name-taken" });
  });

  test("a held item's name is held", () => {
    const b = box("held");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    saveHeld(releaseSkill({ trail: "s-0000e1" } as never, { name: "held-one" }) as never, "no-yes",
      { host: "claude", job: "release", repoKey: "shop" } as never, b.env, new Date("2024-05-01T12:00:00Z"));
    assert.equal(nameTaken("held-one", ctx), "held");
  });

  test("in the checkout, a Trail skill is repo and anything else is host", () => {
    const b = box("checkout");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    const repoDir = join(b.checkout, ".agents", "skills", "repo-skill");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "SKILL.md"), skillText("repo-skill", "s-0000f1", "shop"));
    assert.equal(nameTaken("repo-skill", ctx), "repo");

    const hostDir = join(b.checkout, ".claude", "skills", "host-skill");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, "SKILL.md"), "---\nname: host-skill\ndescription: plain\n---\nDo it.\n");
    assert.equal(nameTaken("host-skill", ctx), "host");

    assert.equal(nameTaken("repo-skill", { ...ctx, checkout: "" }), null, "no checkout looked at");
  });

  test("a skill in a joined team's skills folder is team", () => {
    const b = box("team");
    const ctx = { repoKeys: ["shop"], checkout: b.checkout, env: b.env };
    mkdirSync(join(b.env.TRAIL_HOME!, "teams", "acme", "skills", "team-skill"), { recursive: true });
    assert.equal(nameTaken("team-skill", ctx), "team");
    assert.equal(nameTaken("other-skill-q7", ctx), null);
  });
});
