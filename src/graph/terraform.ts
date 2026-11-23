/**
 * Terraform files (`.tf`), read for the deploy graph (`deploy.ts`). Each top-level `resource`, `data` and `module`
 * block is a block named by its address (`aws_lambda_function.api`, `data.archive_file.api`, `module.net`), with what
 * it names: the addresses its expressions reach, a local module's folder (`source = "./modules/net"`), the paths a
 * `source_dir`, `source_file` or `file()`-family call reads when written from `path.module`, and the images an
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
  /** Paths it reads, relative to its file's folder, each written from `path.module`. */
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
/** Attributes whose values name providers or attributes, never blocks. */
const NOT_REFERENCES = new Set(["provider", "providers", "ignore_changes"]);
/** A block type or name Terraform accepts. */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const named = (n: TsNode): TsNode[] => Array.from({ length: n.namedChildCount ?? 0 }, (_, i) => n.namedChild!(i)!);

interface Visit {
  node: TsNode;
  parent: TsNode | null;
  kids: TsNode[];
  /** Names that enclosing `for` expressions and `%{ for }` directives bind. */
  bound: ReadonlySet<string>;
}

/** The parts of a `for` expression or `%{ for }` directive that name its variables and its collection. */
const INTROS = new Set(["for_intro", "template_for_start"]);

/** The names a `for` expression or `%{ for }` directive binds, or null for any other node. */
function binds(n: TsNode, kids: TsNode[]): string[] | null {
  const intro = n.type === "for_tuple_expr" || n.type === "for_object_expr" ? kids.find((c) => c.type === "for_intro")
    : n.type === "template_for" ? kids.find((c) => c.type === "template_for_start") : null;
  return intro ? named(intro).filter((c) => c.type === "identifier").map((c) => c.text) : null;
}

/** Every node under `n` once, depth first, with its parent; `skip` prunes a subtree. No `parent` lookups: they cost the depth. */
function* walk(n: TsNode, skip: (n: TsNode) => boolean = () => false): Iterable<Visit> {
  const stack: Array<[TsNode, TsNode | null, ReadonlySet<string>]> = [[n, null, new Set()]];
  while (stack.length) {
    const [node, parent, bound] = stack.pop()!;
    const kids = named(node);
    yield { node, parent, kids, bound };
    if (skip(node)) continue;
    const names = binds(node, kids);
    const inner = names ? new Set([...bound, ...names]) : bound;
    // The names are in scope after the intro; its collection expression is read with the outer ones.
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], node, INTROS.has(kids[i].type) ? bound : inner]);
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

const isPathModule = (n: TsNode | undefined) => {
  const t = traversal(n);
  return !!t && !t.indexed && t.names.length === 2 && t.names[0] === "path" && t.names[1] === "module";
};

/** A path written `path.module`, `"${path.module}"` or `"${path.module}/rest"`, as `.` or `rest`; null for any other form. */
function modulePath(n: TsNode | undefined): string | null {
  if (isPathModule(n)) return ".";
  const template = n?.type === "expression" ? named(n)[0] : null;
  const quoted = template?.type === "template_expr" ? named(template)[0] : null;
  const parts = quoted?.type === "quoted_template" ? named(quoted).filter((c) => !c.type.startsWith("quoted_template_")) : [];
  if (parts[0]?.type !== "template_interpolation" || !isPathModule(named(parts[0]).find((c) => c.type === "expression"))) return null;
  if (parts.length === 1) return ".";
  if (parts.length !== 2 || parts[1].type !== "template_literal" || !parts[1].text.startsWith("/")) return null;
  return parts[1].text.slice(1) || ".";
}

/**
 * The names of the traversal starting at `kids[i]`, a `variable_expr` (`aws_iam_role.lambda.arn`), up to its first
 * index or splat, and whether one follows them directly.
 */
function traversalAt(kids: TsNode[], i: number): { names: string[]; indexed: boolean } {
  const names = [named(kids[i])[0]?.text ?? ""];
  for (let j = i + 1; j < kids.length; j++) {
    const k = kids[j];
    if (k.type === "get_attr") names.push(named(k)[0]?.text ?? "");
    else return { names, indexed: k.type === "index" || k.type === "splat" };
  }
  return { names, indexed: false };
}

