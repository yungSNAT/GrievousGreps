import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  collectBindings,
  defName,
  FileBindings,
  goLiteralScope,
  goReceiverVarOf,
  rDefName,
  resolveRecvType,
} from "../src/graph/bindings.js";
import type { SyntaxNode } from "../src/graph/depth-parser.js";

type Child = Ast | [field: string, node: Ast];
type Ast = {
  id: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex?: number;
  isNamed: boolean;
  parent: Ast | null;
  children: Ast[];
  namedChildren: Ast[];
  childForFieldName(name: string): Ast | null;
};

let nextId = 1;

// Small tree-sitter-shaped fixtures: preserve fields, named vs. anonymous
// children, and parent links without needing any language grammar at runtime.
function n(type: string, content: string | Child[] = [], startIndex = 0, isNamed = true): Ast {
  const fields = new Map<string, Ast>();
  const children = typeof content === "string" ? [] : content.map((child) => {
    if (!Array.isArray(child)) return child;
    fields.set(child[0], child[1]);
    return child[1];
  });
  const node: Ast = {
    id: nextId++,
    type,
    text: typeof content === "string" ? content : "",
    startIndex,
    isNamed,
    parent: null,
    children,
    namedChildren: children.filter((child) => child.isNamed),
    childForFieldName: (name) => fields.get(name) ?? null,
  };
  for (const child of children) child.parent = node;
  return node;
}

const syntax = (node: Ast): SyntaxNode => node as unknown as SyntaxNode;
const id = (name: string) => n("identifier", name);
const typeId = (name: string) => n("type_identifier", name);
const token = (text: string) => n(text, text, 0, false);

type RecvCtx = Parameters<typeof resolveRecvType>[1];
function ctx(lang: RecvCtx["lang"], bindings: FileBindings, overrides: Partial<RecvCtx> = {}): RecvCtx {
  return { lang, bindings, scope: [], goLiterals: [], ...overrides } as RecvCtx;
}

describe("R definition names", () => {
  const binary = (lhs: Ast, op: string, rhs: Ast) =>
    n("binary_operator", [["lhs", lhs], ["operator", token(op)], ["rhs", rhs]]);
  const fn = (body: Ast) => n("function_definition", [["body", body]]);

  test("recognizes left assignments and the right assignment inside a function body", () => {
    for (const op of ["<-", "<<-", "="]) {
      const assignment = binary(id("build"), op, fn(n("braced_expression")));
      assert.equal(defName(syntax(assignment), "r"), "build", op);
    }
    for (const op of ["->", "->>"]) {
      const definition = fn(binary(n("braced_expression"), op, id("build")));
      assert.equal(rDefName(syntax(definition)), "build", op);
    }
  });

  test("does not name ordinary expressions, anonymous functions, or incomplete assignments", () => {
    const cases = [
      binary(id("x"), "+", id("y")),
      binary(id("x"), "<-", n("integer", "1L")),
      n("binary_operator", [["lhs", id("x")], ["rhs", fn(n("braced_expression"))]]),
      fn(n("braced_expression")),
      fn(binary(id("x"), "+", id("y"))),
      fn(binary(id("x"), "->", n("extract_operator"))),
      id("build"),
    ];
    for (const node of cases) assert.equal(rDefName(syntax(node)), null);
  });
});

