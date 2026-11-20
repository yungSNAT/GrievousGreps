/**
 * Dockerfiles, compose files and Kubernetes manifests as graph nodes.
 *
 * Each file gives `resource` nodes (a Dockerfile stage; a compose service, volume or
 * network; a manifest) and {@link DeployRef}s, which {@link resolveDeploy} turns into
 * `references` edges once every file is read: a stage to the stages it builds on and
 * the source files it copies, a compose service to what it builds, depends on and
 * mounts, a workload to the config it names, a Service to the workloads its selector
 * picks, an Ingress to its Services, and a workload to the compose service that builds
 * its image (`inferred`: a name match). Only names are kept: no environment value and
 * no ConfigMap or Secret data reaches a node. A file that does not parse, or a field of
 * the wrong type, skips the whole file with a reason; nothing is guessed.
 */
import { posix } from "node:path";
import { LineCounter, parseAllDocuments, type Document } from "yaml";
import type { EdgeV1, NodeV1 } from "./types.js";
import { contentHash } from "../util/id.js";
import { compileGlob, filesUnder, globMatches, type GlobSegment } from "./deploy-glob.js";

export type DeployFormat = "dockerfile" | "compose" | "kubernetes";

export type DeployRef =
  /** A resource in the same file, by id. */
  | { from: string; to: "id"; id: string }
  /** A `COPY`/`ADD` source, relative to the build context of `dockerfile`. */
  | { from: string; to: "copy"; dockerfile: string; src: string; inferred?: true }
  /** A compose build: the Dockerfile at `dockerfile` (repo-relative) with context `context`. */
  | { from: string; to: "build"; context: string; dockerfile: string; target?: string }
  /** A bind-mounted host path, repo-relative. */
  | { from: string; to: "mount"; path: string }
  /** A Kubernetes object by kind, namespace and name. */
  | { from: string; to: "object"; kind: string; ns: string; name: string }
  /** A Service's selector, and the pod labels a workload gives. */
  | { from: string; to: "selector"; ns: string; match: Record<string, string> }
  | { from: string; to: "labels"; ns: string; labels: Record<string, string> }
  /** An image a workload runs (`built: false`) or a compose service builds (`built: true`). */
  | { from: string; to: "image"; image: string; built: boolean };

export interface DeployExtract {
  nodes: NodeV1[];
  refs: DeployRef[];
  /** Why the file was skipped; its nodes and refs are then empty. */
  skipped?: string;
}

const COMPOSE = /^(docker-)?compose(\.[^/]+)?\.ya?ml$/;
const DOCKERFILE = /^(dockerfile([._-].+)?|.+\.dockerfile|containerfile)$/;
const MAX_FILE_CANDIDATES = 50_000;

/** The deployment format a path's name says, or null. Every other YAML file is a manifest candidate. */
export function deployFormatOf(path: string): DeployFormat | null {
  const base = posix.basename(path.replace(/\\/g, "/")).toLowerCase();
  if (base.endsWith(".dockerignore")) return null;
  if (DOCKERFILE.test(base)) return "dockerfile";
  if (COMPOSE.test(base)) return "compose";
  return /\.ya?ml$/.test(base) ? "kubernetes" : null;
}

class Skip extends Error {}

function fileNode(rel: string, source: string): NodeV1 {
  return {
    id: rel, name: posix.basename(rel), kind: "file", path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`, signature: null,
    exported: true, origin: "deploy", body_hash: contentHash(source),
    chars: Buffer.byteLength(source), summary_state: "pending", summary: null, crux: null,
  };
}

function resource(rel: string, id: string, name: string, lines: [number, number], signature: string, words: string[]): NodeV1 {
  return {
    id: `${rel}#${id}`, name, kind: "resource", path: rel, span: `L${lines[0]}-L${lines[1]}`,
    signature, exported: true, origin: "deploy", body_hash: contentHash(`${signature}\n${words.join(" ")}`),
    body_text: words.join(" "), summary_state: "pending", summary: null, crux: null,
  };
}

