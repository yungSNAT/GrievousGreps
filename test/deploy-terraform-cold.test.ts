/**
 * A Terraform file read before its grammar loads fails the run's parse, not the file: an error `build.ts` records and
 * re-parses next run, never a skip cached against the file's hash. Its own file, so no other test has warmed the grammar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDeploy } from "../src/graph/deploy.js";

test("a Terraform file read without its grammar throws instead of returning a cached skip", () => {
  assert.throws(() => extractDeploy("infra/main.tf", `resource "x_y" "z" {\n  a = 1\n}\n`, "terraform"), /Terraform grammar did not load/);
});
