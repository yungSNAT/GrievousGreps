/**
 * Terraform files in the deploy graph (`src/graph/terraform.ts`, `deploy.ts`): each `resource`, `data` and `module`
 * block is a node named by its address, linked to the blocks it names in its module (every `.tf` file in its folder),
 * to a local module's files, to the source files a `${path.module}` path reads, and, inferred, to the compose service
 * that builds an image it names. Anything else gives no link and a report line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { built } from "./deploy-routes-fixtures.js";
import { FIXTURE } from "./deploy-terraform-fixtures.js";

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isTerraform = (id: string) => /\.tf(#|$)/.test(id);

async function withBuild(files: Record<string, string>, check: (b: Awaited<ReturnType<typeof built>>) => void) {
  const b = await built(files);
  try {
    check(b);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
}

const tfLinks = (graph: Awaited<ReturnType<typeof built>>["graph"]) => graph.edges
  .filter((e) => e.relation === "references" && isTerraform(e.source))
  .map((e) => `${e.source} -> ${e.target}${e.confidence === "inferred" ? " (inferred)" : ""}`)
  .sort(byCodeUnit);

const reportsFor = (result: Awaited<ReturnType<typeof built>>["result"], path: string) =>
  result.skipped.filter((s) => s.path === path).map((s) => s.reason).sort(byCodeUnit);

test("Terraform blocks are nodes linked to the blocks, modules, source files and built images they name", async () => {
  await withBuild(FIXTURE, ({ result, graph }) => {
    const tf = graph.nodes.filter((n) => isTerraform(n.id) && n.kind === "resource").map((n) => n.id).sort(byCodeUnit);
    assert.deepEqual(tf, [
      "infra/iam.tf#aws_dynamodb_table.orders",
      "infra/iam.tf#aws_iam_role.lambda",
      "infra/main.tf#aws_ecs_task_definition.web",
      "infra/main.tf#aws_iam_role_policy.p",
      "infra/main.tf#aws_lambda_function.api",
      "infra/main.tf#aws_s3_object.boot",
      "infra/main.tf#data.archive_file.api",
      "infra/main.tf#module.net",
      "infra/main.tf#module.vpc",
      "infra/modules/net/main.tf#aws_s3_bucket.b",
    ]);
    assert.deepEqual(tfLinks(graph), [
      "infra/main.tf#aws_ecs_task_definition.web -> compose.yaml#service:web (inferred)",
      "infra/main.tf#aws_iam_role_policy.p -> infra/iam.tf#aws_iam_role.lambda",
      "infra/main.tf#aws_lambda_function.api -> infra/iam.tf#aws_dynamodb_table.orders",
      "infra/main.tf#aws_lambda_function.api -> infra/iam.tf#aws_iam_role.lambda",
      "infra/main.tf#aws_lambda_function.api -> infra/main.tf#data.archive_file.api",
      "infra/main.tf#aws_s3_object.boot -> infra/main.tf#module.net",
      "infra/main.tf#aws_s3_object.boot -> scripts/boot.sh",
      "infra/main.tf#data.archive_file.api -> src/api/handler.py",
      "infra/main.tf#data.archive_file.api -> src/api/util.py",
      "infra/main.tf#module.net -> infra/modules/net/main.tf",
      "infra/main.tf#module.net -> infra/modules/net/outputs.tf",
    ]);
    assert.deepEqual(reportsFor(result, "infra/main.tf"), [
      "aws_iam_role_policy.p: a path not written from ${path.module} is not followed",
      "module.vpc: a module source that is not a local folder is not read",
    ]);
    const lambda = graph.nodes.find((n) => n.id === "infra/main.tf#aws_lambda_function.api")!;
    assert.equal(lambda.name, "aws_lambda_function.api");
    assert.equal(lambda.signature, "terraform resource aws_lambda_function");
    assert.equal(lambda.span, "L1-L8");
    // Only names: no attribute value reaches a node or a report.
    for (const n of graph.nodes.filter((x) => isTerraform(x.id))) {
      assert.doesNotMatch(`${n.signature} ${n.body_text ?? ""}`, /orders"|lambda"|acme|zip|boot\.sh|policy_path/, n.id);
    }
    for (const s of result.skipped) assert.doesNotMatch(s.reason, /acme|zip|policy_path|x\.sh|terraform-aws-modules/, s.reason);
    assert.ok(graph.edges.some((e) => e.relation === "contains" && e.source === "infra/main.tf" && e.target === lambda.id));
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  });
});

/** Every edge main gives for FIXTURE, recorded at 1b76d4b (before Terraform), where `.tf` files are not read. */
const MAIN_EDGES = [
  "compose.yaml -contains-> compose.yaml#service:web extracted",
  "compose.yaml#service:web -references-> src/web/Dockerfile#stage:0 extracted",
  "k8s/deploy.yaml -contains-> k8s/deploy.yaml#Deployment/default/web extracted",
  "k8s/deploy.yaml#Deployment/default/web -references-> compose.yaml#service:web inferred",
  "k8s/service.yaml -contains-> k8s/service.yaml#Service/default/web extracted",
  "k8s/service.yaml#Service/default/web -references-> k8s/deploy.yaml#Deployment/default/web extracted",
  "src/api/handler.py -contains-> src/api/handler.py#handler extracted",
  "src/api/util.py -contains-> src/api/util.py#helper extracted",
  "src/web/Dockerfile -contains-> src/web/Dockerfile#stage:0 extracted",
  "src/web/Dockerfile#stage:0 -references-> src/web/app.py extracted",
  "src/web/app.py -contains-> src/web/app.py#main extracted",
];

