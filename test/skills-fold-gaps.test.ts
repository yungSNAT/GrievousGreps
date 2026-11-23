import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyFold, foldDiff, planFold, type FoldInput } from "../src/skills/fold.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import type { CompiledSkill, SkillStep } from "../src/skills/types.js";
import type { Lesson } from "../src/skills/lessons.js";

const CHECK = "node scripts/verify-package.mjs";
const COMMANDS = [
  "git status --short",
  "git fetch origin main",
  "npm ci",
  "npm run lint",
  "npm run build",
  "npm test",
  "npm pack --dry-run",
];

// These fixtures describe completed calls. The commands themselves are never run.
function compiled(commands = COMMANDS): CompiledSkill {
  return {
    name: "build-package",
    meta: {
      trail: "s-7d39a1",
      version: "1",
      description: "Build and verify the package before handing it off.",
      scope: "repo",
      applies: "github.com/acme/widgets",
      asks: "build and verify the package",
      needs: "git, npm, node",
      check: CHECK,
    },
    params: [],
    steps: commands.map((cmd, k) => ({
      n: k + 1, cmd, gated: null, bg: false, wait: false, from: [`toolu_build_${k + 1}`],
    })),
    check: CHECK,
    checkIsStep: false,
    ifFails: [],
    source: null,
    helpers: [],
  } as CompiledSkill;
}

function use(fresh: CompiledSkill, facts: Partial<FoldInput["fid"]> = {}, base = compiled()): FoldInput {
  const text = renderSkillMd(base);
  const skill = parseSkillMd(text, base.name);
  assert.ok(skill, "the fixture must render as a readable skill");
  return {
    base, skill, text, fresh, inj: { params: {} },
    fid: { ran: base.steps.map((s) => s.n), changed: [], extra: [], check: "passed", ...facts } as FoldInput["fid"],
    earlierRan: [], earlierExtraShas: [], lessons: [],
  };
}

function extra(step: SkillStep, after: number): FoldInput["fid"]["extra"][number] {
  return {
    id: step.from![0]!, callIx: step.n - 1, after, sha: `extra-${step.n}`,
  } as FoldInput["fid"]["extra"][number];
}

function lesson(id: string, text: string, kind: Lesson["kind"] = "lesson"): Lesson {
  return { id, text, kind, skill: "s-7d39a1", at: "2026-10-20", src: "correction", wall: null };
}

const REPORT = "node scripts/report-size.mjs";

describe("folding lessons and repeated extras", () => {
  test("prose and unrelated commands do not count as evidence for a new step", () => {
    const fresh = compiled([...COMMANDS, REPORT]);
    const i = use(fresh, { extra: [extra(fresh.steps.at(-1)!, COMMANDS.length)] });
    i.lessons = [
      lesson("ls-100001", "Record the bundle size in the handoff"),
      lesson("ls-100002", "Check formatting: npm run format:check"),
    ];
    assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
  });

  test("matching lessons keep their distinct IDs, and a matching guardrail vetoes the extension", () => {
    const fresh = compiled([...COMMANDS, REPORT]);
    const report = fresh.steps.at(-1)!;
    const i = use(fresh, { extra: [extra(report, COMMANDS.length)] });
    const first = lesson("ls-100003", `Measure the package:  ${REPORT}  `);
    const second = lesson("ls-100004", `Include the size in the handoff: ${REPORT}`);
    i.lessons = [first, second, first];

    assert.deepEqual(planFold(i), {
      op: "extend", at: COMMANDS.length, cmds: [report], why: "lesson",
      lessonIds: [first.id, second.id],
    });

    i.lessons.push(lesson("ls-100005", `Do not make this a routine step: ${REPORT}`, "guardrail"));
    assert.deepEqual(planFold(i), { op: "none", why: "guardrail-lesson" });
  });

  test("a repeated extra cannot introduce a parameter that only the fresh compile knows", () => {
    const fresh = compiled([...COMMANDS, `${REPORT} {channel}`]);
    fresh.params = [{ name: "channel", seen: ["preview"] }] as CompiledSkill["params"];
    const e = extra(fresh.steps.at(-1)!, COMMANDS.length);
    const i = use(fresh, { extra: [e] });

    assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
    assert.deepEqual(planFold({ ...i, earlierExtraShas: [[e.sha]] }), { op: "none", why: "new-param" });
  });

  test("an extra that repeats the existing checkout does not become a step", () => {
    const fresh = compiled([...COMMANDS, CHECK]);
    const e = extra(fresh.steps.at(-1)!, COMMANDS.length);
    const i = use(fresh, { extra: [e] });
    assert.deepEqual(planFold({
      ...i,
      earlierExtraShas: [[e.sha]],
      lessons: [lesson("ls-100006", `Verify again before handoff: ${CHECK}`)],
    }), { op: "none", why: "no-change" });
  });
});