describe("Go receiver and func literal scopes", () => {
  const param = (name: string, type: Ast) =>
    n("parameter_declaration", [["name", id(name)], ["type", type]]);

  test("a literal parameter shadows the method receiver, but an unshadowed literal inherits it", () => {
    const shadow = n("func_literal", [
      ["parameters", n("parameter_list", [param("w", n("pointer_type", [typeId("Logger")]))])],
      ["body", n("block")],
    ], 80);
    shadow.endIndex = 130;
    const inherit = n("func_literal", [
      ["parameters", n("parameter_list")],
      ["body", n("block")],
    ], 140);
    inherit.endIndex = 190;
    const method = n("method_declaration", [
      ["receiver", n("parameter_list", [param("w", n("pointer_type", [typeId("Worker")]))])],
      ["name", n("field_identifier", "Run")],
      ["parameters", n("parameter_list", [param("job", typeId("Job"))])],
      ["body", n("block", [shadow, inherit])],
    ]);
    const worker = n("type_spec", [
      ["name", typeId("Worker")],
      ["type", n("struct_type", [n("field_declaration_list", [
        n("field_declaration", [["name", n("field_identifier", "log")], ["type", typeId("Logger")]]),
      ])])],
    ]);
    const root = n("source_file", [n("type_declaration", [worker]), method]);
    const bindings = collectBindings(syntax(root), "go");

    assert.equal(defName(syntax(method), "go"), "Worker.Run");
    assert.equal(goReceiverVarOf(syntax(method)), "w");
    assert.equal(goLiteralScope(syntax(shadow)), "@80");
    assert.equal(defName(syntax(inherit), "go"), "@140");
    // A literal's parameter is in scope over the literal's whole span, and only there.
    assert.equal(bindings.goAt(["Worker.Run"], ["@80"], "w", 90), "Logger");
    assert.equal(bindings.goAt(["Worker.Run"], ["@80"], "w", 130), undefined);
    assert.equal(bindings.goAt(["Worker.Run"], ["@140"], "w", 150), undefined);

    const methodCtx = ctx("go", bindings, {
      scope: ["Worker.Run"], enclosingClass: "Worker", goReceiverVar: "w",
    });
    assert.equal(resolveRecvType("w", methodCtx), "Worker");
    assert.equal(resolveRecvType("job", methodCtx), "Job");
    assert.equal(resolveRecvType("w", { ...methodCtx, goLiterals: ["@80"] }, 90), "Logger");
    assert.equal(resolveRecvType("w", { ...methodCtx, goLiterals: ["@140"] }, 150), "Worker");
    assert.equal(resolveRecvType("w.log", methodCtx), "Logger");
    assert.equal(resolveRecvType("w.missing", methodCtx), undefined);
    assert.equal(resolveRecvType("missing.log", methodCtx), undefined);
  });

  test("qualifies a value receiver and falls back to the method name for incomplete receivers", () => {
    const method = (receiver?: Ast) => n("method_declaration", [
      ...(receiver ? [["receiver", receiver] as Child] : []),
      ["name", n("field_identifier", "Run")],
    ]);
    const value = method(n("parameter_list", [
      n("parameter_declaration", [["type", typeId("Worker")]]),
    ]));
    assert.equal(defName(syntax(value), "go"), "Worker.Run");
    assert.equal(goReceiverVarOf(syntax(value)), null);
    assert.equal(defName(syntax(method()), "go"), "Run");
    assert.equal(defName(syntax(method(n("parameter_list"))), "go"), "Run");
    assert.equal(defName(syntax(n("method_declaration")), "go"), null);
  });
});

test("PHP closure and anonymous-class parameters stay in the scopes that introduce them", () => {
  const variable = (name: string) => n("variable_name", `$${name}`);
  const parameters = (name: string, type: string) => n("formal_parameters", [
    n("simple_parameter", [
      ["type", n("named_type", [n("name", type)])],
      ["name", variable(name)],
    ]),
  ]);
  const arrow = n("arrow_function", [["parameters", parameters("item", "Item")]]);
  const callback = n("anonymous_function", [["parameters", parameters("entry", "Entry")]]);
  const anonymous = n("anonymous_class", [n("declaration_list", [
    n("method_declaration", [
      ["name", n("name", "save")],
      ["parameters", parameters("record", "Record")],
    ]),
  ])]);
  const root = n("program", [
    n("expression_statement", [
      n("assignment_expression", [["left", variable("convert")], ["right", arrow]]),
    ]),
    n("expression_statement", [n("function_call_expression", [
      ["function", n("name", "register")],
      ["arguments", n("arguments", [n("argument", [callback])])],
    ])]),
    n("expression_statement", [n("object_creation_expression", [anonymous])]),
  ]);
  const bindings = collectBindings(syntax(root), "php");

  assert.equal(defName(syntax(arrow), "php"), "convert");
  assert.equal(defName(syntax(callback), "php"), "{closure}");
  assert.equal(defName(syntax(anonymous), "php"), "{anonymous}");
  assert.equal(resolveRecvType("$item", ctx("php", bindings, { scope: ["convert"] })), "Item");
  assert.equal(bindings.lookup(["{closure}"], "$entry"), "Entry");
  assert.equal(bindings.lookup(["{anonymous}", "save"], "$record"), "Record");
  assert.equal(resolveRecvType("$item", ctx("php", bindings)), undefined);
  assert.equal(resolveRecvType("Factory", ctx("php", bindings)), "Factory");
});

