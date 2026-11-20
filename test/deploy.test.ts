/**
 * Dockerfiles, compose files and Kubernetes manifests in the graph (`src/graph/deploy.ts`):
 * the chain from a function to the Ingress in front of it, what a walk at depth 1 and
 * deeper sees, that no Secret or ConfigMap value reaches anything the build writes, and
 * that a malformed file is reported as skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { callersOf, impactOfMany } from "../src/graph/traverse.js";
import { ask } from "../src/ask/ask.js";
import { deployFormatOf, extractDeploy } from "../src/graph/deploy.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { runCallersCommand } from "../src/graph/traverse-cli.js";
import { blastRadius } from "../src/blast/blast.js";
import { fileReader } from "../src/blast/evidence.js";
import { markdownReport } from "../src/blast/render.js";
import { blastVizGraph } from "../src/blast/viz.js";
import { grepGraph } from "../src/search/grep.js";
import { runCli } from "./helpers.js";
import type { GraphV1 } from "../src/graph/types.js";

const SECRET = "hunter2-SECRET-VALUE";
const CONFIG = "PLAIN-CONFIG-VALUE";
const ENV = "ENV-VALUE-IN-COMPOSE";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gg-deploy-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SERVICE = {
  "src/app.py": "def handle(request):\n    return request\n",
  "tools/other.py": "def unused():\n    pass\n",
  Dockerfile: [
    "# syntax=docker/dockerfile:1",
    "FROM python:3.12 AS base",
    "WORKDIR /app",
    "COPY src/ \\",
    "     /app/src/",
    "RUN <<EOF",
    "COPY tools/ /never",
    "EOF",
    "FROM base AS final",
    "COPY --from=base /app /app",
    'CMD ["python", "-m", "src.app"]',
  ].join("\n"),
  "compose.yaml": [
    "services:",
    "  api:",
    "    build: .",
    "    image: acme/api:1.0",
    "    depends_on: [db]",
    "    environment:",
    `      TOKEN: ${ENV}`,
    "    volumes:",
    "      - ./src:/srv/src",
    "      - data:/var/data",
    "    networks: [back]",
    "  db:",
    "    image: postgres:17",
    "volumes:",
    "  data: {}",
    "networks:",
    "  back: {}",
  ].join("\n"),
  "k8s/app.yaml": [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata: { name: api, namespace: shop }",
    "spec:",
    "  template:",
    "    metadata: { labels: { app: api, tier: web } }",
    "    spec:",
    "      containers:",
    "        - name: api",
    "          image: docker.io/acme/api:2.0",
    "          envFrom:",
    "            - configMapRef: { name: app-config }",
    "            - secretRef: { name: app-secret }",
    "---",
    "apiVersion: v1",
    "kind: Service",
    "metadata: { name: api, namespace: shop }",
    "spec: { selector: { app: api } }",
    "---",
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata: { name: web, namespace: shop }",
    "spec:",
    "  rules:",
    "    - host: shop.example",
    "      http:",
    "        paths:",
    "          - path: /api",
    "            backend: { service: { name: api } }",
    "---",
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata: { name: app-config, namespace: shop }",
    `data: { MODE: ${CONFIG} }`,
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata: { name: app-secret, namespace: shop }",
    `stringData: { password: ${SECRET} }`,
  ].join("\n"),
};

async function built(files: Record<string, string>) {
  const root = repo(files);
  const result = await buildGraph(root);
  const graph = readGraph(wiringPath(contextDirFor(root)))!;
  return { root, result, graph };
}

function refs(graph: GraphV1): string[] {
  const deployIds = new Set(graph.nodes.filter((n) => n.kind === "resource").map((n) => n.id));
  return graph.edges
    .filter((e) => e.relation === "references" && deployIds.has(e.source))
    .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
    .sort();
}

test("compose merge keys, Docker target names and context-relative COPY resolve together", async () => {
  const { root, graph } = await built({
    "src/app.py": "def handle():\n    return 42\n",
    "Dockerfile-dev": 'FROM python:3.12 AS dev\nCOPY --chown=1000 ["/src", "/app"]\n',
    "Dockerfile-dev.dockerignore": "docs/\n",
    "compose.yaml": "x-build: &build { context: ., dockerfile: Dockerfile-dev, target: Dev }\nservices:\n  api:\n    build: { <<: *build }\n",
  });
  try {
    assert.deepEqual(refs(graph), [
      "Dockerfile-dev#stage:dev -> src/app.py (inferred)",
      "compose.yaml#service:api -> Dockerfile-dev#stage:dev",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep skips deployment text while searching indexed source", async () => {
  const { root, graph } = await built(SERVICE);
  try {
    assert.equal(grepGraph(graph, root, ENV).groups.length, 0);
    assert.ok(grepGraph(graph, root, "def handle").groups.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the graph reports omitted file links when one deployment exceeds its expansion limit", async () => {
  const sourceFiles = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`src/part${i}.py`, "size = 1\n"]));
  const dockerfile = Array.from({ length: 201 }, (_, i) => `FROM python:3.12 AS part${i}\nCOPY src/ /app\n`).join("");
  const { root, graph, result } = await built({ ...sourceFiles, Dockerfile: dockerfile });
  try {
    assert.deepEqual(result.skipped, [{ path: "Dockerfile", reason: "COPY and bind-mount links omitted after 50000 file candidates" }]);
    assert.deepEqual(refs(graph), []);
    assert.ok(graph.nodes.some((node) => node.id === "Dockerfile#stage:part0"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment files are named by their file names", () => {
  assert.deepEqual(
    ["Dockerfile", "api/Dockerfile.prod", "web.dockerfile", "Containerfile", "compose.yaml", "docker-compose.override.yml", "k8s/app.yml", "src/app.py"].map(deployFormatOf),
    ["dockerfile", "dockerfile", "dockerfile", "dockerfile", "compose", "compose", "kubernetes", null],
  );
});

test("a function reaches the Ingress in front of it, through the image, compose and the Deployment", async () => {
  const { root, result, graph } = await built(SERVICE);
  try {
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(refs(graph), [
      "Dockerfile#stage:final -> Dockerfile#stage:base",
      "Dockerfile#stage:base -> src/app.py",
      "compose.yaml#service:api -> Dockerfile#stage:final",
      "compose.yaml#service:api -> compose.yaml#network:back",
      "compose.yaml#service:api -> compose.yaml#service:db",
      "compose.yaml#service:api -> compose.yaml#volume:data",
      "compose.yaml#service:api -> src/app.py",
      "k8s/app.yaml#Deployment/shop/api -> compose.yaml#service:api (inferred)",
      "k8s/app.yaml#Deployment/shop/api -> k8s/app.yaml#ConfigMap/shop/app-config",
      "k8s/app.yaml#Deployment/shop/api -> k8s/app.yaml#Secret/shop/app-secret",
      "k8s/app.yaml#Ingress/shop/web -> k8s/app.yaml#Service/shop/api",
      "k8s/app.yaml#Service/shop/api -> k8s/app.yaml#Deployment/shop/api",
    ].sort());
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
    const handle = graph.nodes.find((n) => n.name === "handle")!;
    assert.deepEqual(callersOf(graph, handle), [], "depth 1 is exact edges only");
    const reached = impactOfMany(graph, [handle], 6, "in");
    const at = (id: string) => reached.find((h) => h.id === id);
    assert.equal(at("Dockerfile#stage:base")?.depth, 1);
    assert.equal(at("compose.yaml#service:api")?.depth, 1, "the bind mount reaches it directly");
    assert.equal(at("k8s/app.yaml#Deployment/shop/api")?.depth, 2);
    assert.equal(at("k8s/app.yaml#Deployment/shop/api")?.inferred, true, "through the image name match");
    assert.equal(at("k8s/app.yaml#Ingress/shop/web")?.depth, 4);
    assert.equal(at("tools/other.py#unused"), undefined);
    const stage = graph.nodes.find((n) => n.id === "Dockerfile#stage:base")!;
    assert.equal(stage.kind, "resource");
    assert.equal(stage.signature, "FROM python:3.12 AS base");
    assert.equal(stage.span, "L2-L8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? everyFile(join(dir, f)) : [join(dir, f)]));
}

test("no Secret, ConfigMap or environment value reaches the graph, its caches or ask", async () => {
  const { root } = await built(SERVICE);
  try {
    for (const file of everyFile(contextDirFor(root))) {
      const text = readFileSync(file).toString("latin1");
      for (const value of [SECRET, CONFIG, ENV]) assert.ok(!text.includes(value), `${value} in ${file}`);
    }
    const r = ask(root, "app-secret password", { source: true });
    assert.ok(r.hits.some((h) => h.pointer.startsWith("k8s/app.yaml")), "the Secret is found by name");
    assert.ok(r.hits.every((h) => !h.code?.includes(SECRET)), "and its file's text is never inlined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and template files are skipped with a reason; other YAML is ignored", async () => {
  const { root, result, graph } = await built({
    "src/app.py": "def handle():\n    pass\n",
    "Dockerfile.bad": "RUN echo no base\n",
    "k8s/broken.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: x\n",
    "chart/templates/dep.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Values.name }}\n",
    "k8s/wrong.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: bad }\nspec:\n  template:\n    spec: { containers: x }\n",
    "workflows/ci.yml": "on: push\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
  });
  try {
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
    assert.deepEqual(Object.keys(reasons).sort(), ["Dockerfile.bad", "chart/templates/dep.yaml", "k8s/broken.yaml", "k8s/wrong.yaml"]);
    assert.equal(reasons["Dockerfile.bad"], "no FROM instruction");
    // `{{ .Values.name }}` parses as a mapping, so the field that fails is named, with the template beside it.
    assert.equal(reasons["chart/templates/dep.yaml"], "Deployment: metadata.name is not a string in a file holding {{ }} templates");
    assert.match(reasons["k8s/broken.yaml"], /^not valid YAML: /);
    assert.equal(reasons["k8s/wrong.yaml"], "Deployment bad: containers is not a list");
    assert.equal(result.structuralErrors, 0, "a skip is not a build error");
    assert.deepEqual(graph.nodes.filter((n) => n.kind === "resource"), []);
    assert.ok(!graph.nodes.some((n) => n.path === "workflows/ci.yml"), "a YAML file with no manifest makes no node");
    const again = await buildGraph(root);
    assert.equal(again.reused, again.files, "replayed from the cache");
    assert.deepEqual(again.skipped, result.skipped, "and still reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild from the cache gives the same edges, and check sees no drift", async () => {
  const { root, graph } = await built(SERVICE);
  try {
    await buildGraph(root);
    assert.deepEqual(refs(readGraph(wiringPath(contextDirFor(root)))!), refs(graph));
    const check = await checkGraph(root);
    assert.deepEqual([check.added, check.removed, check.changed], [[], [], []]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compose build context and target pick the Dockerfile's folder and stage", () => {
  const c = extractDeploy("deploy/compose.yml", "services:\n  web:\n    build: { context: .., dockerfile: docker/web.Dockerfile, target: dev }\n", "compose");
  assert.deepEqual(c.refs, [{ from: "deploy/compose.yml#service:web", to: "build", context: ".", dockerfile: "docker/web.Dockerfile", target: "dev" }]);
  const outside = extractDeploy("compose.yml", "services:\n  web:\n    build: ../elsewhere\n    volumes: ['/etc/hosts:/etc/hosts', '../up:/x']\n", "compose");
  assert.deepEqual(outside.refs, [], "a context or mount outside the repository names nothing");
});

// ── Review findings (R3981 to R3985 and the shoulds): each test fails on 4d1cbd9 ──

/** Linear-time limit: the quadratic and exponential code these replace took 10 s to minutes here. */
test("COPY globs match by Docker's rules; a bad pattern skips its Dockerfile with a reason, not the build", async () => {
  const { root, result, graph } = await built({
    "src/a1.py": "def a():\n    pass\n",
    "src/b2.py": "def b():\n    pass\n",
    "src/c3.py": "def c():\n    pass\n",
    "src/deep/d4.py": "def d():\n    pass\n",
    "src/d0.py": "def shallow():\n    pass\n",
    "src/deep/extra/d9.py": "def deeper():\n    pass\n",
    Dockerfile: "FROM python:3.12\nCOPY src/[ab]* /app/\nCOPY src/**/d?.py /deep/\n",
    "bad/Dockerfile": "FROM python:3.12\nCOPY src/[ /x\n",
  });
  try {
    assert.deepEqual(refs(graph), ["Dockerfile#stage:0 -> src/a1.py (inferred)", "Dockerfile#stage:0 -> src/b2.py (inferred)", "Dockerfile#stage:0 -> src/deep/d4.py (inferred)"]);
    assert.deepEqual(result.skipped, [{ path: "bad/Dockerfile", reason: "line 2: COPY source src/[ is not a valid pattern" }]);
    assert.equal(result.structuralErrors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COPY distinguishes shared contexts and normalises parents inside the context", async () => {
  const { root, graph } = await built({
    Dockerfile: "FROM scratch\nCOPY ../main.py /data/\n",
    "compose.yaml": "services:\n  first:\n    build: {context: a, dockerfile: ../Dockerfile}\n  second:\n    build: {context: b, dockerfile: ../Dockerfile}\n",
    "a/main.py": "def first(): pass\n",
    "b/main.py": "def second(): pass\n",
    "main.py": "def outside(): pass\n",
    "filtered/Dockerfile": [
      "FROM scratch AS forward", "COPY --exclude=other.py . /data/", "COPY main.py /data/",
      "FROM scratch AS reverse", "COPY main.py /data/", "COPY --exclude=other.py . /data/",
      "FROM scratch AS repeated", "COPY --exclude=other.py main.py /data/", "COPY main.py /data/",
    ].join("\n"),
    "filtered/compose.yaml": "services:\n  one:\n    build: .\n",
    "filtered/main.py": "def inside(): pass\n",
    "filtered/other.py": "def other(): pass\n",
  });
  try {
    assert.deepEqual(refs(graph).filter((edge) => edge.startsWith("Dockerfile#stage:")), [
      "Dockerfile#stage:0 -> a/main.py (inferred)",
      "Dockerfile#stage:0 -> b/main.py (inferred)",
    ]);
    assert.deepEqual(refs(graph).filter((edge) => edge.startsWith("filtered/Dockerfile#stage:")), [
      "filtered/Dockerfile#stage:forward -> filtered/main.py",
      "filtered/Dockerfile#stage:forward -> filtered/other.py (inferred)",
      "filtered/Dockerfile#stage:repeated -> filtered/main.py",
      "filtered/Dockerfile#stage:reverse -> filtered/main.py",
      "filtered/Dockerfile#stage:reverse -> filtered/other.py (inferred)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a null Compose volume yields a bounded skip", () => {
  const result = extractDeploy("compose.yaml", "services:\n  api:\n    volumes: [null]\n", "compose");
  assert.deepEqual(result, { nodes: [], refs: [], skipped: "service api: volume is not a string or mapping" });
});

test("a COPY glob with many wildcards resolves in linear time", { timeout: 60_000 }, async () => {
  const files = { [`${"a".repeat(60)}.py`]: "def f():\n    pass\n", Dockerfile: `FROM python:3.12\nCOPY ${"*a".repeat(12)}b /x/\n` };
  const root = repo(files);
  try {
    const start = performance.now();
    await buildGraph(root);
    assert.ok(performance.now() - start < 3_000 * 3, `build took ${(performance.now() - start).toFixed(0)} ms`);
    assert.deepEqual(refs(readGraph(wiringPath(contextDirFor(root)))!), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build with 200,000 deployment edges does not overflow the stack", { timeout: 300_000 }, async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 400; i++) files[`src/m${i}.py`] = `def f${i}():\n    pass\n`;
  const stages = Array.from({ length: 125 }, (_, i) => `FROM python:3.12 AS s${i}\nCOPY . /app/`).join("\n");
  for (let i = 0; i < 4; i++) files[`Dockerfile.part${i}`] = stages;
  const { root, result, graph } = await built(files);
  try {
    assert.equal(result.structuralErrors, 0);
    assert.deepEqual(result.skipped, []);
    assert.equal(refs(graph).length, 200_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callers and blast never quote a deployment file's text", async () => {
  const { root, graph } = await built({
    "src/db.py": "def connect():\n    pass\n",
    "compose.yaml": [
      "services:",
      "  api:",
      "    image: acme/api",
      "    environment:",
      `      DATABASE_URL: postgres://app:${SECRET}@db:5432/app`,
      `      HOOK: connect-${SECRET}`,
      "    depends_on: [db]",
      "    volumes: ['./src:/srv/src']",
      "  db:",
      "    image: postgres:17",
    ].join("\n"),
  });
  try {
    const [log, write] = [console.log, process.stdout.write];
    let text = "";
    console.log = (x: string) => { text += x; };
    process.stdout.write = ((x: string) => { text += x; return true; }) as typeof process.stdout.write;
    try {
      runCallersCommand("db", root, {});
      runCallersCommand("connect", root, { depth: "2" });
    } finally {
      console.log = log;
      process.stdout.write = write;
    }
    assert.match(text, /api/, "the service is listed");
    assert.ok(!text.includes(SECRET), text);
    const report = blastRadius(graph, [{ path: "src/db.py", status: "modified", ranges: [{ start: 1, end: 1 }], hunks: [] }], "test", { depth: 2, read: fileReader(root) });
    const md = markdownReport(report, { root });
    assert.match(md, /compose\.yaml/, "blast reaches the service");
    assert.ok(!md.includes(SECRET), md);
    const deploymentDiff = blastRadius(graph, [{
      path: "compose.yaml", status: "modified", ranges: [{ start: 2, end: 3 }],
      hunks: [{ start: 2, end: 3, dropped: 0, lines: [{ n: 2, sign: "+", text: "DEPLOYMENT-DIFF-FIXTURE" }] }],
    }], "test", { depth: 2, read: fileReader(root) });
    assert.ok(deploymentDiff.seeds.length);
    assert.doesNotMatch(JSON.stringify(blastVizGraph(deploymentDiff, { root })), /DEPLOYMENT-DIFF-FIXTURE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only YAML that looks like a manifest is parsed: a broken settings file is not reported", async () => {
  const { root, result } = await built({
    "src/app.py": "def handle():\n    pass\n",
    "config/broken.yml": "settings: [1, 2\n",
    "k8s/broken.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: x\n",
  });
  try {
    assert.deepEqual(result.skipped.map((s) => s.path), ["k8s/broken.yaml"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest is skipped for {{ }} only where a field the graph reads holds one", () => {
  const rule = extractDeploy("k8s/rules.yaml", [
    "apiVersion: monitoring.coreos.com/v1",
    "kind: PrometheusRule",
    "metadata: { name: alerts }",
    "spec:",
    "  groups:",
    "    - rules:",
    '        - annotations: { summary: "{{ $labels.instance }} down" }',
  ].join("\n"), "kubernetes");
  assert.equal(rule.skipped, undefined);
  assert.deepEqual(rule.nodes.map((n) => n.id), ["k8s/rules.yaml", "k8s/rules.yaml#PrometheusRule/default/alerts"]);
  const image = extractDeploy("chart/templates/dep.yaml", 'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec:\n  template:\n    spec:\n      containers:\n        - image: "{{ .Values.image }}"\n', "kubernetes");
  assert.equal(image.skipped, "Deployment api: container image is a template, not rendered");
});

test("duplicate or invalid stage names and duplicate objects skip the file with a reason", () => {
  assert.equal(extractDeploy("Dockerfile", "FROM a AS x\nFROM b AS x\n", "dockerfile").skipped, "line 2: duplicate stage x");
  assert.equal(extractDeploy("Dockerfile", "FROM a AS 1\nFROM b\n", "dockerfile").skipped, "line 1: stage name 1 is not valid");
  const twice = "apiVersion: v1\nkind: Service\nmetadata: { name: api }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: api }\n";
  assert.equal(extractDeploy("k8s/svc.yaml", twice, "kubernetes").skipped, "duplicate Service default/api");
});

test("heredocs are read only on RUN, COPY and ADD; an unterminated one skips the file", () => {
  const shift = extractDeploy("Dockerfile", "FROM a AS one\nRUN echo $((x<<SHIFT))\nFROM b AS two\nCOPY src /app\n", "dockerfile");
  assert.equal(shift.nodes.filter((n) => n.kind === "resource").length, 2);
  assert.deepEqual(shift.refs, [{ from: "Dockerfile#stage:two", to: "copy", dockerfile: "Dockerfile", src: "src" }]);
  assert.equal(extractDeploy("Dockerfile", "FROM a\nRUN <<EOF\necho hi\n", "dockerfile").skipped, "unterminated heredoc EOF");
  const multiline = "FROM a AS one\nCOPY <<EOT /greeting.txt\n  EOT\nhello\nEOT\nRUN <<-TABS\necho hi\n\tTABS\nFROM b AS two\n";
  const result = extractDeploy("Dockerfile", multiline, "dockerfile");
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.nodes.filter((node) => node.kind === "resource").map((node) => node.name), ["one", "two"]);
});

test("a label, selector, depends_on, link or network that is not a string skips the file", () => {
  const svc = "apiVersion: v1\nkind: Service\nmetadata: { name: api }\nspec: { selector: { app: 1 } }\n";
  assert.equal(extractDeploy("k8s/svc.yaml", svc, "kubernetes").skipped, "Service api: selector app is not a string");
  for (const field of ["depends_on: [{ a: 1 }]", "links: [7]", "networks: [true]"]) {
    const x = extractDeploy("compose.yaml", `services:\n  api:\n    image: x\n    ${field}\n`, "compose");
    assert.match(x.skipped ?? "", /^service api: (depends_on|links|networks) entry is not a string$/, field);
  }
});

test("a path holding #Kind/ns/ cannot forge a Kubernetes object", async () => {
  const { root, graph } = await built({
    "src/app.py": "def handle():\n    pass\n",
    "k8s/evil#Secret/default/db.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: cm }\n",
    "k8s/app.yaml": 'apiVersion: v1\nkind: Pod\nmetadata: { name: p }\nspec:\n  containers:\n    - image: x\n      envFrom: [{ secretRef: { name: "db.yaml#ConfigMap/default/cm" } }]\n',
  });
  try {
    assert.ok(graph.nodes.some((n) => n.id === "k8s/evil#Secret/default/db.yaml#ConfigMap/default/cm"), "the ConfigMap is read");
    assert.deepEqual(refs(graph), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`callers app-config` lists the workloads that read that ConfigMap (README)", async () => {
  const { root, graph } = await built(SERVICE);
  try {
    const cm = graph.nodes.find((n) => n.id === "k8s/app.yaml#ConfigMap/shop/app-config")!;
    assert.deepEqual(callersOf(graph, cm).map((h) => h.id), ["k8s/app.yaml#Deployment/shop/api"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hostile inputs: an alias bomb, a __proto__ service and a COPY outside the context", async () => {
  const letters = "abcdefghij";
  const bomb = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata: { name: x }",
    "data:",
    `  a: &a [${Array(9).fill("x").join(", ")}]`,
    ...[...letters.slice(1)].map((c, i) => `  ${c}: &${c} [${Array(9).fill(`*${letters[i]}`).join(", ")}]`),
  ].join("\n");
  assert.match(extractDeploy("k8s/bomb.yaml", bomb, "kubernetes").skipped ?? "", /^not valid YAML: /);
  const proto = extractDeploy("compose.yaml", "services:\n  __proto__:\n    image: evil\n", "compose");
  assert.deepEqual(proto.nodes.map((n) => n.id), ["compose.yaml", "compose.yaml#service:__proto__"]);
  assert.equal(({} as Record<string, unknown>).image, undefined);
  const { root, graph } = await built({ "secrets/key.py": "KEY = 1\n", "app/main.py": "def main():\n    pass\n", "app/Dockerfile": "FROM a\nCOPY ../secrets /x\nCOPY . /app\n" });
  try {
    assert.deepEqual(refs(graph), ["app/Dockerfile#stage:0 -> app/main.py (inferred)"], "a source outside the build context names nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a skip reason is cut to 120 characters with control characters removed; build prints 10 and a count", () => {
  const x = extractDeploy("Dockerfile", `FROM a b c \u001b[31m${"y".repeat(300)}\n`, "dockerfile");
  assert.ok(x.skipped && x.skipped.length <= 120 && !/\p{Cc}/u.test(x.skipped), x.skipped);
  const files: Record<string, string> = { "src/app.py": "def handle():\n    pass\n" };
  for (let i = 0; i < 12; i++) files[`d${i}/Dockerfile`] = "RUN echo no base\n";
  const root = repo(files);
  try {
    const run = runCli(["build", root]);
    assert.equal(run.status, 0, run.describe());
    assert.equal(run.stdout.split("\n").filter((l) => l.startsWith("  skipped ")).length, 10, run.stdout);
    assert.match(run.stdout, /and 2 more deployment files skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
