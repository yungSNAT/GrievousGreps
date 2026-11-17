/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { locateProgram } from "../../util/program.js";

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

/** Pick the highest-priority server on PATH that covers at least one of the languages present in
 * the repository at `root`, with `command` resolved to an absolute path (util/program.ts), so
 * never one the mapped checkout holds; null if none is installed. On Windows a `.cmd` counts too:
 * npm installs servers such as typescript-language-server as `.cmd` shims, which spawnSpec runs
 * without a shell (npm's extensionless sh script beside each shim is passed over). `notices` names
 * each server ahead of the one picked that is only in a folder trail does not start programs from. */
export function pickServer(languagesPresent: Set<string>, root: string): { server: LspServer | null; notices: string[] } {
  const notices: string[] = [];
  for (const s of LSP_SERVERS) {
    if (!s.languages.some((l) => languagesPresent.has(l))) continue;
    const found = locateProgram(s.command, { cmd: true, cwd: root });
    if (found.path) return { server: { ...s, command: found.path }, notices };
    if (found.skipped) notices.push(`lsp: ${s.command} is only at ${found.skipped}, and trail does not start programs from the checkout and its subfolders or from a node_modules/.bin folder. Install it globally, or anywhere outside the checkout and outside node_modules/.bin, for --lsp to use it.`);
  }
  return { server: null, notices };
}
