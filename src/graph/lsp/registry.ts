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

/** First installed match per language wins; ordering is priority. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

/** Pick servers for all covered languages, each `command` resolved to an absolute path from
 * PATH (util/program.ts), so never one the mapped checkout at `root` holds. Each language is
 * assigned once, and a server shared by several languages is started once. On Windows a `.cmd`
 * counts too: npm installs servers such as typescript-language-server as `.cmd` shims, which
 * spawnSpec runs without a shell (npm's extensionless sh script beside each shim is passed over).
 * `notices` names each server that would have covered a language but is only in a folder trail
 * does not start programs from, with what to do. */
export function pickServers(languagesPresent: Set<string>, root: string): { servers: LspServer[]; notices: string[] } {
  const remaining = new Set(languagesPresent);
  const servers: LspServer[] = [];
  const notices: string[] = [];
  for (const s of LSP_SERVERS) {
    const languages = s.languages.filter((l) => remaining.has(l));
    if (!languages.length) continue;
    const found = locateProgram(s.command, { cmd: true, cwd: root });
    if (!found.path) {
      if (found.skipped) notices.push(`lsp: ${s.command} is only at ${found.skipped}, and trail does not start programs from the checkout and its subfolders or from a node_modules/.bin folder. Install it globally, or anywhere outside the checkout and outside node_modules/.bin, for --lsp to use it.`);
      continue;
    }
    servers.push({ ...s, languages, command: found.path });
    for (const language of languages) remaining.delete(language);
  }
  return { servers, notices };
}