test("Swift binds optional annotated fields and constructor calls, not arbitrary call results", () => {
  const simple = (name: string) => n("simple_identifier", name);
  const property = (name: string, ...rest: Child[]) =>
    n("property_declaration", [n("pattern", [simple(name)]), ...rest]);
  const call = (name: string) => n("call_expression", [simple(name)]);
  const optional = (type: Ast) => n("optional_type", [type, token("?")]);
  const owner = n("class_declaration", [
    typeId("Clinic"),
    n("class_body", [
      property("opened", n("type_annotation", [
        optional(n("user_type", [typeId("Foundation"), token("."), typeId("Date")])),
      ])),
      property("vet", ["value", call("Vet")]),
      property("candidate", ["value", call("findVet")]),
      property("team", n("type_annotation", [
        optional(n("array_type", [n("user_type", [typeId("Vet")])])),
      ])),
      n("function_declaration", [
        simple("admit"),
        n("parameter", [simple("patient"), simple("animal"), n("user_type", [typeId("Animal")])]),
        n("function_body"),
      ]),
    ]),
  ]);
  const bindings = collectBindings(syntax(n("source_file", [owner])), "swift");
  const scope = ["Clinic", "admit"];
  const method = ctx("swift", bindings, { scope, enclosingClass: "Clinic", rSuperClass: "Hospital" });

  assert.equal(bindings.lookup(scope, "opened"), "Date");
  assert.equal(resolveRecvType("self.opened", method), "Date");
  assert.equal(resolveRecvType("self.vet", method), "Vet");
  assert.equal(resolveRecvType("animal", method), "Animal");
  assert.equal(resolveRecvType("patient", method), undefined);
  assert.equal(resolveRecvType("candidate", method), undefined);
  assert.equal(resolveRecvType("team", method), undefined);
  assert.equal(resolveRecvType("Vet", method), "Vet");
  bindings.set("Clinic.admit", "Vet", "TestDouble");
  assert.equal(resolveRecvType("Vet", method), "TestDouble");
  assert.equal(resolveRecvType("super", method), "Hospital");
  assert.equal(resolveRecvType("super", ctx("swift", bindings)), undefined);
});

