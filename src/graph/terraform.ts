/**
 * Terraform files (`.tf`), read for the deploy graph (`deploy.ts`). Each top-level `resource`, `data` and `module`
 * block is a block named by its address (`aws_lambda_function.api`, `data.archive_file.api`, `module.net`), with what
 * it names: the addresses its expressions reach, a local module's folder (`source = "./modules/net"`), the paths a
 * `source_dir`, `source_file` or `file()`-family call reads when written `"${path.module}/..."`, and the images an
 * `image` or `image_uri` names as a plain string. Anything else gives no link and a note: an indexed or splat
 * reference (`count`, `for_each`), a `dynamic` block, a module from a registry or Git, a path or image built from
 * variables, locals or other expressions, and another state's outputs. Only names are kept: no attribute value
 * reaches a node or a note.
 */
import { loadWasmLanguage, parseWasm, type TsNode } from "./generic.js";

export interface TerraformBlock {
  /** `resource`, `data` or `module`. */
  kind: string;
  /** The resource or data type; empty for a module. */
  type: string;
  address: string;
  lines: [number, number];
  /** Addresses its expressions name as written, unindexed: `T.N`, `data.T.N`, `module.N`. */
  addresses: string[];
  /** Paths it reads, relative to its file's folder, each written from `${path.module}`. */
  paths: string[];
  images: string[];
  /** A module's local source folder, relative to its file's folder. */
  source?: string;
  /** It has `count` or `for_each`, so it stands for several instances. */
  counted: boolean;
  /** What it names that is not followed, one note each. */
  notes: string[];
}

let language: unknown;

/** Load the grammar once; false when it is missing or will not load. */
export async function warmTerraform(): Promise<boolean> {
  language ??= await loadWasmLanguage("terraform");
  return language !== null;
}

/** Not names of a block: input variables, locals, `path.*`, `each`, `count`, `self` and `terraform.*`. */
const NOT_BLOCKS = new Set(["var", "local", "path", "each", "count", "self", "terraform"]);
const PATH_ATTRIBUTES = new Set(["source_dir", "source_file"]);
const PATH_FUNCTIONS = new Set(["file", "templatefile", "filebase64", "filemd5", "filesha1", "filesha256", "filesha512", "filebase64sha256", "filebase64sha512"]);
const IMAGE_KEYS = new Set(["image", "image_uri"]);
const FOR_EXPRS = new Set(["for_tuple_expr", "for_object_expr"]);

/** One syntax node: web-tree-sitter hands out a new object on each access. */
const same = (a: TsNode | null | undefined, b: TsNode | null | undefined) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
const named = (n: TsNode): TsNode[] => Array.from({ length: n.namedChildCount ?? 0 }, (_, i) => n.namedChild!(i)!);

/** Every node under `n` once, depth first, with the names enclosing `for` expressions bind; `skip` prunes a subtree. */
function* walk(n: TsNode, skip: (n: TsNode) => boolean = () => false): Iterable<[TsNode, ReadonlySet<string>]> {
  const stack: Array<[TsNode, ReadonlySet<string>]> = [[n, new Set()]];
  while (stack.length) {
    const [next, bound] = stack.pop()!;
    yield [next, bound];
    if (skip(next)) continue;
    let inner = bound;
    if (FOR_EXPRS.has(next.type)) {
      const intro = named(next).find((c) => c.type === "for_intro");
      const names = intro ? named(intro).filter((c) => c.type === "identifier").map((c) => c.text) : [];
      inner = new Set([...bound, ...names]);
    }
    for (const c of named(next).reverse()) stack.push([c, inner]);
  }
}

/** A string with no interpolation: a block label or a plain quoted value. */
function plain(n: TsNode | undefined): string | null {
  const s = n?.type === "expression" ? named(n)[0] : n;
  const lit = s?.type === "literal_value" ? named(s)[0] : s;
  if (lit?.type !== "string_lit") return null;
  const parts = named(lit).filter((c) => !c.type.startsWith("quoted_template_"));
  return parts.length === 0 ? "" : parts.length === 1 && parts[0].type === "template_literal" ? parts[0].text : null;
}

/** A path written `"${path.module}/rest"`, as `rest`; null for any other form. */
function modulePath(n: TsNode | undefined): string | null {
  const template = n?.type === "expression" ? named(n)[0] : null;
  const quoted = template?.type === "template_expr" ? named(template)[0] : null;
  const parts = quoted?.type === "quoted_template" ? named(quoted).filter((c) => !c.type.startsWith("quoted_template_")) : [];
  if (parts.length !== 2 || parts[0].type !== "template_interpolation" || parts[1].type !== "template_literal") return null;
  const inner = named(parts[0]).find((c) => c.type === "expression");
  const t = traversal(inner);
  if (t?.names.join(".") !== "path.module" || t.indexed || !parts[1].text.startsWith("/")) return null;
  return parts[1].text.slice(1) || ".";
}

/**
 * The names of a traversal expression (`aws_iam_role.lambda.arn`) up to its first index or splat, and whether one
 * follows them directly.
 */
