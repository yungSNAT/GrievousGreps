/**
 * Gap tests for src/telemetry/contract.ts: the event allowlist, the value
 * allowlist, the error taxonomy and every bucket edge. Every number must cross
 * as a label and every string as a member of a closed set, so each boundary is
 * pinned here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EVENTS,
  VALUES,
  INIT_KINDS,
  COMMON_KEYS,
  HOOK_MS_BUCKETS,
  SESSION_SIZE_BUCKETS,
  SESSION_MESSAGES_BUCKETS,
  SHARE_ITEMS_BUCKETS,
  SHARE_SIZE_BUCKETS,
  ERROR_CODES,
  allowedValue,
  isTrackedCommand,
  errorCode,
  filesBucket,
  durationBucket,
  countBucket,
  initKindCounts,
  hookMsBucket,
  sessionSizeBucket,
  sessionMessagesBucket,
  shareItemsBucket,
  shareSizeBucket,
  savedTokensBucket,
  langsValue,
} from "../src/telemetry/contract.js";

const KB = 1024;
const MB = 1024 * 1024;

function table<T>(fn: (n: number) => T, cases: Array<[number, T]>): void {
  for (const [input, expected] of cases) {
    assert.equal(fn(input), expected, `${fn.name}(${input})`);
  }
}

describe("the event allowlist", () => {
  test("repo_seen, learnings_committed and session_summary list exactly their keys", () => {
    assert.deepEqual([...EVENTS.repo_seen!].sort(), ["learnings_bucket", "trail_committed", "workspace"]);
    assert.deepEqual([...EVENTS.learnings_committed!].sort(), ["added_bucket", "first_look", "total_bucket"]);
    assert.deepEqual([...EVENTS.session_summary!].sort(), [
      "graft_reads_bucket", "graft_turns_bucket", "reported_turns_bucket", "saved_tokens_bucket", "source_reads_bucket",
    ]);
    assert.deepEqual([...EVENTS.skill_answer!], ["answer"]);
    assert.deepEqual([...EVENTS.skill_offered!], ["moment"]);
  });

  test("cold_start carries an offered_ and kept_ key per init kind, each fixed to small counts", () => {
    for (const k of INIT_KINDS) {
      for (const p of ["offered", "kept"]) {
        const key = `${p}_${k}`;
        assert.ok(EVENTS.cold_start!.has(key), key);
        assert.deepEqual([...VALUES.cold_start![key]!], ["0", "1", "2", "3", "4", "5", "6+"]);
      }
    }
    assert.ok(EVENTS.cold_start!.has("model"));
    assert.ok(EVENTS.cold_start!.has("filtered_bucket"));
  });

  test("common keys are stamped centrally and never repeated per event", () => {
    for (const [name, keys] of Object.entries(EVENTS)) {
      for (const c of COMMON_KEYS) assert.equal(keys.has(c), false, `${name} repeats ${c}`);
    }
  });
});

describe("allowedValue", () => {
  test("an event with no fixed values allows anything", () => {
    assert.equal(Object.hasOwn(VALUES, "query"), false);
    assert.equal(allowedValue("query", "command", "anything at all"), true);
    assert.equal(allowedValue("no_such_event", "k", "v"), true);
  });

  test("a key the event does not fix is allowed; a fixed key needs a member", () => {
    assert.equal(allowedValue("cold_start", "model", "some-model"), true);
    assert.equal(allowedValue("cold_start", "offered_skills", "6+"), true);
    assert.equal(allowedValue("cold_start", "offered_skills", "7"), false);
    assert.equal(allowedValue("init_completed", "scope", "team"), true);
    assert.equal(allowedValue("init_completed", "scope", "everyone"), false);
    assert.equal(allowedValue("wall_hit", "had_lesson", "true"), true);
    assert.equal(allowedValue("wall_hit", "had_lesson", "yes"), false);
    assert.equal(allowedValue("hook_ms", "bucket", "3s+"), true);
    assert.equal(allowedValue("share_bundle", "size_bucket", "huge"), false);
  });
});

test("isTrackedCommand accepts only the listed commands, case-sensitively", () => {
  assert.equal(isTrackedCommand("grep"), true);
  assert.equal(isTrackedCommand("viz"), true);
  assert.equal(isTrackedCommand("GREP"), false);
  assert.equal(isTrackedCommand("rm"), false);
  assert.equal(isTrackedCommand(""), false);
});

describe("errorCode", () => {
  test("system codes map to their category", () => {
    const byCode = (code: string) => errorCode(Object.assign(new Error("boom"), { code }));
    assert.equal(byCode("ENOSPC"), "E_DISK");
    assert.equal(byCode("EDQUOT"), "E_DISK");
    assert.equal(byCode("EACCES"), "E_PERMISSION");
    assert.equal(byCode("EPERM"), "E_PERMISSION");
    assert.equal(byCode("ENOMEM"), "E_OOM");
    assert.equal(byCode("ETIMEDOUT"), "E_TIMEOUT");
    assert.equal(byCode("ESOCKETTIMEDOUT"), "E_TIMEOUT");
    assert.equal(byCode("ENOTFOUND"), "E_NETWORK");
    assert.equal(byCode("ECONNREFUSED"), "E_NETWORK");
    assert.equal(byCode("ECONNRESET"), "E_NETWORK");
    assert.equal(byCode("EWHATEVER"), "E_UNKNOWN");
  });

  test("the code wins over the message", () => {
    assert.equal(errorCode(Object.assign(new Error("lock timeout"), { code: "EACCES" })), "E_PERMISSION");
  });

  test("a non-string code is ignored", () => {
    assert.equal(errorCode({ code: 28 }), "E_UNKNOWN");
  });

  test("HTTP statuses map to auth, rate limit and provider failures", () => {
    assert.equal(errorCode({ status: 401 }), "E_AUTH");
    assert.equal(errorCode({ status: 403 }), "E_AUTH");
    assert.equal(errorCode({ status: 429 }), "E_RATE_LIMIT");
    assert.equal(errorCode({ status: 500 }), "E_LLM");
    assert.equal(errorCode({ status: 503 }), "E_LLM");
    assert.equal(errorCode({ status: 404 }), "E_UNKNOWN");
    assert.equal(errorCode({ status: "500" }), "E_UNKNOWN");
    assert.equal(errorCode(Object.assign(new Error("request timeout"), { status: 429 })), "E_RATE_LIMIT");
  });

  test("messages are matched only on fixed substrings", () => {
    assert.equal(errorCode(new Error("Request Timeout after 30s")), "E_TIMEOUT");
    assert.equal(errorCode(new Error("the call timed out")), "E_TIMEOUT");
    assert.equal(errorCode(new Error("Failed to PARSE /home/me/x.ts")), "E_PARSE");
    assert.equal(errorCode(new SyntaxError("Unexpected token: syntax")), "E_PARSE");
    assert.equal(errorCode(new Error("map Lock is held")), "E_LOCK");
    assert.equal(errorCode(new Error("something else at /secret/path")), "E_UNKNOWN");
  });

  test("non-errors become E_UNKNOWN even when their text would match", () => {
    assert.equal(errorCode(null), "E_UNKNOWN");
    assert.equal(errorCode(undefined), "E_UNKNOWN");
    assert.equal(errorCode("timeout"), "E_UNKNOWN");
    assert.equal(errorCode({ message: "timeout" }), "E_UNKNOWN");
  });

  test("the result is always a member of ERROR_CODES", () => {
    for (const e of [new Error("x"), { status: 401 }, { code: "ENOMEM" }, 42]) {
      assert.ok((ERROR_CODES as readonly string[]).includes(errorCode(e)));
    }
  });
});

describe("buckets", () => {
  test("filesBucket", () => {
    table(filesBucket, [
      [-1, "0"], [0, "0"], [1, "1-49"], [49, "1-49"], [50, "50-199"], [199, "50-199"],
      [200, "200-999"], [999, "200-999"], [1000, "1000-4999"], [4999, "1000-4999"], [5000, "5000+"],
    ]);
  });

  test("durationBucket", () => {
    table(durationBucket, [
      [0, "<1s"], [999, "<1s"], [1000, "1-5s"], [4999, "1-5s"], [5000, "5-30s"], [29_999, "5-30s"],
      [30_000, "30s-2m"], [119_999, "30s-2m"], [120_000, "2-10m"], [599_999, "2-10m"], [600_000, "10m+"],
    ]);
  });

  test("countBucket", () => {
    table(countBucket, [
      [-3, "0"], [0, "0"], [1, "1-4"], [4, "1-4"], [5, "5-19"], [19, "5-19"],
      [20, "20-49"], [49, "20-49"], [50, "50-199"], [199, "50-199"], [200, "200+"],
    ]);
  });

  test("hookMsBucket splits at the 50 ms and 300 ms budgets", () => {
    table(hookMsBucket, [
      [0, "<50ms"], [49, "<50ms"], [50, "50-100ms"], [99, "50-100ms"], [100, "100-300ms"], [299, "100-300ms"],
      [300, "300ms-1s"], [999, "300ms-1s"], [1000, "1-3s"], [2999, "1-3s"], [3000, "3s+"],
    ]);
    for (const ms of [1, 60, 150, 500, 2000, 9000]) assert.ok((HOOK_MS_BUCKETS as readonly string[]).includes(hookMsBucket(ms)));
  });

  test("sessionSizeBucket", () => {
    table(sessionSizeBucket, [
      [0, "<100KB"], [100 * KB - 1, "<100KB"], [100 * KB, "100KB-1MB"], [MB - 1, "100KB-1MB"],
      [MB, "1-5MB"], [5 * MB - 1, "1-5MB"], [5 * MB, "5-20MB"], [20 * MB - 1, "5-20MB"], [20 * MB, "20MB+"],
    ]);
    assert.ok((SESSION_SIZE_BUCKETS as readonly string[]).includes(sessionSizeBucket(3 * MB)));
  });

  test("sessionMessagesBucket", () => {
    table(sessionMessagesBucket, [
      [0, "<50"], [49, "<50"], [50, "50-199"], [199, "50-199"], [200, "200-499"], [499, "200-499"],
      [500, "500-1999"], [1999, "500-1999"], [2000, "2000+"],
    ]);
    assert.ok((SESSION_MESSAGES_BUCKETS as readonly string[]).includes(sessionMessagesBucket(700)));
  });

  test("shareItemsBucket", () => {
    table(shareItemsBucket, [
      [0, "1"], [1, "1"], [2, "2-9"], [9, "2-9"], [10, "10-49"], [49, "10-49"],
      [50, "50-199"], [199, "50-199"], [200, "200+"],
    ]);
    assert.ok((SHARE_ITEMS_BUCKETS as readonly string[]).includes(shareItemsBucket(30)));
  });

  test("shareSizeBucket", () => {
    table(shareSizeBucket, [
      [0, "<1MB"], [MB - 1, "<1MB"], [MB, "1-10MB"], [10 * MB - 1, "1-10MB"], [10 * MB, "10-50MB"],
      [50 * MB - 1, "10-50MB"], [50 * MB, "50-200MB"], [200 * MB - 1, "50-200MB"], [200 * MB, "200MB+"],
    ]);
    assert.ok((SHARE_SIZE_BUCKETS as readonly string[]).includes(shareSizeBucket(75 * MB)));
  });

  test("savedTokensBucket", () => {
    table(savedTokensBucket, [
      [-1, "0"], [0, "0"], [1, "<1k"], [999, "<1k"], [1000, "1-5k"], [4999, "1-5k"],
      [5000, "5-20k"], [19_999, "5-20k"], [20_000, "20-100k"], [99_999, "20-100k"], [100_000, "100k+"],
    ]);
  });
});

describe("initKindCounts", () => {
  test("counts each kind exactly up to 5, then 6+, ignoring other kinds", () => {
    const items = [
      ...Array.from({ length: 7 }, () => ({ kind: "skill" })),
      { kind: "guardrail" },
      { kind: "something-else" },
    ];
    const offered = initKindCounts("offered", items);
    assert.deepEqual(offered, { offered_skills: "6+", offered_always_follow: "1", offered_learnings: "0" });
    for (const [k, v] of Object.entries(offered)) {
      assert.ok(EVENTS.cold_start!.has(k), k);
      assert.equal(allowedValue("cold_start", k, v), true, `${k}=${v}`);
    }
  });

  test("exactly five stays exact under the kept prefix", () => {
    const items = Array.from({ length: 5 }, () => ({ kind: "preference" }));
    assert.deepEqual(initKindCounts("kept", items), { kept_skills: "0", kept_always_follow: "0", kept_learnings: "5" });
    assert.deepEqual(initKindCounts("kept", []), { kept_skills: "0", kept_always_follow: "0", kept_learnings: "0" });
  });
});

describe("langsValue", () => {
  test("normalises, drops unsafe or long values, dedupes and sorts", () => {
    const value = langsValue([" TS ", "go", "ts", "", "   ", "a".repeat(25), "c++", "c#", "has space", "path/x", "GO", "x.y_z-1"]);
    assert.equal(value, "c#,c++,go,ts,x.y_z-1");
  });

  test("a 24-character name is kept; 25 is dropped", () => {
    assert.equal(langsValue(["b".repeat(24), "c".repeat(25)]), "b".repeat(24));
  });

  test("caps at eight languages after sorting", () => {
    const value = langsValue(["j", "i", "h", "g", "f", "e", "d", "c", "b", "a"]);
    assert.equal(value, "a,b,c,d,e,f,g,h");
  });

  test("an empty or all-unsafe list is the empty string", () => {
    assert.equal(langsValue([]), "");
    assert.equal(langsValue(["src/main.ts", "C:\\x"]), "");
  });
});
