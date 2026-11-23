import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { readPythonRoots, PythonModules } from "../src/graph/python-roots.js";

const made: string[] = [];
function repo(tag: string): string {
  const dir = tmpRepo(tag);
  made.push(dir);
  return dir;
}

after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const sorted = (xs: string[]) => [...xs].sort();

describe("readPythonRoots reads the directories each config file names", () => {
  test("pyproject.toml: hatch paths, poetry from, maturin, setuptools package-dir and pythonpath", () => {
    const root = repo("pyroots-pyproject");
    const file = join(root, "pyproject.toml");
    writeFileSync(
      file,
      [
        "[tool.hatch.build.targets.wheel]",
        'packages = ["src/alpha", "beta"]',
        "[tool.poetry]",
        'packages = [{ include = "gamma", from = "poetry_src" }]',
        "[tool.maturin]",
        'python-source = "pysrc"',
        "[tool.setuptools.package-dir]",
        '"" = "lib"',
        "[tool.pytest.ini_options]",
        'pythonpath = ["scripts"]',
        "[tool.other]",
        'package-dir = {"" = "inline"}',
        'where = ["../outside"]',
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "README.md"), "# not a config\n");
    const roots = readPythonRoots(root, [file, join(root, "README.md")]);
    assert.deepEqual(sorted(roots), sorted(["", "src", "poetry_src", "pysrc", "lib", "scripts", "inline"]));
    assert.ok(!roots.includes("gamma"), "a package name without a slash is not a directory");
    assert.ok(!roots.some((r) => r.startsWith("..")), "a path leaving the repo is skipped");
  });

  test("setup.py in a subdirectory: package_dir mapping and find_packages(where=...)", () => {
    const root = repo("pyroots-setuppy");
    const sub = join(root, "pkgs", "one");
    mkdirSync(sub, { recursive: true });
    const file = join(sub, "setup.py");
    writeFileSync(
      file,
      'from setuptools import setup, find_packages\nsetup(name="one", package_dir={"": "lib"}, packages=find_packages(where="code"))\n',
    );
    const roots = readPythonRoots(root, [file]);
    assert.deepEqual(sorted(roots), sorted(["pkgs/one", "pkgs/one/src", "pkgs/one/lib", "pkgs/one/code"]));
  });

  test("setup.cfg: package_dir on the next line and where, absolute paths skipped", () => {
    const root = repo("pyroots-setupcfg");
    const file = join(root, "setup.cfg");
    writeFileSync(
      file,
      "[options]\npackage_dir =\n    = source\n[options.packages.find]\nwhere = source\nwhere = /abs\n",
    );
    const roots = readPythonRoots(root, [file]);
    assert.deepEqual(sorted(roots), sorted(["", "src", "source"]));
    assert.ok(!roots.includes("/abs"));
  });

  test("an unreadable config file (a directory by that name) states only its own dir and src", () => {
    const root = repo("pyroots-unreadable");
    const bad = join(root, "broken", "setup.cfg");
    mkdirSync(bad, { recursive: true });
    const roots = readPythonRoots(root, [bad]);
    assert.deepEqual(sorted(roots), sorted(["broken", "broken/src"]));
  });

  test("a repo with no config file has no stated roots", () => {
    const root = repo("pyroots-none");
    writeFileSync(join(root, "main.py"), "print(1)\n");
    assert.deepEqual(readPythonRoots(root, [join(root, "main.py")]), []);
  });
});

describe("PythonModules scopes implicit package roots", () => {
  const files = ["tests/unit/pkg/__init__.py", "tests/unit/pkg/mod.py", "tests/unit/test_x.py", "app/main.py", "src/lib/__init__.py"];

  test("without configuration a top-level package's parent serves the whole repo", () => {
    const mods = new PythonModules(files);
    assert.equal(mods.resolve("pkg.mod", "app/main.py"), "tests/unit/pkg/mod.py");
    assert.equal(mods.resolve("pkg.mod", "tests/unit/test_x.py"), "tests/unit/pkg/mod.py");
  });

  test("with configuration a package under a test directory serves that test tree alone", () => {
    const mods = new PythonModules(files, ["src"]);
    assert.equal(mods.resolve("pkg.mod", "tests/unit/test_x.py"), "tests/unit/pkg/mod.py");
    assert.equal(mods.resolve("pkg.mod", "app/main.py"), "external");
    assert.equal(mods.resolve("lib", "app/main.py"), "src/lib/__init__.py");
  });

  test("with configuration a package outside test dirs keeps its parent as its own scope", () => {
    const mods = new PythonModules(["tools/helpers/__init__.py", "tools/helpers/fmt.py", "tools/run.py", "app/main.py"], [""]);
    assert.equal(mods.resolve("helpers.fmt", "tools/run.py"), "tools/helpers/fmt.py");
    assert.equal(mods.resolve("helpers.fmt", "app/main.py"), "external");
  });
});
