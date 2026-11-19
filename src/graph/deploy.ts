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

export type DeployFormat = "dockerfile" | "compose" | "kubernetes";

export type DeployRef =
  /** A resource in the same file, by id. */
  | { from: string; to: "id"; id: string }
  /** A `COPY`/`ADD` source, relative to the build context of `dockerfile`. */
  | { from: string; to: "copy"; dockerfile: string; src: string }
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
const DOCKERFILE = /^(dockerfile(\..+)?|.+\.dockerfile|containerfile)$/;

/** The deployment format a path's name says, or null. Every other YAML file is a manifest candidate. */
export function deployFormatOf(path: string): DeployFormat | null {
  const base = posix.basename(path.replace(/\\/g, "/")).toLowerCase();
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

export function extractDeploy(rel: string, source: string, format: DeployFormat): DeployExtract {
  try {
    const out = format === "dockerfile" ? dockerfile(rel, source) : yamlFile(rel, source, format);
    if (!out) return { nodes: [], refs: [] };
    return { nodes: [fileNode(rel, source), ...out.nodes], refs: out.refs };
  } catch (err) {
    if (err instanceof Skip) return { nodes: [], refs: [], skipped: err.message };
    throw err;
  }
}

// ── Dockerfile ──────────────────────────────────────────────────────────────

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
  let heredoc: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (heredoc.length) {
      if (raw.trim() === heredoc[0]) heredoc.shift();
      continue;
    }
    if (/^\s*#/.test(raw)) continue;
    if (!text) start = i + 1;
    const trimmed = raw.replace(/\s+$/, "");
    if (trimmed.endsWith(escape)) {
      text += `${trimmed.slice(0, -escape.length)} `;
      continue;
    }
    text += trimmed;
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(text);
    if (m) {
      out.push({ line: start, op: m[1].toUpperCase(), args: m[2] });
      heredoc = [...m[2].matchAll(/<<-?(["']?)([A-Za-z_][\w-]*)\1/g)].map((h) => h[2]);
    }
    text = "";
  }
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

function dockerfile(rel: string, source: string): { nodes: NodeV1[]; refs: DeployRef[] } {
  const ins = instructions(source);
  const total = source.split("\n").length;
  const froms = ins.filter((i) => i.op === "FROM");
  if (!froms.length) throw new Skip("no FROM instruction");
  const stages: Array<{ id: string; name: string; image: string; start: number; end: number }> = [];
  froms.forEach((f, i) => {
    const w = words(f.args).filter((x) => !x.startsWith("--"));
    if (!w[0] || (w.length > 1 && (w.length !== 3 || w[1].toUpperCase() !== "AS"))) throw new Skip(`line ${f.line}: FROM ${f.args}`);
    const name = w[2] ?? `stage ${i}`;
    stages.push({ id: `stage:${w[2] ?? i}`, name, image: w[0], start: f.line, end: (froms[i + 1]?.line ?? total + 1) - 1 });
  });
  const stageOf = (line: number) => [...stages].reverse().find((s) => s.start <= line);
  const byName = (ref: string) => stages.find((s, i) => s.name.toLowerCase() === ref.toLowerCase() || String(i) === ref);
  const refs: DeployRef[] = [];
  const copied = new Map<string, string[]>();
  for (const i of ins) {
    const s = stageOf(i.line);
    if (!s) continue; // an ARG before the first FROM
    const from = `${rel}#${s.id}`;
    if (i.op === "FROM") {
      const base = byName(s.image);
      if (base && base !== s) refs.push({ from, to: "id", id: `${rel}#${base.id}` });
    } else if (i.op === "COPY" || i.op === "ADD") {
      const w = words(i.args);
      const fromFlag = w.find((x) => x.toLowerCase().startsWith("--from="));
      const plain = w.filter((x) => !x.startsWith("--"));
      if (fromFlag) {
        const base = byName(fromFlag.slice(7));
        if (base) refs.push({ from, to: "id", id: `${rel}#${base.id}` });
        continue;
      }
      for (const src of plain.slice(0, -1)) {
        if (src.startsWith("<<") || /^[a-z][a-z0-9+.-]*:\/\//i.test(src) || src.startsWith("git@")) continue;
        refs.push({ from, to: "copy", dockerfile: rel, src });
        copied.set(s.id, [...(copied.get(s.id) ?? []), src]);
      }
    }
  }
  const nodes = stages.map((s) =>
    resource(rel, s.id, s.name, [s.start, s.end], `FROM ${s.image}${s.name.startsWith("stage ") ? "" : ` AS ${s.name}`}`, [s.name, s.image, ...(copied.get(s.id) ?? [])]),
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

function str(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Skip(`${what} is not a string`);
  return v;
}

function strings(v: unknown, what: string): Record<string, string> {
  const o = obj(v, what);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, String(x)]));
}

function yamlFile(rel: string, source: string, format: "compose" | "kubernetes"): { nodes: NodeV1[]; refs: DeployRef[] } | null {
  const counter = new LineCounter();
  const docs = [...parseAllDocuments(source, { lineCounter: counter, uniqueKeys: false, logLevel: "error" })];
  const bad = docs.find((d) => d.errors.length);
  if (bad) {
    // A Helm or other template is not YAML until rendered; anything else is broken YAML.
    if (source.includes("{{")) throw new Skip("a template, not rendered");
    throw new Skip(`not valid YAML: ${bad.errors[0].message.split("\n")[0]}`);
  }
  const lines = (d: Document, node: unknown): [number, number] => {
    const range = (node as { range?: [number, number, number] } | undefined)?.range ?? d.range ?? [0, 1, 1];
    return [counter.linePos(range[0]).line, counter.linePos(Math.max(range[0], range[1] - 1)).line];
  };
  return format === "compose" ? compose(rel, docs, lines) : kubernetes(rel, docs, lines, source.includes("{{"));
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
    const deps = svc.depends_on;
    const depNames = Array.isArray(deps) ? deps.map((x) => String(x)) : Object.keys(obj(deps, `service ${name}: depends_on`));
    const links = list(svc.links, `service ${name}: links`).map((x) => String(x).split(":")[0]);
    const ext = obj(svc.extends, `service ${name}: extends`);
    const extended = ext.file === undefined ? str(ext.service, `service ${name}: extends.service`) : undefined;
    for (const other of [...depNames, ...links, ...(extended ? [extended] : [])]) {
      if (other in services) refs.push({ from, to: "id", id: `${rel}#service:${other}` });
    }
    for (const v of list(svc.volumes, `service ${name}: volumes`)) {
      const [src, type] = typeof v === "string" ? [v.split(":")[0], undefined] : [str(obj(v, `service ${name}: volume`).source, `service ${name}: volume source`), str((v as Obj).type, `service ${name}: volume type`)];
      if (!src) continue;
      const bind = type === "bind" || (type === undefined && /^[.~/]/.test(src));
      if (bind) {
        const p = under(dir, src);
        if (p !== null) refs.push({ from, to: "mount", path: p });
      } else if (declared.has(`${rel}#volume:${src}`)) refs.push({ from, to: "id", id: `${rel}#volume:${src}` });
    }
    const nets = svc.networks;
    for (const n of Array.isArray(nets) ? nets.map((x) => String(x)) : Object.keys(obj(nets, `service ${name}: networks`))) {
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

function kubernetes(rel: string, docs: Document[], lines: Lines, templated: boolean): { nodes: NodeV1[]; refs: DeployRef[] } | null {
  const manifests = docs.map((d) => [d, js(d)] as const).filter(([, m]) => isManifest(m));
  if (!manifests.length) return null; // a workflow or settings file, not a manifest
  // A Helm or other template can parse as YAML and still say nothing until rendered.
  if (templated) throw new Skip("a template, not rendered");
  const nodes: NodeV1[] = [];
  const refs: DeployRef[] = [];
  for (const [d, raw] of manifests) {
    const m = raw as Obj & { kind: string };
    const meta = obj(m.metadata, `${m.kind}: metadata`);
    const name = str(meta.name, `${m.kind}: metadata.name`);
    if (!name) throw new Skip(`${m.kind} at line ${lines(d, d.contents)[0]} has no metadata.name`);
    const kind = m.kind;
    const ns = str(meta.namespace, `${kind} ${name}: metadata.namespace`) ?? "default";
    const what = `${kind} ${name}`;
    const from = `${rel}#${kind}/${ns}/${name}`;
    const named: string[] = [kind, name, ns];
    const spec = obj(m.spec, `${what}: spec`);
    if (WORKLOADS.has(kind)) {
      const { pod, labels } = podTemplate(kind, spec, meta, what);
      refs.push({ from, to: "labels", ns, labels });
      named.push(...Object.entries(labels).map(([k, v]) => `${k}=${v}`));
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
      named.push(...Object.entries(match).map(([k, v]) => `${k}=${v}`));
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
    nodes.push(resource(rel, `${kind}/${ns}/${name}`, name, lines(d, d.contents), `${kind} ${name} (namespace ${ns})`, named));
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

function globRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${body}(/.*)?$`);
}

/** `references` edges for every deployment ref, against every node in the graph. */
export function resolveDeploy(nodes: NodeV1[], refs: DeployRef[]): EdgeV1[] {
  const ids = new Set(nodes.map((n) => n.id));
  const files = nodes.filter((n) => n.kind === "file" && n.origin !== "deploy").map((n) => n.path);
  const contexts = new Map<string, Set<string>>();
  const objects = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.kind !== "resource") continue;
    const m = /#([A-Za-z]+)\/([^/]+)\/(.+)$/.exec(n.id);
    if (m) objects.set(`${m[1]}/${m[2]}/${m[3]}`, [...(objects.get(`${m[1]}/${m[2]}/${m[3]}`) ?? []), n.id]);
  }
  // A Dockerfile's build context is each compose context that builds it, else its own folder.
  for (const r of refs) if (r.to === "build") contexts.set(r.dockerfile, (contexts.get(r.dockerfile) ?? new Set()).add(r.context));
  for (const r of refs) if (r.to === "copy" && !contexts.has(r.dockerfile)) contexts.set(r.dockerfile, new Set([posix.dirname(r.dockerfile)]));
  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, confidence: EdgeV1["confidence"] = "extracted") => {
    const key = `${source}\0${target}`;
    if (source === target || seen.has(key) || !ids.has(target)) return;
    seen.add(key);
    out.push({ source, target, relation: "references", confidence });
  };
  const filesUnder = (p: string) => (p === "." ? files : files.filter((f) => f === p || f.startsWith(`${p}/`)));
  const labels = refs.filter((r): r is Extract<DeployRef, { to: "labels" }> => r.to === "labels");
  const builtImages = refs.filter((r): r is Extract<DeployRef, { to: "image" }> => r.to === "image" && r.built);
  for (const r of refs) {
    if (r.to === "id") add(r.from, r.id);
    else if (r.to === "copy") {
      for (const ctx of contexts.get(r.dockerfile) ?? []) {
        const src = under(ctx, r.src);
        if (src === null) continue;
        const hits = /[*?[]/.test(src) ? files.filter((f) => globRegex(src).test(f)) : filesUnder(src);
        for (const f of hits) add(r.from, f);
      }
    } else if (r.to === "build") {
      const stages = nodes.filter((n) => n.kind === "resource" && n.path === r.dockerfile);
      const stage = r.target ? stages.find((s) => s.name === r.target) : stages.at(-1);
      if (stage) add(r.from, stage.id);
    } else if (r.to === "mount") for (const f of filesUnder(r.path)) add(r.from, f);
    else if (r.to === "object") for (const id of objects.get(`${r.kind}/${r.ns}/${r.name}`) ?? []) add(r.from, id);
    else if (r.to === "selector") {
      for (const l of labels) if (l.ns === r.ns && Object.entries(r.match).every(([k, v]) => l.labels[k] === v)) add(r.from, l.from);
    } else if (r.to === "image" && !r.built) {
      for (const b of builtImages) if (imageRepo(b.image) === imageRepo(r.image)) add(r.from, b.from, "inferred");
    }
  }
  return out;
}
