import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  correctionPhrase,
  LESSON_MAX,
  lessonLine,
  lessonLines,
  lessonRefused,
  lessonText,
  readLessons,
  writeLesson,
  type Lesson,
} from "../src/skills/lessons.js";
import { skillsDir } from "../src/skills/store-fs.js";
import { tmpRepo } from "./helpers.js";

const ordinary: Lesson = {
  id: "ls-12ab34",
  skill: "review-preview",
  at: "2026-11-03",
  text: "Keep the preview local",
  kind: "lesson",
  src: "correction",
  wall: null,
};

describe("lesson wording edge cases", () => {
  let restoreFetch: (() => void) | undefined;
  const roots: string[] = [];

  before(() => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("Lesson tests must not use the network");
    });
    restoreFetch = () => fetchMock.mock.restore();
  });

  after(() => {
    restoreFetch?.();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("keeps a whole word at 80 characters but does not keep a partial word", () => {
    const shorter = "keep the generated manifest beside the release notes for every";
    const lesson = `${shorter} build`;
    const said = `remember to ${lesson}`;
    assert.equal(said.length, 80);
    assert.deepEqual(correctionPhrase(`${said}.`), { said, lesson, kind: "lesson" });
    assert.deepEqual(
      correctionPhrase(`Actually, ${said} so reviewers can find it.`),
      { said, lesson, kind: "lesson" },
    );
    assert.deepEqual(correctionPhrase(`${said}s.`), {
      said: `remember to ${shorter}`,
      lesson: shorter,
      kind: "lesson",
    });
  });

  test("drops a word that would be cut in the middle at the clause limit", () => {
    const lesson = "keep a copy of the generated manifest with the release notes";
    const said = `remember to ${lesson}`;
    assert.deepEqual(correctionPhrase(`${said} permanently.`), {
      said,
      lesson,
      kind: "lesson",
    });
  });

  test("does not make a lesson when the clause limit leaves only the correction cue", () => {
    const command = `render-preview-${"abcdef".repeat(12)}`;
    assert.equal(correctionPhrase(`Remember to ${command}.`), null);
    assert.deepEqual(correctionPhrase("Remember to render-preview."), {
      said: "Remember to render-preview",
      lesson: "render-preview",
      kind: "lesson",
    });
  });

  test("puts longer parameters back first and ignores short and non-string values", () => {
    // Untyped callers can supply a number; it must not be treated as a string parameter.
    const params = {
      version: "1.4.3",
      artifact: "build-v1.4.3",
      mode: "q",
      retries: 42,
    } as unknown as Record<string, string>;

    assert.equal(
      lessonText(
        { lesson: "Record the build details" },
        "echo build-v1.4.3 v1.4.3 11.4.3 1.4.30 q 42",
        params,
      ),
      "Record the build details: echo {artifact} v{version} 11.4.3 1.4.30 q 42",
    );
  });

  test("matches parameter values literally and leaves the same text inside a longer name", () => {
    assert.equal(
      lessonText(
        { lesson: "Render the selected draft" },
        "node preview.mjs draft+[1] archived-draft+[1] xdraft+[1] draftX1",
        { draft: "draft+[1]" },
      ),
      "Render the selected draft: node preview.mjs {draft} archived-{draft} xdraft+[1] draftX1",
    );
  });

  test("keeps the fix unchanged when no parameter is eligible for substitution", () => {
    const phrase = { lesson: "Render the selected draft" };
    const fix = "node preview.mjs --mode q --retries 42";
    const expected = `${phrase.lesson}: ${fix}`;
    assert.equal(
      lessonText(phrase, fix, { mode: "q", label: "", retries: 42 } as unknown as Record<string, string>),
      expected,
    );
    assert.equal(lessonText(phrase, fix, undefined as unknown as Record<string, string>), expected);
  });

  test("keeps a complete fix at the text limit and omits a fix that would be cut", () => {
    const phrase = { lesson: "Render the selected draft" };
    const prefix = "node preview.mjs --label ";
    const fix = prefix + "x".repeat(LESSON_MAX - phrase.lesson.length - 2 - prefix.length);
    assert.equal(lessonText(phrase, fix, {}), `${phrase.lesson}: ${fix}`);
    assert.equal(lessonText(phrase, `${fix}x`, {}), phrase.lesson);
  });

  test("renders explicit and inferred guardrails differently from ordinary lessons", () => {
    assert.equal(lessonLine(ordinary), "New learning (the person, Nov 3): Keep the preview local");
    assert.equal(
      lessonLine({ ...ordinary, kind: "guardrail" }),
      "Always follow (the person, Nov 3): Keep the preview local",
    );
    assert.equal(
      lessonLine({ ...ordinary, text: "Do not attach draft notes" }),
      "Always follow (the person, Nov 3): Do not attach draft notes",
    );
    assert.equal(
      lessonLine({ ...ordinary, text: "Nevertheless keep the preview local" }),
      "New learning (the person, Nov 3): Nevertheless keep the preview local",
    );
  });

  test("retains an old guardrail inferred from its text when ordinary lessons are trimmed", () => {
    const guardrail: Lesson = { ...ordinary, at: "2026-11-01", text: "[graft] Never attach draft notes" };
    const lessons = [
      { ...ordinary, at: "2026-11-06", text: "Link to the review checklist" },
      ordinary,
      guardrail,
      { ...ordinary, at: "2026-11-05", text: "Include a preview title" },
      { ...ordinary, at: "2026-11-04", text: "Use the draft template" },
    ];
    assert.deepEqual(lessonLines(lessons), [
      "Always follow (the person, Nov 1): Never attach draft notes",
      "New learning (the person, Nov 4): Use the draft template",
      "New learning (the person, Nov 5): Include a preview title",
      "New learning (the person, Nov 6): Link to the review checklist",
    ]);
  });

  test("saves an explicit guardrail but classifies a hand-edited lesson by its text", () => {
    const root = tmpRepo("lesson-kind");
    roots.push(root);
    const env = { TRAIL_HOME: join(root, "trail") };
    const skillDir = join(skillsDir(env), "review-preview");
    mkdirSync(skillDir, { recursive: true });

    const path = writeLesson({ ...ordinary, kind: "guardrail" }, "github.com/acme/shop", env);
    assert.equal(path, join(skillDir, "lessons", `${ordinary.at}-1.md`));
    const saved = readFileSync(path, "utf8");
    assert.match(saved, /^kind: "guardrail"$/m);
    assert.deepEqual(readLessons(skillDir), [ordinary]);

    const text = "Don't attach draft notes";
    writeFileSync(
      path,
      saved.replace('kind: "guardrail"', 'kind: "lesson"').replace(ordinary.text, text),
      "utf8",
    );
    assert.deepEqual(readLessons(skillDir), [{ ...ordinary, text, kind: "guardrail" }]);

    const inferred: Lesson = { ...ordinary, id: "ls-65ab43", text: "ASK FIRST before replacing the preview" };
    const second = writeLesson(inferred, "github.com/acme/shop", env);
    assert.equal(second, join(skillDir, "lessons", `${ordinary.at}-2.md`));
    assert.match(readFileSync(second, "utf8"), /^kind: "guardrail"$/m);
    assert.deepEqual(readLessons(skillDir), [
      { ...ordinary, text, kind: "guardrail" },
      { ...inferred, kind: "guardrail" },
    ]);
  });

  test("keeps a correction that adds an ask even when its fix command has a --no flag", () => {
    const phrase = correctionPhrase("Please ask me first before replacing the preview.");
    assert.deepEqual(phrase, {
      said: "ask me first before replacing the preview",
      lesson: "ask first before replacing the preview",
      kind: "guardrail",
    });
    assert.ok(phrase);
    const text = lessonText(phrase, "node preview.mjs --no-cache", {});
    assert.equal(text, "ask first before replacing the preview: node preview.mjs --no-cache");
    assert.equal(lessonRefused(text), null);
  });

  test("does not manufacture an action from a bare correction or reverse its negation", () => {
    assert.equal(correctionPhrase("Please ask me first."), null);
    assert.equal(correctionPhrase("No need to ask first before replacing the preview."), null);
  });

  test("recognizes asks both with and without a named action", () => {
    assert.equal(lessonRefused("Please always confirm with me first."), null);
    assert.equal(lessonRefused("Never replace the draft without asking me."), null);
    assert.equal(lessonRefused("You should always ask us before replacing the preview."), null);
    assert.equal(lessonRefused("Do not replace the preview until you ask me."), null);
    assert.equal(lessonRefused("Always check with me first."), null);
    assert.equal(lessonRefused("Always ask."), null);
  });

  test("refuses ask commentary and a negated action in an ask form", () => {
    const reason = "talks about asking without adding it";
    assert.equal(lessonRefused("Asking me takes too long."), reason);
    assert.equal(lessonRefused("Ask first before you decide not to show the preview."), reason);
    assert.equal(lessonRefused("Ask first before replacing the preview without a watermark."), reason);
    assert.equal(lessonRefused("Never render a draft without a watermark until you ask me."), reason);
  });

  test("recognizes references to sign-off even when the lesson does not add an ask", () => {
    const reason = "talks about asking without adding it";
    for (const text of [
      "Remember to ask",
      "Ask, then replace the preview.",
      "The reviewer asks for my sign-off.",
      "The reviewer asked for an okay.",
      "The preview status says it will ask again.",
      "Confirming before edits takes time.",
      "Checking with them delays the preview.",
      "The checklist mentions approval.",
      "The reviewer wants my yes before showing the preview.",
      "The review waits for me before generating a preview.",
    ]) {
      assert.equal(lessonRefused(text), reason, text);
    }
  });

  test("distinguishes skipping the ask from requiring it before an edit", () => {
    assert.equal(lessonRefused("Never ask me about the preview."), "skips the ask");
    assert.equal(lessonRefused("Replace the draft without asking me."), "skips the ask");
    assert.equal(lessonRefused("Never replace the draft without my approval."), null);
  });

  test("does not mistake a program prompt for an instruction about asking the person", () => {
    assert.equal(lessonRefused("The formatter is asking for a filename."), null);
    assert.equal(lessonRefused("The preview tool confirms its output location."), null);
  });
});