/** A skip reason as printed and cached: control characters removed, at most 120 characters. */
function reasonText(message: string): string {
  const text = message.replace(/\p{Cc}/gu, " ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function extractDeploy(rel: string, source: string, format: DeployFormat): DeployExtract {
  try {
    const out = format === "dockerfile" ? dockerfile(rel, source) : yamlFile(rel, source, format);
    if (!out) return { nodes: [], refs: [] };
    return { nodes: [fileNode(rel, source), ...out.nodes], refs: out.refs };
  } catch (err) {
    if (!(err instanceof Skip)) throw err;
    // A Helm or other template is not YAML until rendered: say so beside whatever failed.
    const templated = format !== "dockerfile" && source.includes("{{") && !err.message.includes("template");
    return { nodes: [], refs: [], skipped: reasonText(templated ? `${err.message} in a file holding {{ }} templates` : err.message) };
  }
}

// ── Dockerfile ──────────────────────────────────────────────────────────────

/** A heredoc opener (`<<EOF`, `<<-"EOF"`) at the start of a word of a RUN, COPY or ADD. */
const HEREDOC = /(?:^|\s)<<(-?)(["']?)([A-Za-z_][\w-]*)\2/g;
const HEREDOC_OPS = new Set(["RUN", "COPY", "ADD"]);

/** Instructions with their first line, continuations joined, comments and heredoc bodies dropped. */
function instructions(source: string): Array<{ line: number; op: string; args: string }> {
  const lines = source.split(/\r?\n/);
  let escape = "\\";
  for (const l of lines) {
    const d = /^#\s*([a-z]+)\s*=\s*(\S+)\s*$/i.exec(l);
    if (!d) break;
    if (d[1].toLowerCase() === "escape") escape = d[2];
  }
  const out: Array<{ line: number; op: string; args: string }> = [];
  let text = "";
  let start = 0;
  let heredoc: Array<{ name: string; stripTabs: boolean }> = [];
  let pending = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (pending < heredoc.length) {
      const { name, stripTabs } = heredoc[pending];
      if ((stripTabs ? raw.replace(/^\t+/, "") : raw) === name) pending++;
      continue;
    }
    if (/^\s*#/.test(raw)) continue;
    if (!text) start = i + 1;
    const trimmed = raw.trimEnd();
    if (trimmed.endsWith(escape)) {
      text += `${trimmed.slice(0, -escape.length)} `;
      continue;
    }
    text += trimmed;
    const instruction = text.trimStart();
    const opcode = /^[A-Za-z]+/.exec(instruction)?.[0];
    if (opcode) {
      const op = opcode.toUpperCase();
      const args = instruction.slice(opcode.length).trimStart();
      out.push({ line: start, op, args });
      if (HEREDOC_OPS.has(op)) {
        heredoc = [...args.matchAll(HEREDOC)].map((h) => ({ name: h[3], stripTabs: h[1] === "-" }));
        pending = 0;
      }
    }
    text = "";
  }
  if (pending < heredoc.length) throw new Skip(`unterminated heredoc ${heredoc[pending].name}`);
  return out;
}

/** An instruction's words: the JSON form, else whitespace-separated with quotes removed. */
function words(args: string): string[] {
  if (args.trim().startsWith("[")) {
    try {
      const v = JSON.parse(args);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    } catch {
      // not the JSON form after all: read it as words
    }
  }
  return (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
}

/** Docker's rule for a stage name (`FROM image AS name`), case-insensitive. */
const STAGE_NAME = /^[a-z][a-z0-9._-]*$/i;

function dockerfile(rel: string, source: string): { nodes: NodeV1[]; refs: DeployRef[] } {
  const ins = instructions(source);
  const total = source.split("\n").length;
  if (!ins.some((i) => i.op === "FROM")) throw new Skip("no FROM instruction");
  type CopyRef = Extract<DeployRef, { to: "copy" }>;
  type Stage = { id: string; name: string; image: string; start: number; end: number; copied: Map<string, CopyRef> };
  const stages: Stage[] = [];
  /** Stages built so far, by lowercased name and by index: a stage refers only to earlier ones. */
  const byName = new Map<string, Stage>();
  const refs: DeployRef[] = [];
  let s: Stage | undefined;
  for (const i of ins) {
    if (i.op === "FROM") {
      const w = words(i.args).filter((x) => !x.startsWith("--"));
      if (!w[0] || (w.length > 1 && (w.length !== 3 || w[1].toUpperCase() !== "AS"))) throw new Skip(`line ${i.line}: FROM ${i.args}`);
      const alias = w[2];
      if (alias !== undefined && !STAGE_NAME.test(alias)) throw new Skip(`line ${i.line}: stage name ${alias} is not valid`);
      if (alias !== undefined && byName.has(alias.toLowerCase())) throw new Skip(`line ${i.line}: duplicate stage ${alias}`);
      const index = stages.length;
      const base = byName.get(w[0].toLowerCase());
      if (s) s.end = i.line - 1;
      s = { id: `stage:${alias ?? index}`, name: alias ?? `stage ${index}`, image: w[0], start: i.line, end: total, copied: new Map() };
      stages.push(s);
      if (base) refs.push({ from: `${rel}#${s.id}`, to: "id", id: `${rel}#${base.id}` });
      if (alias !== undefined) byName.set(alias.toLowerCase(), s);
    } else if (s && (i.op === "COPY" || i.op === "ADD")) {
      const from = `${rel}#${s.id}`;
      let operands = i.args;
      let fromFlag: string | undefined;
      let inferred = false;
      while (operands.startsWith("--")) {
        const space = operands.search(/\s/);
        if (space <= 2) break;
        const flag = operands.slice(0, space);
        if (flag.toLowerCase().startsWith("--from=")) fromFlag ??= flag;
        if (flag.toLowerCase().startsWith("--exclude=")) inferred = true;
        operands = operands.slice(space).trimStart();
      }
      if (fromFlag) {
        const ref = fromFlag.slice(7).toLowerCase();
        const base = byName.get(ref) ?? (/^\d+$/.test(ref) ? stages[Number(ref)] : undefined);
        if (base && base !== s) refs.push({ from, to: "id", id: `${rel}#${base.id}` });
        continue;
      }
      for (const raw of words(operands).slice(0, -1)) {
        if (raw.startsWith("<<") || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("git@")) continue;
        const src = posix.normalize("/" + raw).slice(1).replace(/\/$/, "") || ".";
        const earlier = s.copied.get(src);
        if (earlier) {
          if (!inferred) delete earlier.inferred;
          continue;
        }
        if (!compileGlob(src)) throw new Skip(`line ${i.line}: ${i.op} source ${src} is not a valid pattern`);
        const ref: CopyRef = { from, to: "copy", dockerfile: rel, src, ...(inferred ? { inferred: true } : {}) };
        refs.push(ref);
        s.copied.set(src, ref);
      }
    }
    // Anything before the first FROM (an ARG) belongs to no stage.
  }
  const nodes = stages.map((st) =>
    resource(rel, st.id, st.name, [st.start, st.end], `FROM ${st.image}${st.name.startsWith("stage ") ? "" : ` AS ${st.name}`}`, [st.name, st.image, ...st.copied.keys()]),
  );
  return { nodes, refs };
}

// ── YAML: compose and Kubernetes ────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new Skip(`${what} is not a mapping`);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Skip(`${what} is not a list`);
  return v;
}

/** A string field the graph reads; one holding `{{` is an unrendered template, not a name. */
function str(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Skip(`${what} is not a string`);
  if (v.includes("{{")) throw new Skip(`${what} is a template, not rendered`);
  return v;
}

function strict(v: unknown, what: string): string {
  const s = str(v, what);
  if (s === undefined) throw new Skip(`${what} is not a string`);
  return s;
}

function strings(v: unknown, what: string): Record<string, string> {
  return Object.fromEntries(Object.entries(obj(v, what)).map(([k, x]) => [k, strict(x, `${what} ${k}`)]));
}

function yamlFile(rel: string, source: string, format: "compose" | "kubernetes"): { nodes: NodeV1[]; refs: DeployRef[] } | null {
  // A manifest has `apiVersion` and `kind` at the top level; a lockfile, CI or settings file
  // has not, so it is never parsed and never reported. (The repository walk already leaves
  // out every file above `MAX_FILE_BYTES`, so no file parsed here is larger.)
  if (format === "kubernetes" && !(/^apiVersion:/m.test(source) && /^kind:/m.test(source))) return null;
  const counter = new LineCounter();
  const docs = [...parseAllDocuments(source, { lineCounter: counter, uniqueKeys: false, logLevel: "error", merge: format === "compose" })];
  const bad = docs.find((d) => d.errors.length);
  if (bad) throw new Skip(`not valid YAML: ${bad.errors[0].message.split("\n")[0]}`);
  const lines = (d: Document, node: unknown): [number, number] => {
    const range = (node as { range?: [number, number, number] } | undefined)?.range ?? d.range ?? [0, 1, 1];
    return [counter.linePos(range[0]).line, counter.linePos(Math.max(range[0], range[1] - 1)).line];
  };
  return format === "compose" ? compose(rel, docs, lines) : kubernetes(rel, docs, lines);
}

/** A document's value; too many aliases (a 'billion laughs' file) is a skip, not a crash. */
function js(d: Document | undefined): unknown {
  try {
    return d?.toJS();
  } catch (err) {
    throw new Skip(`not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Lines = (d: Document, node: unknown) => [number, number];

/** A path a compose file names, repo-relative; null for one outside the repository or remote. */
function under(dir: string, p: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith("git@") || posix.isAbsolute(p)) return null;
  const joined = posix.normalize(posix.join(dir, p));
  return joined.startsWith("../") || joined === ".." ? null : joined.replace(/\/$/, "") || ".";
}

function compose(rel: string, docs: Document[], lines: Lines): { nodes: NodeV1[]; refs: DeployRef[] } {
  const d = docs[0];
  const top = obj(js(d), "the file");
  const services = obj(top.services, "services");
  if (!Object.keys(services).length) throw new Skip("no services");
  const dir = posix.dirname(rel);
  const nodes: NodeV1[] = [];
  const refs: DeployRef[] = [];
  const at = (path: string[]) => d.getIn(path, true);
  for (const kind of ["volumes", "networks"] as const) {
    for (const name of Object.keys(obj(top[kind], kind))) {
      const one = kind === "volumes" ? "volume" : "network";
      nodes.push(resource(rel, `${one}:${name}`, name, lines(d, at([kind, name])), `compose ${one} ${name}`, [name]));
    }
  }
  const declared = new Set(nodes.map((n) => n.id));
  for (const [name, raw] of Object.entries(services)) {
    const svc = obj(raw, `service ${name}`);
    const from = `${rel}#service:${name}`;
    const image = str(svc.image, `service ${name}: image`);
    const named: string[] = [name, ...(image ? [image] : [])];
    const build = svc.build;
    if (build !== undefined && build !== null) {
      const b = typeof build === "string" ? { context: build } : obj(build, `service ${name}: build`);
      const ctx = under(dir, str(b.context, `service ${name}: build.context`) ?? ".");
      const file = str(b.dockerfile, `service ${name}: build.dockerfile`) ?? "Dockerfile";
      const target = str(b.target, `service ${name}: build.target`);
      if (ctx !== null) {
        const df = under(ctx, file);
        if (df !== null) refs.push({ from, to: "build", context: ctx, dockerfile: df, ...(target ? { target } : {}) });
      }
    }
    if (image) refs.push({ from, to: "image", image, built: build !== undefined && build !== null });
    /** A list of names, or a mapping keyed by them (compose allows both). */
    const names = (v: unknown, field: string) =>
      Array.isArray(v) ? v.map((x) => strict(x, `service ${name}: ${field} entry`)) : Object.keys(obj(v, `service ${name}: ${field}`));
    const links = list(svc.links, `service ${name}: links`).map((x) => strict(x, `service ${name}: links entry`).split(":")[0]);
    const ext = obj(svc.extends, `service ${name}: extends`);
    const extended = ext.file === undefined ? str(ext.service, `service ${name}: extends.service`) : undefined;
    for (const other of [...names(svc.depends_on, "depends_on"), ...links, ...(extended ? [extended] : [])]) {
      if (Object.hasOwn(services, other)) refs.push({ from, to: "id", id: `${rel}#service:${other}` });
    }
    for (const v of list(svc.volumes, `service ${name}: volumes`)) {
      if (typeof v !== "string" && !isObj(v)) throw new Skip(`service ${name}: volume is not a string or mapping`);
      const [src, type] = typeof v === "string" ? [v.split(":")[0], undefined]
        : [str(v.source, `service ${name}: volume source`), str(v.type, `service ${name}: volume type`)];
      if (!src) continue;
      const bind = type === "bind" || (type === undefined && /^[.~/]/.test(src));
      if (bind) {
        const p = under(dir, src);
        if (p !== null) refs.push({ from, to: "mount", path: p });
      } else if (declared.has(`${rel}#volume:${src}`)) refs.push({ from, to: "id", id: `${rel}#volume:${src}` });
    }
    for (const n of names(svc.networks, "networks")) {
      if (declared.has(`${rel}#network:${n}`)) refs.push({ from, to: "id", id: `${rel}#network:${n}` });
    }
    nodes.push(resource(rel, `service:${name}`, name, lines(d, at(["services", name])), `compose service ${name}${image ? ` (image ${image})` : ""}`, named));
  }
  return { nodes, refs };
}

const WORKLOADS = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);

/** A workload's pod spec and the labels its pods get. */
function podTemplate(kind: string, spec: Obj, meta: Obj, what: string): { pod: Obj; labels: Record<string, string> } {
  if (kind === "Pod") return { pod: spec, labels: strings(meta.labels, `${what}: metadata.labels`) };
  const jobSpec = kind === "CronJob" ? obj(obj(spec.jobTemplate, `${what}: jobTemplate`).spec, `${what}: jobTemplate.spec`) : spec;
  const template = obj(jobSpec.template, `${what}: template`);
  return { pod: obj(template.spec, `${what}: template.spec`), labels: strings(obj(template.metadata, `${what}: template.metadata`).labels, `${what}: labels`) };
}

const isManifest = (m: unknown): m is Obj & { kind: string } => isObj(m) && typeof m.apiVersion === "string" && typeof m.kind === "string";

function kubernetes(rel: string, docs: Document[], lines: Lines): { nodes: NodeV1[]; refs: DeployRef[] } | null {
  const manifests = docs.map((d) => [d, js(d)] as const).filter(([, m]) => isManifest(m));
  if (!manifests.length) return null; // a workflow or settings file, not a manifest
  const nodes: NodeV1[] = [];
  const refs: DeployRef[] = [];
  const seen = new Set<string>();
  for (const [d, raw] of manifests) {
    const m = raw as Obj & { kind: string };
    const meta = obj(m.metadata, `${m.kind}: metadata`);
    const name = str(meta.name, `${m.kind}: metadata.name`);
    if (!name) throw new Skip(`${m.kind} at line ${lines(d, d.contents)[0]} has no metadata.name`);
    const kind = m.kind;
    const ns = str(meta.namespace, `${kind} ${name}: metadata.namespace`) ?? "default";
    const what = `${kind} ${name}`;
    const key = `${kind}/${ns}/${name}`;
    if (seen.has(key)) throw new Skip(`duplicate ${kind} ${ns}/${name}`);
    seen.add(key);
    const from = `${rel}#${key}`;
    const named: string[] = [kind, name, ns];
    const spec = obj(m.spec, `${what}: spec`);
    if (WORKLOADS.has(kind)) {
      const { pod, labels } = podTemplate(kind, spec, meta, what);
      refs.push({ from, to: "labels", ns, labels });
      for (const [key, value] of Object.entries(labels)) named.push(`${key}=${value}`);
      const object = (k: string, n: unknown, field: string) => {
        const v = str(n, `${what}: ${field}`);
        if (v) refs.push({ from, to: "object", kind: k, ns, name: v });
      };
      object("ServiceAccount", pod.serviceAccountName, "serviceAccountName");
      for (const s of list(pod.imagePullSecrets, `${what}: imagePullSecrets`)) object("Secret", obj(s, `${what}: imagePullSecrets`).name, "imagePullSecrets.name");
      for (const c of [...list(pod.containers, `${what}: containers`), ...list(pod.initContainers, `${what}: initContainers`)]) {
        const ct = obj(c, `${what}: container`);
        const image = str(ct.image, `${what}: container image`);
        if (image) {
          refs.push({ from, to: "image", image, built: false });
          named.push(image);
        }
        for (const e of list(ct.envFrom, `${what}: envFrom`)) {
          const ef = obj(e, `${what}: envFrom`);
          object("ConfigMap", obj(ef.configMapRef, `${what}: envFrom.configMapRef`).name, "envFrom.configMapRef.name");
          object("Secret", obj(ef.secretRef, `${what}: envFrom.secretRef`).name, "envFrom.secretRef.name");
        }
        for (const e of list(ct.env, `${what}: env`)) {
          const vf = obj(obj(e, `${what}: env`).valueFrom, `${what}: env.valueFrom`);
          object("ConfigMap", obj(vf.configMapKeyRef, `${what}: configMapKeyRef`).name, "configMapKeyRef.name");
          object("Secret", obj(vf.secretKeyRef, `${what}: secretKeyRef`).name, "secretKeyRef.name");
        }
      }
      for (const v of list(pod.volumes, `${what}: volumes`)) {
        const vol = obj(v, `${what}: volume`);
        object("ConfigMap", obj(vol.configMap, `${what}: volume configMap`).name, "volume configMap.name");
        object("Secret", obj(vol.secret, `${what}: volume secret`).secretName, "volume secret.secretName");
        object("PersistentVolumeClaim", obj(vol.persistentVolumeClaim, `${what}: volume claim`).claimName, "volume claimName");
        for (const p of list(obj(vol.projected, `${what}: projected`).sources, `${what}: projected.sources`)) {
          const ps = obj(p, `${what}: projected source`);
          object("ConfigMap", obj(ps.configMap, `${what}: projected configMap`).name, "projected configMap.name");
          object("Secret", obj(ps.secret, `${what}: projected secret`).name, "projected secret.name");
        }
      }
    } else if (kind === "Service") {
      const match = strings(spec.selector, `${what}: selector`);
      if (Object.keys(match).length) refs.push({ from, to: "selector", ns, match });
      for (const [key, value] of Object.entries(match)) named.push(`${key}=${value}`);
    } else if (kind === "Ingress") {
      const backend = (b: unknown, field: string) => {
        const be = obj(b, `${what}: ${field}`);
        const svc = str(obj(be.service, `${what}: ${field}.service`).name, `${what}: ${field}.service.name`) ?? str(be.serviceName, `${what}: ${field}.serviceName`);
        if (svc) {
          refs.push({ from, to: "object", kind: "Service", ns, name: svc });
          named.push(svc);
        }
      };
      backend(spec.defaultBackend ?? spec.backend, "defaultBackend");
      for (const r of list(spec.rules, `${what}: rules`)) {
        const rule = obj(r, `${what}: rule`);
        if (typeof rule.host === "string") named.push(rule.host);
        for (const p of list(obj(rule.http, `${what}: rule.http`).paths, `${what}: paths`)) {
          const path = obj(p, `${what}: path`);
          if (typeof path.path === "string") named.push(path.path);
          backend(path.backend, "path backend");
        }
      }
    }
    nodes.push(resource(rel, key, name, lines(d, d.contents), `${kind} ${name} (namespace ${ns})`, named));
  }
  return { nodes, refs };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** An image name without registry `docker.io`, `library/`, tag or digest. */
function imageRepo(image: string): string {
  let s = image.split("@")[0];
  const slash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  if (colon > slash) s = s.slice(0, colon);
  return s.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Resolve deployment references, bounding source-file expansions per deployment file. */
export function resolveDeploy(nodes: NodeV1[], refs: DeployRef[], fileExists: (path: string) => boolean): {
  edges: EdgeV1[];
  skipped: { path: string; reason: string }[];
} {
  const pathsById = new Map(nodes.map((n) => [n.id, n.path]));
  // Descendant lookups depend on binary ordering, so use the same ordering as lower().
  const files = nodes.filter((n) => n.kind === "file" && n.origin !== "deploy").map((n) => n.path)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const fileSet = new Set(files);
  const objects = new Map<string, string[]>();
  const stagesOf = new Map<string, NodeV1[]>();
  for (const n of nodes) {
    if (n.kind !== "resource") continue;
    // The id after the file's own path: `stage:build`, `service:api`, `Deployment/ns/api`.
    const local = n.id.slice(n.path.length + 1);
    if (local.startsWith("stage:")) pushTo(stagesOf, n.path, n);
    else if (/^[A-Za-z]+\/[^/]+\/./.test(local)) pushTo(objects, local, n.id);
  }
  // A Dockerfile's build context is each compose context that builds it, else its own folder.
  const contexts = new Map<string, Set<string>>();
  for (const r of refs) if (r.to === "build") contexts.set(r.dockerfile, (contexts.get(r.dockerfile) ?? new Set()).add(r.context));
  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, confidence: EdgeV1["confidence"] = "extracted") => {
    const key = `${source}\0${target}`;
    if (source === target || seen.has(key) || !pathsById.has(target)) return;
    seen.add(key);
    out.push({ source, target, relation: "references", confidence });
  };
  const expansions = new Map<string, { examined: number; edges: Map<string, EdgeV1> }>();
  const skipped: { path: string; reason: string }[] = [];
  const expand = (path: string, from: string, prefix: string, glob?: GlobSegment[], confidence: EdgeV1["confidence"] = "extracted") => {
    let expansion = expansions.get(path);
    if (!expansion) {
      expansion = { examined: 0, edges: new Map() };
      expansions.set(path, expansion);
    }
    if (expansion.examined > MAX_FILE_CANDIDATES) return;
    for (const file of filesUnder(files, fileSet, prefix)) {
      if (++expansion.examined > MAX_FILE_CANDIDATES) {
        expansion.edges.clear();
        skipped.push({ path, reason: `COPY and bind-mount links omitted after ${MAX_FILE_CANDIDATES} file candidates` });
        break;
      }
      if (glob && !globMatches(glob, file)) continue;
      const key = `${from}\0${file}`;
      const earlier = expansion.edges.get(key);
      if (!earlier) expansion.edges.set(key, { source: from, target: file, relation: "references", confidence });
      else if (confidence === "extracted") earlier.confidence = confidence;
    }
  };
  const addObjectLinks = (from: string, targets: string[]) => {
    const directory = posix.dirname(pathsById.get(from)!);
    const sameFolder = targets.filter((target) => posix.dirname(pathsById.get(target)!) === directory);
    for (const target of sameFolder) add(from, target);
    if (!sameFolder.length) {
      for (const target of targets) add(from, target, "inferred");
    }
  };
  const labels = new Map<string, Array<Extract<DeployRef, { to: "labels" }>>>();
  const built = new Map<string, string[]>();
  const ignores = new Map<string, boolean>();
  const hasIgnore = (path: string) => {
    if (!ignores.has(path)) ignores.set(path, fileExists(path));
    return ignores.get(path);
  };
  for (const r of refs) {
    if (r.to === "labels") pushTo(labels, r.ns, r);
    else if (r.to === "image" && r.built) pushTo(built, imageRepo(r.image), r.from);
  }
  for (const r of refs) {
    if (r.to === "id") add(r.from, r.id);
    else if (r.to === "copy") {
      const declared = contexts.get(r.dockerfile);
      for (const ctx of declared ?? [posix.dirname(r.dockerfile)]) {
        // Docker reads COPY sources inside the build context only.
        const src = under(ctx, r.src);
        if (src === null || !(ctx === "." || src === ctx || src.startsWith(`${ctx}/`))) continue;
        const approximate = r.inferred || !declared || declared.size > 1
          || hasIgnore(`${r.dockerfile}.dockerignore`) || hasIgnore(posix.join(ctx, ".dockerignore"));
        const confidence = approximate ? "inferred" : "extracted";
        const glob = /[*?[]/.test(src) ? compileGlob(src) : null;
        if (!glob) {
          expand(r.dockerfile, r.from, src, undefined, confidence);
          continue;
        }
        // Only files under the glob's leading literal folders can match it.
        const parts = src.split("/");
        const literal = parts.slice(0, parts.findIndex((p) => /[*?[]/.test(p))).join("/") || ".";
        expand(r.dockerfile, r.from, literal, glob, confidence);
      }
    } else if (r.to === "build") {
      const stages = stagesOf.get(r.dockerfile) ?? [];
      const target = r.target?.toLowerCase();
      const stage = target ? stages.find((s) => s.name.toLowerCase() === target) : stages.at(-1);
      if (stage) add(r.from, stage.id);
    } else if (r.to === "mount") expand(pathsById.get(r.from)!, r.from, r.path);
    else if (r.to === "object") addObjectLinks(r.from, objects.get(`${r.kind}/${r.ns}/${r.name}`) ?? []);
    else if (r.to === "selector") {
      const match = Object.entries(r.match);
      addObjectLinks(r.from, (labels.get(r.ns) ?? []).filter((l) => match.every(([k, v]) => l.labels[k] === v)).map((l) => l.from));
    } else if (r.to === "image" && !r.built) {
      for (const b of built.get(imageRepo(r.image)) ?? []) add(r.from, b, "inferred");
    }
  }
  for (const expansion of expansions.values()) {
    for (const edge of expansion.edges.values()) out.push(edge);
  }
  return { edges: out, skipped };
}