test("every edge but a Terraform file's own is the one main gives for the same files", async () => {
  await withBuild(FIXTURE, ({ graph }) => {
    const head = graph.edges.filter((e) => !isTerraform(e.source))
      .map((e) => `${e.source} -${e.relation}-> ${e.target} ${e.confidence ?? ""}`).sort(byCodeUnit);
    assert.deepEqual(head, MAIN_EDGES);
  });
});

test("Terraform: a plain path, a duplicate address, a module outside the repository and a file that is not HCL give no link and a report", async () => {
  await withBuild({
    "live/main.tf": `module "app" {\n  source = "../mods/app"\n}\n\nmodule "far" {\n  source = "../../elsewhere"\n}\n\ndata "archive_file" "root" {\n  source_dir = "../src"\n}\n\ndata "archive_file" "out" {\n  source_dir = "\${path.module}/../../x"\n}\n`,
    "mods/app/main.tf": `data "archive_file" "child" {\n  source_dir = "src"\n}\n\nresource "x_y" "dup" {\n  a = x_z.one.id\n}\n`,
    "mods/app/more.tf": `resource "x_z" "one" {\n  b = 1\n}\n`,
    "mods/app/again.tf": `resource "x_z" "one" {\n  b = 2\n}\n`,
    "mods/app/src/a.py": "def a():\n    return 1\n",
    "src/b.py": "def b():\n    return 2\n",
    "broken/main.tf": `resource "x" "y" {\n  a = \n`,
  }, ({ result, graph }) => {
    assert.deepEqual(tfLinks(graph), [
      "live/main.tf#module.app -> mods/app/again.tf",
      "live/main.tf#module.app -> mods/app/main.tf",
      "live/main.tf#module.app -> mods/app/more.tf",
    ]);
    assert.deepEqual(reportsFor(result, "live/main.tf"), [
      "data.archive_file.out: a path outside the repository is not followed",
      "data.archive_file.root: a path not written from ${path.module} is not followed",
      "module.far: its module source is outside the repository",
    ]);
    assert.deepEqual(reportsFor(result, "mods/app/main.tf"), [
      "data.archive_file.child: a path not written from ${path.module} is not followed",
      "x_z.one is declared in more than one file of mods/app: references to it give no link",
    ]);
    assert.ok(result.skipped.some((s) => s.path === "broken/main.tf" && /not valid HCL at line \d+/.test(s.reason)), JSON.stringify(result.skipped));
  });
});

