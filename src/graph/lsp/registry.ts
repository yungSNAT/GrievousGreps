/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { findProgram } from "../../util/program.js";

export interface LspServer {
  /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
  languages: string[];
  command: string;
  args: string[];
  /** the LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** First-match-wins; ordering is priority. Extend by adding a row. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

const resolved = new Map<string, string | null>();
/** A server's absolute path from PATH's absolute folders (util/program.ts), so never one the
 * mapped checkout holds. On Windows a `.cmd` counts too: npm installs servers such as
 * typescript-language-server as `.cmd` shims, which spawnSpec runs without a shell. npm's
 * extensionless sh script beside each shim is passed over, as Windows can't run it. */
function resolveCommand(cmd: string): string | null {
  if (!resolved.has(cmd)) resolved.set(cmd, findProgram(cmd, { cmd: true }));
  return resolved.get(cmd)!;
}

/** Pick the highest-priority installed server that covers at least one of the
 * languages present in the repo, with `command` resolved to an absolute path.
 * Returns null if none is installed. */
export function pickServer(languagesPresent: Set<string>): LspServer | null {
  for (const s of LSP_SERVERS) {
    if (!s.languages.some((l) => languagesPresent.has(l))) continue;
    const abs = resolveCommand(s.command);
    if (abs) return { ...s, command: abs };
  }
  return null;
}