test("Python resolves annotation aliases and records typed, delegated, and unknown instance fields", () => {
  const type = (name: string) => n("type", [id(name)]);
  const alias = (name: Ast, as: string) =>
    n("aliased_import", [["name", name], ["alias", id(as)]]);
  const attr = (owner: string, name: string) =>
    n("attribute", [["object", id(owner)], ["attribute", id(name)]]);
  const call = (callee: Ast) => n("call", [["function", callee], ["arguments", n("argument_list")]]);
  const stmt = (...fields: Child[]) => n("expression_statement", [n("assignment", fields)]);
  const root = n("module", [
    n("class_definition", [
      ["name", id("Worker")],
      ["body", n("block", [
        stmt(["left", id("config")], ["type", type("C")]),
        n("function_definition", [
          ["name", id("setup")],
          ["parameters", n("parameters", [
            id("self"),
            n("typed_parameter", [id("repo"), ["type", type("R")]]),
            n("typed_parameter", [
              id("tags"), ["type", n("type", [n("generic_type", [id("list")])])],
            ]),
          ])],
          ["body", n("block", [
            stmt(["left", attr("self", "config")], ["right", call(id("C"))]),
            stmt(["left", attr("self", "cache")], ["right", call(attr("self", "make_cache"))]),
            stmt(["left", attr("self", "result")], ["right", call(attr("helpers", "load"))]),
            stmt(["left", id("client")], ["right", call(attr("helpers", "Client"))]),
          ])],
        ]),
      ])],
    ]),
    // Aliases are collected before bindings, regardless of their textual order.
    n("import_statement", [["name", alias(n("dotted_name", [id("services"), id("Config")]), "C")]]),
    n("import_from_statement", [
      ["module_name", n("dotted_name", [id("storage")])],
      ["name", alias(n("dotted_name", [id("Repository")]), "R")],
    ]),
  ]);
  const bindings = collectBindings(syntax(root), "python");
  const scope = ["Worker", "setup"];
  const method = ctx("python", bindings, { scope, enclosingClass: "Worker" });

  assert.equal(bindings.lookup(scope, "config"), "Config");
  assert.equal(bindings.lookup(scope, "repo"), "Repository");
  assert.equal(bindings.lookup(scope, "tags"), null);
  assert.equal(bindings.lookup(scope, "client"), "Client");
  assert.deepEqual(bindings.fields.get("Worker")?.get("config"), [
    { type: "Config" }, { type: "Config" },
  ]);
  assert.deepEqual(bindings.fields.get("Worker")?.get("cache"), [{ returns: "make_cache" }]);
  assert.deepEqual(bindings.fields.get("Worker")?.get("result"), [{ unknown: true }]);
  assert.equal(resolveRecvType("this.config", method), "Config");
  assert.equal(resolveRecvType("self.result", method), undefined);
  assert.equal(resolveRecvType("cls", method), "Worker");
  assert.equal(resolveRecvType("MyService", method), "MyService");
  assert.equal(resolveRecvType("missing", method), undefined);
  assert.equal(resolveRecvType(undefined, method), undefined);
});

test("Java fields are visible in methods and var locals bind from constructor initializers", () => {
  const declaration = (kind: string, type: string, name: string, value?: Ast) =>
    n(kind, [
      ["type", typeId(type)],
      n("variable_declarator", value ? [["name", id(name)], ["value", value]] : [["name", id(name)]]),
    ]);
  const root = n("program", [
    n("class_declaration", [
      ["name", id("Store")],
      ["body", n("class_body", [
        declaration("field_declaration", "Repository", "repo"),
        n("method_declaration", [
          ["name", id("save")],
          ["body", n("block", [
            declaration("local_variable_declaration", "var", "item",
              n("object_creation_expression", [["type", typeId("Item")]])),
            declaration("local_variable_declaration", "var", "unknown", n("method_invocation")),
          ])],
        ]),
      ])],
    ]),
  ]);
  const bindings = collectBindings(syntax(root), "java");
  const scope = ["Store", "save"];

  assert.equal(bindings.lookup(scope, "repo"), "Repository");
  assert.equal(resolveRecvType("this.repo", ctx("java", bindings, { scope })), "Repository");
  assert.equal(bindings.lookup(scope, "item"), "Item");
  assert.equal(bindings.lookup(["Store"], "item"), null);
  assert.equal(bindings.lookup(scope, "unknown"), null);
});

test("TypeScript constructor parameter properties retain their imported type outside the constructor", () => {
  const parameter = (name: string, ...modifiers: Ast[]) => n("required_parameter", [
    ...modifiers,
    ["pattern", id(name)],
    ["type", n("type_annotation", [typeId("Svc")])],
  ]);
  const root = n("program", [
    n("import_statement", [n("import_clause", [n("named_imports", [
      n("import_specifier", [["name", id("Service")], ["alias", id("Svc")]]),
    ])])]),
    n("class_declaration", [
      ["name", typeId("Controller")],
      ["body", n("class_body", [
        n("method_definition", [
          ["name", n("property_identifier", "constructor")],
          ["parameters", n("formal_parameters", [
            parameter("svc", n("accessibility_modifier", "private"), token("readonly")),
            parameter("temporary"),
          ])],
        ]),
      ])],
    ]),
  ]);
  const bindings = collectBindings(syntax(root), "typescript");
  const action = ctx("typescript", bindings, { scope: ["Controller", "handle"] });

  assert.equal(bindings.lookup(["Controller", "constructor"], "temporary"), "Service");
  assert.equal(resolveRecvType("this.svc", action), "Service");
  assert.equal(resolveRecvType("this.temporary", action), undefined);
});