/** The traversal an expression is, or null. */
function traversal(n: TsNode | undefined): { names: string[]; indexed: boolean } | null {
  const kids = n?.type === "expression" ? named(n) : [];
  return kids[0]?.type === "variable_expr" ? traversalAt(kids, 0) : null;
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
const prune = (n: TsNode) => isDynamic(n) || (n.type === "attribute" && NOT_REFERENCES.has(named(n)[0]?.text ?? ""));

/** A block's labels, quoted or bare; null when one is not a plain name. */
function labelsOf(kids: TsNode[]): string[] | null {
  const labels: string[] = [];
  for (const c of kids.slice(1)) {
    const label = c.type === "string_lit" ? plain(c) : c.type === "identifier" ? c.text : undefined;
    if (label === undefined) continue;
    if (label === null || !NAME.test(label)) return null;
    labels.push(label);
  }
  return labels;
}

function readBlock(block: TsNode): TerraformBlock | string | null {
  const kids = named(block);
  const kind = kids[0]?.type === "identifier" ? kids[0].text : "";
  if (kind !== "resource" && kind !== "data" && kind !== "module") return null;
  const labels = labelsOf(kids);
  let type = "";
  let address: string;
  if (labels && kind !== "module" && labels.length === 2) {
    type = labels[0];
    address = `${kind === "data" ? "data." : ""}${labels[0]}.${labels[1]}`;
  } else if (labels && kind === "module" && labels.length === 1) address = `module.${labels[0]}`;
  else return `a ${kind} block at line ${block.startPosition.row + 1} whose labels are not names is not read`;
  const body = kids.find((c) => c.type === "body");
  const out: TerraformBlock = {
    kind, type, address, lines: [block.startPosition.row + 1, block.endPosition.row + 1],
    addresses: [], paths: [], images: [], counted: false, notes: [],
  };
  const addresses = new Set<string>();
  const notes = new Set<string>();
  if (type === "terraform_remote_state") notes.add(`${address}: another state's outputs are not followed`);
  for (const { node: n, parent, kids: nk, bound } of body ? walk(body, prune) : []) {
    if (isDynamic(n)) {
      notes.add(`${address}: a dynamic block is not read`);
      continue;
    }
    // A traversal starts at a variable_expr, inside an expression or as an operator's operand.
    for (let i = 0; i < nk.length; i++) {
      if (nk[i].type !== "variable_expr") continue;
      const t = traversalAt(nk, i);
      const length = bound.has(t.names[0]) ? 0 : addressLength(t.names);
      if (!length) continue;
      const to = t.names.slice(0, length).join(".");
      if (t.names[0] === "data" && t.names[1] === "terraform_remote_state") notes.add(`${address}: a reference to ${to}, another state's outputs, gives no link`);
      else if (t.names.length === length && t.indexed) notes.add(`${address}: an indexed or splat reference to ${to} gives no link`);
      else if (to !== address) addresses.add(to);
    }
    if (n.type === "attribute" || n.type === "object_elem") {
      const key = n.type === "attribute" ? nk[0]?.text ?? null : keyOf(n);
      const value = nk[1];
      const top = parent === body;
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
    } else if (n.type === "function_call" && PATH_FUNCTIONS.has(nk[0]?.text ?? "")) {
      const args = nk.find((c) => c.type === "function_arguments");
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
  else notes.add(`${out.address}: a path not written from path.module is not followed`);
}

/**
 * A file's blocks and the notes for blocks it cannot read, or the reason the file is not HCL. A grammar that did not
 * load or a parse that failed throws: that is the run's failure, not the file's, so it must not be cached as a skip.
 */
export function readTerraform(source: string): { blocks: TerraformBlock[]; notes: string[] } | { skipped: string } {
  if (!language) throw new Error("the Terraform grammar did not load");
  const root = parseWasm(language, source);
  if (!root) throw new Error("Terraform parse failed");
  if (root.hasError) {
    let bad: TsNode | undefined;
    for (const { node } of walk(root)) {
      if (node.type === "ERROR" || (node as { isMissing?: boolean }).isMissing) {
        bad = node;
        break;
      }
    }
    return { skipped: `not valid HCL${bad ? ` at line ${bad.startPosition.row + 1}` : ""}` };
  }
  const body = named(root).find((c) => c.type === "body");
  const blocks: TerraformBlock[] = [];
  const notes: string[] = [];
  for (const b of body ? named(body) : []) {
    const read = b.type === "block" ? readBlock(b) : null;
    if (typeof read === "string") notes.push(read);
    else if (read) blocks.push(read);
  }
  return { blocks, notes };
}