describe("folding a replacement", () => {
  function fetchReplacements() {
    const commands = [...COMMANDS];
    commands.splice(1, 1, "git fetch mirror main", "git fetch upstream main");
    return compiled(commands);
  }

  test("the source call named by fidelity wins over an earlier candidate with the same verb", () => {
    const fresh = fetchReplacements();
    const [mirror, upstream] = fresh.steps.slice(1, 3) as [SkillStep, SkillStep];
    const i = use(fresh, {
      ran: [1, 3, 4, 5, 6, 7],
      changed: [{ step: 2, id: upstream.from![0]!, callIx: 2 }],
      extra: [extra(mirror, 1)],
    });
    assert.deepEqual(planFold(i), {
      op: "update", step: 2, cmd: { ...upstream, n: 2 }, why: "failed-then-worked",
    });
  });

  test("if compile omitted the named retry, the same-verb fallback still needs evidence from this use", () => {
    const fresh = fetchReplacements();
    const upstream = fresh.steps[2]!;
    const i = use(fresh, {
      ran: [1, 3, 4, 5, 6, 7],
      changed: [{ step: 2, id: "toolu_earlier_retry", callIx: 1 }],
    });

    assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
    assert.deepEqual(planFold({ ...i, fid: { ...i.fid, extra: [extra(upstream, 1)] } }), {
      op: "update", step: 2, cmd: { ...upstream, n: 2 }, why: "failed-then-worked",
    });
  });

  test("an unchanged gate label does not authorize a push to a different shared branch", () => {
    const oldPush = "git push origin HEAD:main";
    const newPush = "git push origin HEAD:master";
    const base = compiled([...COMMANDS.slice(0, -1), oldPush]);
    const fresh = compiled([...COMMANDS.slice(0, -1), newPush]);
    for (const skill of [base, fresh]) {
      const push = skill.steps.at(-1)!;
      push.gated = "push-prod";
      skill.meta["confirm-before"] = push.cmd;
    }
    const replacement = fresh.steps.at(-1)!;
    const i = use(fresh, {
      ran: [1, 2, 3, 4, 5, 6],
      changed: [{ step: replacement.n, id: replacement.from![0]!, callIx: replacement.n - 1 }],
    }, base);

    assert.deepEqual(foldDiff(i, base), {
      op: "none", why: "gated-new", text: i.text, diff: "",
    });
  });

  test("a preference updates the steps backed by one learning, in step order", () => {
    const commands = [...COMMANDS];
    commands[3] = "pnpm run lint";
    commands[4] = "pnpm run build";
    commands[5] = "pnpm test";
    const i = use(compiled(commands));
    i.preferred = [
      { step: 5, cmd: commands[4]!, follows: "your preference" },
      { step: 6, cmd: commands[5]!, follows: "team preference" },
      { step: 4, cmd: commands[3]!, follows: "your preference" },
      { step: 7, cmd: "pnpm pack --dry-run", follows: "your preference" },
    ];

    const plan = planFold(i);
    if (plan.op !== "update" || plan.why !== "preference") assert.fail(JSON.stringify(plan));
    assert.equal(plan.step, 4);
    assert.equal(plan.follows, "your preference");
    assert.equal(plan.cmd.cmd, "pnpm run lint");
    assert.deepEqual(plan.more?.map(({ n, cmd }) => [n, cmd]), [[5, "pnpm run build"]]);

    const next = applyFold(i.base!, plan);
    assert.ok(next);
    assert.equal(next.meta.version, "2");
    assert.equal(next.meta.needs, "git, npm, node, pnpm");
    assert.deepEqual(next.steps.slice(3).map((s) => s.cmd), [
      "pnpm run lint", "pnpm run build", "npm test", "npm pack --dry-run",
    ]);
    assert.equal(i.base!.steps[3]!.cmd, "npm run lint");
  });

  test("a displayed preference is not folded if its step was not run", () => {
    const commands = [...COMMANDS];
    commands[3] = "pnpm run lint";
    const i = use(compiled(commands), { ran: [1, 2, 3, 5, 6, 7] });
    i.preferred = [{ step: 4, cmd: commands[3]!, follows: "your preference" }];
    assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
  });
});

describe("naming a split", () => {
  test("a split needs a previous checkout and skips a taken name and the fresh compile's own name", () => {
    const fresh = compiled(COMMANDS.slice(3, 6));
    fresh.name = "build-package-3";
    const i = use(fresh, { ran: [4, 5, 6] });
    i.earlierRan = [[6, 5, 4, 4]];
    i.earlierExtraShas = [[]];
    i.splitName = "Build Checks";
    i.taken = (name) => name === "build-package-2";

    assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
    i.earlierChecks = ["passed"];
    assert.deepEqual(planFold(i), { op: "split", from: 4, to: 6, name: "build-package-4" });

    const result = foldDiff(i, i.base!);
    assert.equal(result.op, "split");
    assert.ok(result.diff.includes("build-package-4/SKILL.md v1"));
    const parsed = parseSkillMd(result.text, "build-package-4");
    assert.ok(parsed);
    assert.deepEqual(parsed.steps.map((s) => s.cmd), COMMANDS.slice(3, 6));
  });

  test("no split is offered when every candidate name is taken", () => {
    const i = use(compiled(COMMANDS.slice(3, 6)), { ran: [4, 5, 6] });
    assert.deepEqual(planFold({
      ...i, earlierRan: [[4, 5, 6]], earlierChecks: ["passed"], taken: () => true,
    }), { op: "none", why: "no-change" });
  });
});
