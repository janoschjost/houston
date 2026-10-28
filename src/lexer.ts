// Minimal shell lexer: enough to highlight the input line and find the word under the caret.

export type TokKind = "command" | "unknown" | "flag" | "string" | "variable" | "operator" | "assign" | "arg";

export interface Token {
  start: number;
  end: number;
  raw: string;
  kind: TokKind;
}

const OPERATORS = ["&&", "||", "|&", ";;", "|", ";", "&", "(", ")"];
/** Words after which the next word is again a command (`sudo git …`). */
export const COMMAND_PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command", "builtin", "nice", "watch", "xargs"]);

function operatorAt(text: string, i: number): string | undefined {
  return OPERATORS.find((op) => text.startsWith(op, i));
}

/** `isCommand` returns undefined while the command list is still loading (no red marking then). */
export function lex(text: string, isCommand: (word: string) => boolean | undefined): Token[] {
  const tokens: Token[] = [];
  let expectCommand = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      expectCommand = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const op = operatorAt(text, i);
    if (op) {
      tokens.push({ start: i, end: i + op.length, raw: op, kind: "operator" });
      expectCommand = op !== ")";
      i += op.length;
      continue;
    }
    const start = i;
    let quote: string | null = null;
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "\\") {
        i++;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === " " || ch === "\t" || ch === "\n" || operatorAt(text, i)) {
        break;
      }
      i++;
    }
    const raw = text.slice(start, Math.min(i, text.length));
    let kind: TokKind;
    if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
      kind = "assign";
    } else if (expectCommand) {
      kind = isCommand(raw) === false ? "unknown" : "command";
      expectCommand = COMMAND_PREFIXES.has(raw);
    } else if (raw.startsWith("-")) {
      kind = "flag";
    } else if (raw.startsWith("'") || raw.startsWith('"')) {
      kind = "string";
    } else if (raw.startsWith("$")) {
      kind = "variable";
    } else {
      kind = "arg";
    }
    tokens.push({ start, end: start + raw.length, raw, kind });
  }
  return tokens;
}