function traversal(n: TsNode | undefined): { names: string[]; indexed: boolean } | null {
  const kids = n?.type === "expression" ? named(n) : [];
  if (kids[0]?.type !== "variable_expr") return null;
  const names = [named(kids[0])[0]?.text ?? ""];
  for (const k of kids.slice(1)) {
    if (k.type === "get_attr") names.push(named(k)[0]?.text ?? "");
    else return { names, indexed: k.type === "index" || k.type === "splat" };
  }
  return { names, indexed: false };
}

/** The length of the block address a traversal starts with, or 0 for a variable, local, path or other non-block name. */
function addressLength(names: string[]): number {
  if (NOT_BLOCKS.has(names[0])) return 0;
  const length = names[0] === "data" ? 3 : 2;
  return names.length >= length ? length : 0;
}

/** An object element's key, when it is a plain name or string. */
function keyOf(elem: TsNode): string | null {
  const key = named(elem)[0];
  const t = traversal(key);
  return t?.names.length === 1 && !t.indexed ? t.names[0] : plain(key);
}

const isDynamic = (n: TsNode) => n.type === "block" && named(n)[0]?.type === "identifier" && named(n)[0].text === "dynamic";

function readBlock(block: TsNode): TerraformBlock | null {
  const kids = named(block);
  const kind = kids[0]?.type === "identifier" ? kids[0].text : "";
  const labels = kids.filter((c) => c.type === "string_lit").map(plain);
  if (labels.some((l) => !l)) return null;
  let type = "";
  let address: string;
  if ((kind === "resource" || kind === "data") && labels.length === 2) {
    type = labels[0]!;
    address = `${kind === "data" ? "data." : ""}${labels[0]}.${labels[1]}`;
  } else if (kind === "module" && labels.length === 1) address = `module.${labels[0]}`;
  else return null;
  const body = kids.find((c) => c.type === "body");
  const out: TerraformBlock = {
    kind, type, address, lines: [block.startPosition.row + 1, block.endPosition.row + 1],
    addresses: [], paths: [], images: [], counted: false, notes: [],
  };
  const addresses = new Set<string>();
  const notes = new Set<string>();
  if (type === "terraform_remote_state") notes.add(`${address}: another state's outputs are not followed`);
  for (const [n, bound] of body ? walk(body, isDynamic) : []) {
    if (isDynamic(n)) notes.add(`${address}: a dynamic block is not read`);
    else if (n.type === "expression" && !(n.parent?.type === "object_elem" && same(named(n.parent)[0], n))) {
      const t = traversal(n);
      const length = t && !bound.has(t.names[0]) ? addressLength(t.names) : 0;
      if (!t || !length) continue;
      const to = t.names.slice(0, length).join(".");
      if (t.names.length === length && t.indexed) notes.add(`${address}: an indexed or splat reference to ${to} gives no link`);
      else if (to !== address) addresses.add(to);
    } else if (n.type === "attribute" || n.type === "object_elem") {
      const key = n.type === "attribute" ? named(n)[0]?.text ?? null : keyOf(n);
      const value = named(n)[1];
      const top = same(n.parent, body);
      if (top && (key === "count" || key === "for_each")) out.counted = true;
      if (key && PATH_ATTRIBUTES.has(key)) readPath(out, notes, value);
      if (key && IMAGE_KEYS.has(key)) {
        const image = plain(value);
        if (image) out.images.push(image);
        else notes.add(`${address}: an image named by an expression is not linked`);
      }
      // A module's own `source`, not one inside a nested block.
      if (kind === "module" && key === "source" && top) {
        const src = plain(value);
        if (src && /^\.\.?\//.test(src)) out.source = src;
        else notes.add(`${address}: a module source that is not a local folder is not read`);
      }
    } else if (n.type === "function_call" && PATH_FUNCTIONS.has(named(n)[0]?.text ?? "")) {
      const args = named(n).find((c) => c.type === "function_arguments");
      readPath(out, notes, args ? named(args).find((c) => c.type === "expression") : undefined);
    }
  }
  out.addresses = [...addresses];
  out.notes = [...notes];
  return out;
}

function readPath(out: TerraformBlock, notes: Set<string>, value: TsNode | undefined): void {
  const p = modulePath(value);
  if (p !== null) out.paths.push(p);
  else notes.add(`${out.address}: a path not written from \${path.module} is not followed`);
}

/** A file's blocks, or the reason it cannot be read. */
export function readTerraform(source: string): { blocks: TerraformBlock[] } | { skipped: string } {
  if (!language) return { skipped: "the Terraform grammar did not load" };
  const root = parseWasm(language, source);
  if (!root) return { skipped: "Terraform parse failed" };
  if (root.hasError) {
    let bad: TsNode | undefined;
    for (const [n] of walk(root)) {
      if (n.type === "ERROR" || (n as { isMissing?: boolean }).isMissing) {
        bad = n;
        break;
      }
    }
    return { skipped: `not valid HCL${bad ? ` at line ${bad.startPosition.row + 1}` : ""}` };
  }
  const body = named(root).find((c) => c.type === "body");
  const blocks: TerraformBlock[] = [];
  for (const b of body ? named(body) : []) {
    const read = b.type === "block" ? readBlock(b) : null;
    if (read) blocks.push(read);
  }
  return { blocks };
}
