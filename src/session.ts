import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { api, type GitStatus, type ShellInfo } from "./api";
import type { Completer } from "./completion";
import { CommandInput } from "./input";

export type Kind = "claude" | "shell";
export type Status = "dormant" | "booting" | "idle" | "working" | "attention" | "exited";

export interface ProjectRec {
  id: string;
  path: string;
  name: string;
}

export interface SessionRec {
  id: string;
  projectId: string;
  kind: Kind;
  name: string;
  /** Name follows Claude Code's terminal title until the user renames the session. */
  autoName?: boolean;
  /** Claude Code conversation id, so the session can be resumed after a restart. */
  claudeId?: string;
  createdAt: number;
}

export interface SessionContext {
  shell: ShellInfo;
  completer: Completer;
  changed(): void;
  persist(): void;
  isSelected(s: Session): boolean;
}

const THEME: ITheme = {
  background: "#0B0E14",
  foreground: "#D5D8DE",
  cursor: "#6FA8DC",
  cursorAccent: "#0B0E14",
  selectionBackground: "#6FA8DC40",
  black: "#161C27", red: "#D77A7A", green: "#8FBF8F", yellow: "#D9B36C",
  blue: "#6FA8DC", magenta: "#B48EAD", cyan: "#86B8B8", white: "#D5D8DE",
  brightBlack: "#5C626D", brightRed: "#E39797", brightGreen: "#A8CFA8", brightYellow: "#E5C68F",
  brightBlue: "#99B9D9", brightMagenta: "#C8A6C2", brightCyan: "#A3CBCB", brightWhite: "#F0F2F5",
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function shortPath(path: string, home: string) {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export function uptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** One terminal session (Claude Code or shell): its PTY, xterm view, status tracking and pane DOM. */
export class Session {
  readonly el: HTMLElement;
  readonly term: Terminal;
  status: Status = "dormant";
  title = "";
  cwd: string;
  atPrompt = false;
  runningCommand = "";
  exitCode: number | null = null;
  launchedAt = 0;
  /** Git state of `cwd`, refreshed at every prompt; null outside a repository. */
  git: GitStatus | null = null;
  /** Set when work finished while nobody was watching; cleared once viewed. */
  needsAttention = false;

  private fit = new FitAddon();
  private input?: CommandInput;
  private termEl: HTMLElement;
  private stripEl: HTMLElement;
  private ptyId: string | null = null;
  private spawnCount = 0;
  private opened = false;
  private lastOutput = 0;
  private lastInput = 0;
  private workingSince: number | null = null;

  constructor(public rec: SessionRec, public project: ProjectRec, private ctx: SessionContext) {
    this.cwd = project.path;
    this.el = document.createElement("div");
    this.el.className = `pane kind-${rec.kind}`;
    this.el.dataset.id = rec.id;
    this.el.innerHTML = `<div class="pane-header"><span class="dot"></span><span class="pane-name"></span><span class="pane-title"></span></div><div class="pane-term"></div><div class="pane-footer"><div class="strip"></div></div>`;
    this.termEl = this.el.querySelector(".pane-term")!;
    this.stripEl = this.el.querySelector(".strip")!;

    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      // Integrated shells type into the command input at the prompt; xterm only shows a cursor while a command runs.
      cursorInactiveStyle: this.integrated ? "none" : "outline",
      macOptionIsMeta: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.onData((d) => this.typed(d));
    this.term.onBinary((d) => this.typed(d));
    this.term.onTitleChange((t) => {
      this.title = t;
      this.adoptTitle(t);
      this.ctx.changed();
    });
    this.term.onResize(({ cols, rows }) => this.ptyId && api.resize(this.ptyId, cols, rows));
    this.term.parser.registerOscHandler(6973, (data) => this.onShellEvent(data));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey) return false; // app shortcuts and menu clipboard
      if (e.type !== "keydown" || e.key !== "Enter") return true;
      if (this.status === "exited") {
        this.launch();
        return false;
      }
      // Shift+Enter inserts a newline in Claude Code's prompt.
      if (e.shiftKey && this.rec.kind === "claude") {
        this.typed("\x1b\r");
        return false;
      }
      return true;
    });

    if (this.integrated) {
      this.input = new CommandInput({
        completer: ctx.completer,
        cwd: () => this.cwd,
        submit: (cmd) => this.submit(cmd),
        sendControl: (seq) => this.typed(seq),
      });
      this.el.querySelector(".pane-footer")!.prepend(this.input.el);
      // ⌘C with nothing selected in the input copies the terminal selection instead.
      this.input.el.addEventListener("copy", (e) => {
        const ta = e.target as HTMLTextAreaElement;
        if (ta.selectionStart !== ta.selectionEnd || !this.term.hasSelection()) return;
        e.clipboardData?.setData("text/plain", this.term.getSelection());
        e.preventDefault();
      });
    }
    new ResizeObserver(() => this.fitSoon()).observe(this.termEl);
    this.el.querySelector(".pane-term")!.addEventListener("mousedown", () => setTimeout(() => this.focus()));
    this.render();
  }

  /** Names an auto-named Claude session after the topic Claude Code puts in the title ("✳ Fix login bug"). */
  private adoptTitle(title: string) {
    if (!this.rec.autoName) return;
    const topic = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (!topic || topic === "Claude Code" || topic === this.rec.name) return;
    this.rec.name = topic;
    this.render();
    this.ctx.persist();
  }

  get integrated() {
    return this.rec.kind === "shell" && this.ctx.shell.integrated;
  }

  get busy() {
    return this.status === "working" || (this.rec.kind === "shell" && !this.atPrompt && this.status !== "exited" && this.status !== "dormant");
  }

  /** Mounts the pane; opens the terminal and starts the process on first display. */
  attach(container: HTMLElement) {
    if (this.el.parentElement !== container) container.appendChild(this.el);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.termEl);
      // At the prompt the input owns the keyboard; bounce focus there if xterm grabs it.
      this.term.textarea?.addEventListener("focus", () => this.inputActive && this.input!.focus());
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose()); // falls back to the DOM renderer
        this.term.loadAddon(webgl);
      } catch {
        /* DOM renderer */
      }
    }
    this.fitSoon();
    if (this.status === "dormant") this.launch();
  }

  private fitSoon() {
    requestAnimationFrame(() => {
      if (this.opened && this.termEl.clientWidth > 0 && this.termEl.clientHeight > 0) this.fit.fit();
    });
  }

  /** True while the shell waits at its prompt and the command input, not the terminal, takes keystrokes. */
  private get inputActive() {
    return !!this.input && this.atPrompt && this.status !== "exited";
  }

  focus() {
    if (this.inputActive) this.input!.focus();
    else this.term.focus();
  }

  async launch() {
    if (this.ptyId) await api.kill(this.ptyId);
    const ptyId = `${this.rec.id}:${++this.spawnCount}`;
    this.ptyId = ptyId;
    this.status = "booting";
    this.exitCode = null;
    this.atPrompt = false;
    this.runningCommand = "";
    this.launchedAt = Date.now();
    this.render();
    this.ctx.changed();
    try {
      const { program, args, env } = await this.command();
      await api.spawn(
        { ptyId, program, args, env, cwd: this.project.path, cols: this.term.cols, rows: this.term.rows },
        (ev) => {
          if (this.ptyId !== ptyId) return; // output from a process we already replaced
          if (ev.kind === "data") {
            this.lastOutput = performance.now();
            this.term.write(ev.data);
          } else {
            this.exited(ev.code);
          }
        },
      );
    } catch (err) {
      this.term.write(`\r\n\x1b[31m✖ failed to launch: ${err}\x1b[0m\r\n`);
      this.exited(null);
    }
    if (this.ctx.isSelected(this)) this.focus();
  }

  private async command() {
    const { shell, integrationDir, userZdotdir } = this.ctx.shell;
    if (this.rec.kind === "shell") {
      const env: Record<string, string> = this.integrated ? { ZDOTDIR: integrationDir, HOUSTON_USER_ZDOTDIR: userZdotdir } : {};
      return { program: shell, args: ["-l"], env };
    }
    const id = this.rec.claudeId!;
    // Route the statusline through Houston so the sidebar can show plan usage limits.
    const settings = shellQuote(JSON.stringify({ statusLine: { type: "command", command: await api.claudeStatusLine() } }));
    const claude = (await api.claudeSessionExists(id))
      ? `exec claude --settings ${settings} --resume ${id}`
      : `exec claude --settings ${settings} --session-id ${id}${this.rec.autoName ? "" : ` -n ${shellQuote(this.rec.name)}`}`;
    // Interactive login shell so PATH and the user's environment match their normal terminal.
    return { program: shell, args: ["-l", "-i", "-c", claude], env: {} };
  }

  private exited(code: number | null) {
    this.ptyId = null;
    this.status = "exited";
    this.exitCode = code;
    this.term.write(`\r\n\x1b[38;2;86;100;138m── process exited${code === null ? "" : ` [${code}]`} · press ⏎ to relaunch ──\x1b[0m\r\n`);
    this.render();
    this.ctx.changed();
    if (this.ctx.isSelected(this)) this.term.focus();
  }

  private typed(data: string) {
    if (!this.ptyId) return;
    this.lastInput = performance.now();
    api.write(this.ptyId, data);
  }

  private submit(command: string) {
    // Multi-line commands go in as one bracketed paste so zsh treats them as a single edit.
    this.typed(command.includes("\n") ? `\x1b[200~${command}\x1b[201~\r` : command + "\r");
  }

  /** OSC 6973 events from the zsh integration: prompt;<status> | exec;<cmd> | cwd;<path>. */
  private onShellEvent(data: string) {
    const sep = data.indexOf(";");
    const event = sep < 0 ? data : data.slice(0, sep);
    const arg = sep < 0 ? "" : data.slice(sep + 1);
    if (event === "cwd") {
      // Sent at every prompt, so this also picks up commits, checkouts and edits.
      this.cwd = arg;
      api.gitStatus(arg).then((git) => {
        if (this.cwd !== arg) return; // a later prompt moved elsewhere
        this.git = git;
        this.render();
      });
    } else if (event === "prompt") {
      this.atPrompt = true;
      this.runningCommand = "";
    } else if (event === "exec") {
      this.atPrompt = false;
      this.runningCommand = arg.split("\n")[0];
    }
    this.render();
    this.ctx.changed();
    if (event !== "cwd" && this.ctx.isSelected(this)) this.focus();
    return true;
  }

  /** Called on the app tick. Returns true when the session just finished work nobody was watching. */
  tick(now: number, watched: boolean): boolean {
    if (this.status === "dormant" || this.status === "exited") return false;
    const busy =
      this.rec.kind === "claude"
        ? // Claude animates while working and is quiet while waiting; ignore echo of our own keystrokes.
          now - this.lastOutput < 1200 && this.lastOutput - this.lastInput > 350
        : this.integrated && !this.atPrompt && this.status !== "booting";
    let finished = false;
    if (busy) {
      this.workingSince ??= now;
    } else if (this.workingSince !== null) {
      const minimum = this.rec.kind === "claude" ? 2000 : 3000;
      finished = !watched && now - this.workingSince > minimum;
      if (finished) this.needsAttention = true;
      this.workingSince = null;
    }
    if (watched) this.needsAttention = false;
    const booting = this.status === "booting" && (this.rec.kind === "claude" ? this.lastOutput === 0 : !this.atPrompt && this.integrated);
    this.status = booting ? "booting" : busy ? "working" : this.needsAttention ? "attention" : "idle";
    this.render();
    return finished;
  }

  /** Header and footer strip for the current state. */
  render() {
    this.el.dataset.status = this.status;
    this.el.querySelector(".pane-name")!.textContent = this.rec.name;
    this.el.querySelector(".pane-title")!.textContent = this.title || shortPath(this.cwd, this.ctx.shell.home);
    const showInput = this.inputActive;
    this.term.options.disableStdin = showInput;
    this.input?.el.classList.toggle("hidden", !showInput);
    this.input?.setContext(this.contextHtml());
    this.stripEl.classList.toggle("hidden", showInput);
    let html: string;
    if (this.status === "exited") {
      html = `<span class="s-exit">Exited${this.exitCode === null ? "" : ` (${this.exitCode})`}</span><button class="relaunch" data-action="relaunch">Relaunch ⏎</button>`;
    } else if (this.rec.kind === "shell" && this.integrated) {
      html = this.status === "booting"
        ? `<span class="s-dim">Launching shell…</span>`
        : `<span class="s-run">⟫ RUNNING</span><code>${escapeHtml(this.runningCommand)}</code><span class="s-dim right">⌃C interrupt</span>`;
    } else {
      const label = { dormant: "Pre-launch", booting: "Launching…", idle: "Standby", working: "Working", attention: "Awaiting go", exited: "" }[this.status];
      const id = this.rec.claudeId ? `SID ${this.rec.claudeId.slice(0, 8)}` : this.rec.kind.toUpperCase();
      html = `<span class="s-${this.status}">${label}</span><span class="s-dim">${escapeHtml(shortPath(this.cwd, this.ctx.shell.home))}</span><span class="s-dim">${id}</span><span class="s-dim right">${this.launchedAt ? uptime(Date.now() - this.launchedAt) : ""}</span>`;
    }
    if (this.stripEl.innerHTML !== html) this.stripEl.innerHTML = html;
  }

  /** Directory and git summary shown above the command input. */
  private contextHtml() {
    let html = `<span class="ctx-dir">${escapeHtml(shortPath(this.cwd, this.ctx.shell.home))}</span>`;
    const g = this.git;
    if (!g) return html;
    const dirty = g.staged + g.modified + g.untracked > 0;
    html += `<span class="ctx-branch${dirty ? " dirty" : ""}">⎇ ${escapeHtml(g.branch)}</span>`;
    const marks: [number, string, string][] = [
      [g.ahead, "↑", "ahead"], [g.behind, "↓", "behind"],
      [g.staged, "+", "staged"], [g.modified, "~", "modified"], [g.untracked, "?", "untracked"],
    ];
    for (const [n, glyph, cls] of marks) {
      if (n > 0) html += `<span class="ctx-${cls}" title="${n} ${cls}">${glyph}${n}</span>`;
    }
    return html;
  }

  clear() {
    this.term.clear();
  }

  dispose() {
    if (this.ptyId) api.kill(this.ptyId);
    this.ptyId = null;
    this.term.dispose();
    this.el.remove();
  }
}
