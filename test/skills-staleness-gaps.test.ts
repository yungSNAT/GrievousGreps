import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { dropPhrase, noteCueResult, phraseSha } from "../src/skills/staleness.js";
import { skillHash } from "../src/skills/skillmd.js";
import { MAX_SKILL_BYTES } from "../src/skills/store-fs.js";
import type { SkillRef, SkillState } from "../src/skills/types.js";
import { tmpRepo } from "./helpers.js";

const ID = "s-7f3a2c";
const NAME = "release-npm";
const PUBLISH = phraseSha("publish");

function state(extra: Partial<SkillState> = {}): SkillState {
  return {
    name: NAME,
    scope: "personal",
    status: "active",
    from: "repeated",
    runId: null,
    addedAt: "2026-07-01T10:00:00.000Z",
    lastWorked: null,
    lastUsedAt: null,
    lastUsedRepo: null,
    uses: 0,
    checkedUses: 0,
    hash: skillHash("previous skill contents"),
    source: null,
    lastFails: [],
    promoteOffers: {},
    ...extra,
  };
}

test("phraseSha normalizes text and hashes nullish JavaScript inputs as empty", () => {
  assert.equal(phraseSha(" \tHELLO\n  WORLD "), "b94d27b9");
  assert.equal(phraseSha(" Cafe\u0301\tRelease "), phraseSha("café release"));
  assert.equal(phraseSha(""), "e3b0c442");
  for (const missing of [null, undefined]) {
    assert.equal(phraseSha(missing as unknown as string), "e3b0c442");
  }
});

describe("noteCueResult", () => {
  test("ignores a missing cue or an invalid digest without changing the counts", () => {
    const st = state({ cueMisses: { [PUBLISH]: 1 } });
    for (const sha of [null, "", "publish", "deadbeeg"]) {
      assert.deepEqual(noteCueResult(st, sha, false), { drop: false });
      assert.deepEqual(st.cueMisses, { [PUBLISH]: 1 });
    }
  });

  test("starts a fresh count when persisted cue counts are absent or not a record", () => {
    for (const stored of [undefined, null, 4, "broken", [2]]) {
      const st = state();
      if (stored !== undefined) {
        st.cueMisses = stored as unknown as NonNullable<SkillState["cueMisses"]>;
      }

      assert.deepEqual(noteCueResult(st, PUBLISH, false), { drop: false });
      assert.deepEqual(st.cueMisses, { [PUBLISH]: 1 });
    }
  });

  test("cleans invalid persisted entries while clearing a followed cue", () => {
    const other = phraseSha("pack");
    const persisted = {
      [PUBLISH]: 1,
      [other]: 3,
      "raw phrase": 7,
      a0000001: "2",
      a0000002: Infinity,
      a0000003: NaN,
      a0000004: 0,
      a0000005: -1,
    };
    const st = state({ cueMisses: persisted as unknown as SkillState["cueMisses"] });

    assert.deepEqual(noteCueResult(st, PUBLISH, true), { drop: false });
    assert.deepEqual(st.cueMisses, { [other]: 3 });
  });

  test("requests a drop on the second consecutive miss, and following resets the streak", () => {
    const st = state();

    assert.deepEqual(noteCueResult(st, PUBLISH, false), { drop: false });
    assert.deepEqual(st.cueMisses, { [PUBLISH]: 1 });
    assert.deepEqual(noteCueResult(st, PUBLISH, false), { drop: true });
    assert.deepEqual(st.cueMisses, { [PUBLISH]: 2 });

    assert.deepEqual(noteCueResult(st, PUBLISH, true), { drop: false });
    assert.deepEqual(st.cueMisses, {});
    assert.deepEqual(noteCueResult(st, PUBLISH, false), { drop: false });
    assert.deepEqual(st.cueMisses, { [PUBLISH]: 1 });
  });

  test("evicts the oldest count when recording a new cue at capacity", () => {
    const keys = Array.from({ length: 21 }, (_, i) => `a${i.toString(16).padStart(7, "0")}`);
    const counts = (digests: string[]) => Object.fromEntries(digests.map((sha) => [sha, 1]));
    const st = state({ cueMisses: counts(keys.slice(0, 20)) });

    assert.deepEqual(noteCueResult(st, keys[20]!, false), { drop: false });
    assert.deepEqual(st.cueMisses, counts(keys.slice(1)));
  });
});

describe("dropPhrase file guards", () => {
  let root: string;

  before(() => {
    root = tmpRepo("skills-staleness-gaps");
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function refFor(label: string): SkillRef {
    const dir = join(root, label, NAME);
    mkdirSync(dir, { recursive: true });
    // dropPhrase only needs the identity and paths, not an indexed skill.
    return { id: ID, name: NAME, dir, file: join(dir, "SKILL.md") } as SkillRef;
  }

  function assertRejectedBeforeRead(ref: SkillRef): void {
    const st = state();
    const hash = st.hash;
    const read = mock.method(fs, "readFileSync");
    try {
      syncBuiltinESMExports();
      assert.equal(dropPhrase(ref, st, PUBLISH), false);
      assert.equal(st.hash, hash);
      assert.equal(
        read.mock.calls.some((call) => call.arguments[0] === ref.file),
        false,
        "an unsuitable skill file must be rejected before reading it",
      );
    } finally {
      read.mock.restore();
      syncBuiltinESMExports();
    }
  }

  test("rejects a directory in place of SKILL.md before trying to read it", () => {
    const ref = refFor("directory");
    mkdirSync(ref.file);
    const marker = join(ref.file, "keep.txt");
    writeFileSync(marker, "leave this directory alone", "utf8");

    assertRejectedBeforeRead(ref);
    assert.equal(readFileSync(marker, "utf8"), "leave this directory alone");
  });

  test("rejects a regular file one byte over the size limit before reading it", () => {
    const ref = refFor("oversized");
    writeFileSync(ref.file, "");
    truncateSync(ref.file, MAX_SKILL_BYTES + 1);

    assertRejectedBeforeRead(ref);
    assert.equal(statSync(ref.file).size, MAX_SKILL_BYTES + 1);
  });

  test("leaves unparseable Markdown untouched even when its hash matches state", () => {
    const ref = refFor("no-frontmatter");
    const text = "# Release notes\n\nPublish the package when it is ready.\n";
    const hash = skillHash(text);
    const st = state({ hash });
    writeFileSync(ref.file, text, "utf8");

    assert.equal(dropPhrase(ref, st, PUBLISH), false);
    assert.equal(readFileSync(ref.file, "utf8"), text);
    assert.equal(st.hash, hash);
  });

  test("a missing SKILL.md does not change the stored hash or recreate the file", () => {
    const ref = refFor("missing");
    const st = state();
    const hash = st.hash;

    assert.equal(dropPhrase(ref, st, PUBLISH), false);
    assert.equal(st.hash, hash);
    assert.equal(existsSync(ref.file), false);
  });
});
