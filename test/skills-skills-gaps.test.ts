import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  confirm, fold, getSkill, isConfirmed, learn, listSkills, parseTakeaway,
  publish, renderTakeaway, skillDirs, skillForAgent, skillsDirective, skillStatus,
  waiting,
} from "../src/skills/skills.js";
import { tmpRepo } from "./helpers.js";

const DAY = "2026-10-07";
const scratchDirs: string[] = [];

function scratch(tag: string): string {
  const dir = tmpRepo(`skills-gaps-${tag}`);
  scratchDirs.push(dir);
  return dir;
}

function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function writeSkill(root: string, name: string): string {
  const file = join(root, name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: Instructions for ${name}.\n---\n\n# ${name}\n\nCheck the inputs before starting.\n`);
  return file;
}

describe("skills storage and readback", () => {
  const previousTrailHome = process.env.TRAIL_HOME;

  before(() => {
    const home = mkdtempSync(join(tmpdir(), "skills-gaps-home-"));
    scratchDirs.push(home);
    process.env.TRAIL_HOME = realpathSync(home);
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Skills tests must stay offline");
    });
  });

  after(() => {
    mock.restoreAll();
    if (previousTrailHome === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = previousTrailHome;
    for (const dir of scratchDirs.reverse()) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test("takeaway metadata round-trips punctuation, whitespace, and a folded version", () => {
    const path = join(scratch("metadata"), "review.md");
    const takeaway = {
      skill: "review-layout",
      taughtBy: 'Sam: "Docs"',
      date: DAY,
      from: "correction",
      confirmedBy: ['sAM: "dOCS"', "Priya, QA", "Lee"],
      section: "Page boxes ",
      foldedIn: 4,
      text: "Compare the crop box with the media box.",
    };

    const rendered = renderTakeaway(takeaway);
    assert.ok(rendered.includes('section: "Page boxes "\n'));
    const parsed = parseTakeaway(rendered, path, "fallback");
    assert.deepEqual(parsed, { ...takeaway, path });
    assert.ok(parsed);
    assert.equal(isConfirmed(parsed), true);
    assert.equal(isConfirmed({ ...parsed, confirmedBy: ['sAM: "dOCS"'] }), false);

    const legacy = parseTakeaway(
      '---\nfolded_in: "4"\n---\n\nCheck the page count first.\n',
      path,
      "review-layout",
    );
    assert.ok(legacy);
    assert.equal(legacy.skill, "review-layout");
    assert.equal(legacy.foldedIn, undefined, "only a numeric version marks a takeaway as folded");
    assert.deepEqual(legacy.confirmedBy, []);
    assert.equal(legacy.from, "correction");
    assert.equal(parseTakeaway("---\nconfirmed_by: [\n---\n\nBroken metadata.\n", path, "review-layout"), null);
    assert.equal(parseTakeaway(" \n\n", path, "review-layout"), null);
  });

  test("reading a skill skips unreadable and malformed takeaways without losing valid ones", () => {
    const dir = scratch("takeaway-files");
    const { takeaway } = learn(dir, {
      skill: "check-proofs", author: "Lee", date: DAY, text: "Compare the proof with the source.",
    });
    const takeawaysDir = dirname(takeaway.path);
    // An interrupted import left a directory where a Markdown file should be.
    mkdirSync(join(takeawaysDir, "000-unreadable.md"));
    writeFileSync(join(takeawaysDir, "001-malformed.md"), "---\nconfirmed_by: [\n---\n\nReject this draft.\n");
    writeFileSync(join(takeawaysDir, "notes.txt"), "Personal notes, not a takeaway.");

    const reloaded = getSkill(dir, "Check proofs");
    assert.ok(reloaded);
    assert.deepEqual(
      reloaded.takeaways.map(({ path, text }) => ({ path, text })),
      [{ path: takeaway.path, text: takeaway.text }],
    );
  });

  test("listing follows in-checkout directory links once and prefers the repo copy", () => {
    const dir = scratch("discovery");
    assert.deepEqual(listSkills(dir), []);
    const dirs = skillDirs(dir);
    assert.equal(dirs.repo, join(dirs.repoRoot, ".claude", "skills"));
    mkdirSync(dirs.repo, { recursive: true });

    const shared = writeSkill(join(dirs.repoRoot, ".agents", "skills"), "alpha");
    // Create the later alias first: alphabetical order, not creation order, wins.
    linkDirectory(dirname(shared), join(dirs.repo, "zulu-alias"));
    linkDirectory(dirname(shared), join(dirs.repo, "alpha"));

    const outside = scratch("outside");
    const external = writeSkill(outside, "external");
    linkDirectory(dirname(external), join(dirs.repo, "external"));
    const gone = join(outside, "gone");
    mkdirSync(gone);
    linkDirectory(gone, join(dirs.repo, "dangling"));
    rmSync(gone, { recursive: true });
    if (process.platform !== "win32") {
      symlinkSync(shared, join(dirs.repo, "file-link"), "file");
    }

    writeFileSync(join(dirs.repo, "README.md"), "These are the team's skills.\n");
    mkdirSync(join(dirs.repo, "empty"));
    mkdirSync(join(dirs.repo, "unreadable", "SKILL.md"), { recursive: true });
    writeSkill(dirs.repo, "trail");

    learn(dir, {
      skill: "beta", author: "Lee", date: DAY, text: "Keep a copy of the original.",
    });
    const teamFile = writeSkill(dirs.repo, "beta");
    const local = learn(dir, {
      skill: "gamma", author: "Lee", date: DAY, text: "Check the title before sharing.",
    });

    const listed = listSkills(dir);
    assert.deepEqual(
      listed.map(({ name, where, file, trailOwned }) => ({ name, where, file, trailOwned })),
      [
        { name: "alpha", where: "repo", file: join(dirs.repo, "alpha", "SKILL.md"), trailOwned: false },
        { name: "beta", where: "repo", file: teamFile, trailOwned: false },
        { name: "gamma", where: "home", file: local.skill.file, trailOwned: true },
      ],
    );
    assert.equal(listed[0]?.description, "Instructions for alpha.");
    assert.equal(listed[1]?.takeaways[0]?.text, "Keep a copy of the original.");
    assert.equal(getSkill(dir, "external"), null);
  });

  test("a second reviewer unlocks only the selected takeaway for a confirmed fold", () => {
    const dir = scratch("confirmed-fold");
    const name = "pdf-boxes";
    const input = { skill: "PDF boxes", author: "Sam", date: DAY };
    const first = learn(dir, {
      ...input, text: "Check the page rotation.\n  Transform the page box.", section: "  Rotation  ",
    });
    const second = learn(dir, { ...input, text: "Keep the original page box for comparison." });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.notEqual(first.takeaway.path, second.takeaway.path);

    const initialPage = readFileSync(first.skill.file, "utf8");
    const notReady = fold(dir, name, { confirmed: true });
    assert.ok(notReady);
    assert.equal(notReady.to, 1);
    assert.equal(notReady.stillWaiting, 2);
    assert.deepEqual(notReady.folded, []);
    assert.equal(readFileSync(first.skill.file, "utf8"), initialPage);

    const firstStem = basename(first.takeaway.path, ".md");
    assert.deepEqual(confirm(dir, name, "sAM", firstStem), []);
    const reviewed = confirm(dir, name, "Priya, QA", firstStem);
    assert.deepEqual(reviewed.map((t) => t.path), [first.takeaway.path]);
    assert.deepEqual(confirm(dir, name, "PRIYA, qa", basename(first.takeaway.path)), []);

    const ready = getSkill(dir, name);
    assert.ok(ready);
    const pending = waiting(ready);
    assert.deepEqual(pending.map((t) => t.path), [first.takeaway.path, second.takeaway.path]);
    assert.deepEqual(pending.map((t) => t.confirmedBy), [["Priya, QA"], []]);
    assert.match(skillStatus(ready), /2 takeaways waiting to fold \(1 confirmed\)/);

    const shown = skillForAgent(ready);
    assert.match(shown, /## Corrections since v1/);
    const flatFirst = "Check the page rotation. Transform the page box.";
    const firstAt = shown.indexOf(flatFirst);
    const secondAt = shown.indexOf(second.takeaway.text);
    assert.ok(secondAt >= 0 && firstAt > secondAt, "later correction comes first, even on the same date");

    const folded = fold(dir, name, { confirmed: true });
    assert.ok(folded);
    assert.equal(folded.from, 1);
    assert.equal(folded.to, 2);
    assert.equal(folded.stillWaiting, 1);
    assert.deepEqual(folded.sections, ["Rotation"]);
    assert.deepEqual(folded.folded.map((t) => t.path), [first.takeaway.path]);
    const page = readFileSync(folded.file, "utf8");
    assert.ok(page.includes(`## Rotation\n- ${flatFirst}`));
    assert.ok(!page.includes(second.takeaway.text));

    const afterFold = getSkill(dir, name);
    assert.ok(afterFold);
    assert.equal(afterFold.takeaways.find((t) => t.path === first.takeaway.path)?.foldedIn, 2);
    assert.deepEqual(waiting(afterFold).map((t) => t.path), [second.takeaway.path]);
    assert.deepEqual(confirm(dir, name, "Lee", firstStem), []);

    const remaining = fold(dir, name);
    assert.ok(remaining);
    assert.equal(remaining.to, 3);
    assert.deepEqual(remaining.sections, ["Takeaways"]);
    assert.ok(readFileSync(remaining.file, "utf8").includes(`## Takeaways\n- ${second.takeaway.text}`));
    const current = getSkill(dir, name);
    assert.ok(current);
    assert.deepEqual(current.takeaways.map((t) => t.foldedIn), [2, 3]);
    assert.deepEqual(waiting(current), []);
    assert.match(skillStatus(current), /^v3 · up to date/);
    assert.doesNotMatch(skillForAgent(current), /## Corrections since/);
  });

  test("a hand-written skill keeps its confirmed correction without a rewrite", () => {
    const dir = scratch("hand-written");
    const name = "ship-docs";
    const file = writeSkill(skillDirs(dir).repo, name);
    const original = readFileSync(file, "utf8");
    const { takeaway } = learn(dir, {
      skill: name, author: "Lee", date: DAY, text: "Run the link checker before publishing.",
    });
    assert.deepEqual(confirm(dir, name, "Priya").map((t) => t.path), [takeaway.path]);

    const result = fold(dir, name, { confirmed: true });
    assert.ok(result);
    assert.equal(result.left, "hand-written");
    assert.equal(result.to, result.from);
    assert.equal(result.stillWaiting, 1);
    assert.deepEqual(result.folded, []);
    assert.equal(readFileSync(file, "utf8"), original);
    const reloaded = getSkill(dir, name);
    assert.ok(reloaded);
    assert.deepEqual(waiting(reloaded).map((t) => t.path), [takeaway.path]);
  });

  test("publish refuses an external directory link, then moves only SKILL.md to the repo", () => {
    const dir = scratch("publish");
    const name = "review-charts";
    assert.deepEqual(publish(dir, name), { ok: false, reason: "unknown" });
    assert.equal(skillsDirective(dir), "");

    const { skill, takeaway } = learn(dir, {
      skill: name, author: "Priya", date: DAY, text: "Label both axes with their units.",
    });
    const original = readFileSync(skill.file, "utf8");
    const corrections = dirname(takeaway.path);
    assert.ok(skillsDirective(dir).includes(`${name} (on this machine: ${skill.file}, then 1 correction in ${corrections})`));

    const targetDir = join(skillDirs(dir).repo, name);
    const target = join(targetDir, "SKILL.md");
    const outside = scratch("publish-outside");
    mkdirSync(dirname(targetDir), { recursive: true });
    linkDirectory(outside, targetDir);
    assert.deepEqual(publish(dir, name), { ok: false, reason: "link" });
    assert.equal(existsSync(join(outside, "SKILL.md")), false);
    assert.equal(readFileSync(skill.file, "utf8"), original);
    rmSync(targetDir, { recursive: true });

    assert.deepEqual(publish(dir, name), { ok: true, file: target });
    assert.equal(existsSync(skill.file), false);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.deepEqual(publish(dir, name), { ok: false, reason: "in-repo" });
    const published = getSkill(dir, name);
    assert.ok(published);
    assert.equal(published.where, "repo");
    assert.deepEqual(waiting(published).map((t) => t.path), [takeaway.path]);
    assert.ok(skillsDirective(dir).includes(`${name} (1 correction newer than its SKILL.md, in ${corrections})`));

    const result = fold(dir, name);
    assert.ok(result);
    assert.equal(result.file, target);
    assert.deepEqual(result.folded.map((t) => t.path), [takeaway.path]);
    assert.ok(readFileSync(target, "utf8").includes(`- ${takeaway.text}`));
    assert.equal(skillsDirective(dir), "");
  });
});
