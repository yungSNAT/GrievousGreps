/**
 * Which binding a name means where a route file uses it: the parameters of each function and
 * the names its own body binds, so a route, mount or handler is read only through the binding
 * it uses. A block is read as its function, and a Python class body as the scope around it:
 * both merge bindings, so a name bound twice gives no route rather than a guessed one.
 */
import type { SyntaxNode } from "./depth-parser.js";
import type { Language } from "./extract.js";

export const FUNCTIONS = new Set([
  "function_definition", "lambda", // Python
  "function_declaration", "function_expression", "function", "arrow_function", "method_definition",
  "generator_function_declaration", "generator_function", // JavaScript and TypeScript
  "method_declaration", "func_literal", // Go (function_declaration is shared)
]);

/** The module's scope; a function's is its node id. */
const MODULE = -1;

export function* descendants(node: SyntaxNode): Iterable<SyntaxNode> {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i]);
  }
}

const ACCESS = new Set([
  "attribute", "subscript", "call", "member_expression", "subscript_expression", "call_expression",
  "selector_expression", "index_expression", "type_annotation",
]);

/** The names a binding target or parameter binds: not its default, type, keys or accessed objects. */
function patternNames(n: SyntaxNode | null | undefined): string[] {
  if (!n || ACCESS.has(n.type)) return [];
  switch (n.type) {
    case "identifier": case "shorthand_property_identifier_pattern": return [n.text];
    case "assignment_pattern": case "object_assignment_pattern": return patternNames(n.childForFieldName("left"));
    case "default_parameter": case "typed_default_parameter": return patternNames(n.childForFieldName("name"));
    case "typed_parameter": return patternNames(n.namedChildren[0]);
    case "pair_pattern": return patternNames(n.childForFieldName("value"));
    case "required_parameter": case "optional_parameter": return patternNames(n.childForFieldName("pattern"));
    case "parameter_declaration": case "variadic_parameter_declaration":
      return n.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
    default: return n.namedChildren.flatMap(patternNames);
  }
}

function enclosing(n: SyntaxNode): SyntaxNode | null {
  for (let p = n.parent; p; p = p.parent) if (FUNCTIONS.has(p.type)) return p;
  return null;
}

/** The names `n` binds, and whether it declares them where it stands (else it assigns whatever binding they name). */
function bindingAt(n: SyntaxNode, lang: Language): { names: string[]; declares: boolean } | null {
  const py = lang === "python";
  const field = (name: string, declares: boolean) => ({ names: patternNames(n.childForFieldName(name)), declares });
  switch (n.type) {
    // Python binds in the function's scope on any assignment; JavaScript and Go `=` assign.
    case "assignment": case "augmented_assignment": case "for_statement": return field("left", true);
    case "named_expression": return field("name", true);
    case "as_pattern": return field("alias", true);
    case "assignment_expression": case "augmented_assignment_expression": case "assignment_statement": return field("left", false);
    case "for_in_statement": return field("left", n.childForFieldName("kind") !== null);
    case "short_var_declaration": return field("left", true);
    case "range_clause": return field("left", n.children.some((c) => c.type === ":="));
    case "variable_declarator": case "function_declaration": case "generator_function_declaration":
    case "class_declaration": case "function_definition": case "class_definition": return field("name", true);
    case "var_spec": case "const_spec": return { names: n.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text), declares: true };
    case "catch_clause": return field("parameter", true);
    case "import_from_statement": {
      const names = n.namedChildren.slice(1).map((c) => (c.type === "aliased_import" ? c.childForFieldName("alias") : c)?.text ?? "");
      return { names: names.filter((x) => /^\w+$/.test(x)), declares: true };
    }
    case "import_statement": {
      if (py) {
        const names = n.namedChildren.map((c) => (c.type === "aliased_import" ? c.childForFieldName("alias")?.text : c.text.split(".")[0]) ?? "");
        return { names, declares: true };
      }
      const clause = n.namedChildren.find((c) => c.type === "import_clause");
      const names = (clause?.namedChildren ?? []).flatMap((c) =>
        c.type === "identifier" ? [c.text]
          : c.type === "namespace_import" ? patternNames(c)
            : c.type === "named_imports" ? c.namedChildren.map((s) => (s.childForFieldName("alias") ?? s.childForFieldName("name"))?.text ?? "") : []);
      return { names, declares: true };
    }
    default: return null;
  }
}

/** Every binding in a file, by scope. */
export class Scopes {
  private readonly params = new Map<number, Set<string>>();
  private readonly declared = new Map<number, Set<string>>();
  /** Python `global` and `nonlocal` names, by the function that names them. */
  private readonly lifted = new Map<number, Map<string, "global" | "nonlocal">>();
  private readonly counts = new Map<string, number>();

  constructor(root: SyntaxNode, private readonly lang: Language) {
    const bindings: Array<[SyntaxNode, string, boolean]> = [];
    for (const n of descendants(root)) {
      if (FUNCTIONS.has(n.type)) {
        const lists = ["parameters", "parameter", "receiver", "result"].map((f) => n.childForFieldName(f));
        this.params.set(n.id, new Set(lists.flatMap((l) => (l?.type === "identifier" ? [l.text] : (l?.namedChildren ?? []).flatMap(patternNames)))));
      }
      const f = n.type === "global_statement" || n.type === "nonlocal_statement" ? enclosing(n) : null;
      if (f) {
        const own = this.lifted.get(f.id) ?? new Map<string, "global" | "nonlocal">();
        for (const c of n.namedChildren) own.set(c.text, n.type === "global_statement" ? "global" : "nonlocal");
        this.lifted.set(f.id, own);
      }
      const b = bindingAt(n, lang);
      for (const name of b?.names ?? []) if (name && name !== "_") bindings.push([n, name, b!.declares]);
    }
    for (const [n, name, declares] of bindings) {
      const f = enclosing(n);
      if (!declares || (f && this.lifted.get(f.id)?.has(name))) continue;
      const scope = f?.id ?? MODULE;
      const own = this.declared.get(scope) ?? new Set<string>();
      own.add(name);
      this.declared.set(scope, own);
    }
    for (const [n, name, declares] of bindings) {
      const key = this.binding(n, name, declares);
      if (key !== null) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
  }

  /** The binding `name` means at `node`, as a key; null for a function parameter. */
  use(node: SyntaxNode, name: string): string | null {
    for (let p = node.parent; p; p = p.parent) {
      if (!FUNCTIONS.has(p.type)) continue;
      if (this.params.get(p.id)?.has(name)) return null;
      if (this.declared.get(p.id)?.has(name)) return `${p.id}:${name}`;
    }
    return `${MODULE}:${name}`;
  }

  /** The binding a declaration or assignment of `name` at `node` sets, as a key; null for a parameter. */
  binding(node: SyntaxNode, name: string, declares = bindingAt(node, this.lang)?.declares ?? false): string | null {
    const f = enclosing(node);
    const lifted = f ? this.lifted.get(f.id)?.get(name) : undefined;
    if (lifted === "global") return `${MODULE}:${name}`;
    if (lifted === "nonlocal") return this.use(f!, name);
    if (!declares) return this.use(node, name);
    if (f && this.params.get(f.id)?.has(name)) return null;
    return `${f?.id ?? MODULE}:${name}`;
  }

  /** How many times the file binds `key`'s name in its scope. */
  count(key: string | null): number {
    return key === null ? 0 : this.counts.get(key) ?? 0;
  }

  /** The key of `name` at the module level. */
  static module(name: string): string {
    return `${MODULE}:${name}`;
  }
}
