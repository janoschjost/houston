import { api, type ShellInfo } from "./api";
import { COMMAND_PREFIXES, lex, type Token } from "./lexer";

export type ItemKind = "cmd" | "dir" | "file" | "git" | "sub" | "script" | "hist";

export interface Item {
  insert: string;
  label: string;
  kind: ItemKind;
  /** Don't append a space after inserting (directories keep completing). */
  open?: boolean;
}

export interface Completion {
  start: number;
  end: number;
  items: Item[];
}

const GIT_SUBCOMMANDS = [
  "add", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "diff",
  "fetch", "grep", "init", "log", "merge", "mv", "pull", "push", "rebase", "reflog", "remote", "reset",
  "restore", "revert", "rm", "show", "stash", "status", "switch", "tag", "worktree",
];
const GIT_REF_SUBCOMMANDS = new Set(["checkout", "switch", "merge", "rebase", "branch", "diff", "log", "reset", "cherry-pick", "show", "push", "pull", "revert"]);
const DIR_COMMANDS = new Set(["cd", "pushd", "z"]);

/** Shared by every shell session: known commands, history, and completion lookups. */
export class Completer {
  private commands: string[] = [];
  private commandSet = new Set<string>();
  private history: string[] = [];

  load(info: ShellInfo) {
    this.commands = [...info.commands].sort((a, b) => a.length - b.length || a.localeCompare(b));
    this.commandSet = new Set(info.commands);
    this.history = info.history;
  }

  isCommand = (word: string): boolean | undefined => {
    if (!this.commandSet.size) return undefined;
    return this.commandSet.has(word) || word.includes("/") || word.startsWith("$");
  };

  lex(text: string): Token[] {
    return lex(text, this.isCommand);
  }

  record(cmd: string) {
    const i = this.history.lastIndexOf(cmd);
    if (i >= 0) this.history.splice(i, 1);
    this.history.push(cmd);
  }

  /** Inline suggestion: the rest of the most recent single-line history entry starting with `text`. */
  ghost(text: string): string {
    if (!text.trim() || text.includes("\n")) return "";
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.length > text.length && h.startsWith(text) && !h.includes("\n")) return h.slice(text.length);
    }
    return "";
  }

  /** History entries starting with `prefix`, newest first (↑/↓ navigation). */
  historyMatches(prefix: string): string[] {
    return this.history.filter((h) => h.startsWith(prefix)).reverse();
  }

  /** History entries containing `query`, newest first (⌃R search). */
  searchHistory(query: string): Item[] {
    const q = query.toLowerCase();
    const out: Item[] = [];
    for (let i = this.history.length - 1; i >= 0 && out.length < 200; i--) {
      const h = this.history[i];
      if (h.toLowerCase().includes(q)) out.push({ insert: h, label: h.replace(/\n/g, " ⏎ "), kind: "hist", open: true });
    }
    return out;
  }

  async complete(text: string, caret: number, cwd: string): Promise<Completion> {
    const before = text.slice(0, caret);
    const tokens = this.lex(before);
    const last = tokens[tokens.length - 1];
    const typingWord = last && last.end === caret && last.kind !== "operator";
    const start = typingWord ? last.start : caret;
    const word = typingWord ? last.raw : "";

    // Words of the current command segment before the word being completed.
    const segment: string[] = [];
    for (const t of typingWord ? tokens.slice(0, -1) : tokens) {
      if (t.kind === "operator") segment.length = 0;
      else if (t.kind !== "assign") segment.push(t.raw);
    }
    const commandPosition = segment.length === 0 || COMMAND_PREFIXES.has(segment[segment.length - 1]);

    const items = await this.itemsFor(word, segment, commandPosition, cwd);
    return { start, end: caret, items };
  }

  private async itemsFor(word: string, segment: string[], commandPosition: boolean, cwd: string): Promise<Item[]> {
    const lower = word.toLowerCase();
    const matching = (names: string[], kind: ItemKind): Item[] =>
      names.filter((n) => n.toLowerCase().startsWith(lower)).map((n) => ({ insert: n, label: n, kind }));
    const paths = async (dirsOnly = false): Promise<Item[]> =>
      (await api.completePath(cwd, word, dirsOnly)).map((p) => ({
        insert: p.insert,
        label: p.label,
        kind: p.dir ? "dir" : "file",
        open: p.dir,
      }));

    if (commandPosition) {
      if (word.includes("/") || word.startsWith(".") || word.startsWith("~")) return paths();
      return matching(this.commands, "cmd").slice(0, 80);
    }
    const [cmd, sub] = segment;
    if (cmd === "git") {
      if (segment.length === 1) return matching(GIT_SUBCOMMANDS, "sub");
      if (GIT_REF_SUBCOMMANDS.has(sub)) return [...matching(await api.gitRefs(cwd), "git"), ...(await paths())];
    }
    if ((cmd === "npm" || cmd === "bun") && sub === "run" && segment.length === 2) {
      return matching(await api.npmScripts(cwd), "script");
    }
    if ((cmd === "yarn" || cmd === "pnpm") && (segment.length === 1 || (sub === "run" && segment.length === 2))) {
      return matching(await api.npmScripts(cwd), "script");
    }
    return paths(DIR_COMMANDS.has(cmd));
  }
}