test("Terraform: count and for_each, dynamic blocks, for-expression names, Git modules, expression images and remote state give no link and a report", async () => {
  await withBuild({
    "infra/main.tf": `resource "aws_instance" "web" {
  count = 2
}

resource "aws_s3_bucket" "b" {
  for_each = toset(["a"])
}

resource "aws_eip" "one" {
  instance = aws_instance.web[0].id
}

resource "aws_eip" "all" {
  ids    = aws_instance.web[*].id
  legacy = aws_instance.web.*.id
}

resource "x_list" "l" {
  ids = values(aws_s3_bucket.b)[*].id
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_security_group" "sg" {
  name = "sg"
  dynamic "ingress" {
    for_each = var.rules
    content {
      cidr_blocks = [aws_vpc.main.cidr_block]
    }
  }
}

resource "s" "id" {
  x = 1
}

resource "x_y" "z" {
  list = [for s in var.list : s.id]
  map  = { for k, s in var.map : k => s.id }
}

module "git" {
  source = "git::https://example.com/net.git"
}

resource "aws_ecs_task_definition" "t" {
  container_definitions = jsonencode([{ image = var.image }])
}

data "terraform_remote_state" "net" {
  backend = "s3"
}

resource "x_r" "uses" {
  v = data.terraform_remote_state.net.outputs.id
  w = aws_vpc.main.id
}
`,
  }, ({ result, graph }) => {
    assert.deepEqual(tfLinks(graph), [
      "infra/main.tf#x_r.uses -> infra/main.tf#aws_vpc.main",
      "infra/main.tf#x_r.uses -> infra/main.tf#data.terraform_remote_state.net",
    ]);
    assert.deepEqual(reportsFor(result, "infra/main.tf"), [
      "aws_ecs_task_definition.t: an image named by an expression is not linked",
      "aws_eip.all: an indexed or splat reference to aws_instance.web gives no link",
      "aws_eip.one: an indexed or splat reference to aws_instance.web gives no link",
      "aws_s3_bucket.b has count or for_each: references to it give no link",
      "aws_security_group.sg: a dynamic block is not read",
      "data.terraform_remote_state.net: another state's outputs are not followed",
      "module.git: a module source that is not a local folder is not read",
    ]);
  });
});

test("Terraform: thousands of blocks in a chain and deeply nested expressions are read in bounded time and give each link once", async () => {
  const blocks = Array.from({ length: 3000 }, (_, i) => `resource "x_r" "r${i}" {\n  next = ${i ? `x_r.r${i - 1}.id` : "1"}\n}\n`).join("\n");
  const deep = `resource "x_d" "deep" {\n  v = ${"[".repeat(500)}x_r.r0.id${"]".repeat(500)}\n}\n`;
  const started = Date.now();
  await withBuild({ "big/main.tf": `${blocks}\n${deep}` }, ({ result, graph }) => {
    const links = tfLinks(graph);
    assert.equal(links.length, 3000);
    assert.ok(links.includes("big/main.tf#x_d.deep -> big/main.tf#x_r.r0"));
    assert.ok(links.includes("big/main.tf#x_r.r2999 -> big/main.tf#x_r.r2998"));
    assert.deepEqual(reportsFor(result, "big/main.tf"), []);
  });
  assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
});

test("Terraform: reports for one file stop at 20 and count the rest", async () => {
  const blocks = Array.from({ length: 25 }, (_, i) => `module "m${i}" {\n  source = "registry/m${i}/aws"\n}\n`).join("\n");
  await withBuild({ "many/main.tf": blocks }, ({ result }) => {
    const reports = reportsFor(result, "many/main.tf");
    assert.equal(reports.length, 21);
    assert.ok(reports.includes("and 5 more Terraform reports"));
  });
});
