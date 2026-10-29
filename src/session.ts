import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { api, type GitStatus, type SessionStats, type ShellInfo } from "./api";
import type { Completer } from "./completion";
import { icon, light } from "./icons";
import { CommandInput } from "./input";

export type Kind = "claude" | "shell";
export type Status = "dormant" | "booting" | "idle" | "working" | "attention" | "exited";

export const STATUS_LABEL: Record<Status, string> = {
  dormant: "Pre-launch", booting: "Launching…", idle: "Standby", working: "Working", attention: "Awaiting go", exited: "Exited",
};

export interface ProjectRec {
  id: string;
  path: string;
  name: string;
  /** Accent that marks the project's sessions in the sidebar and panes. */
  color: string;
  /** Sessions are hidden in the sidebar behind a one-line summary. */
  collapsed?: boolean;
}

/** Project accents, assigned in order to new projects; hues chosen to stay apart from status colours. */
export const PROJECT_COLORS = ["#8cc8f0", "#eba582", "#c3a6e8", "#86cfd6", "#d6b46a", "#a9b8ff", "#9fd3a8", "#ec9cc0"];

/** Project colours saved before the rev D palette, mapped onto their replacements by position. */
const OLD_PROJECT_COLORS = ["#6fa8dc", "#d4977a", "#a39bc4", "#86b8b8", "#c8a65c", "#b48ead", "#8fbf8f", "#d98ab0"];

/** A saved project colour in the current palette; colours from the old palette move to their replacement. */
export function currentProjectColor(color: string) {
  const i = OLD_PROJECT_COLORS.indexOf(color);
  return i < 0 ? color : PROJECT_COLORS[i];
}

/** First palette colour no project uses yet, cycling once all are taken. */
export function nextProjectColor(projects: ProjectRec[]) {
  const used = new Set(projects.map((p) => p.color));
  return PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
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
  /** Left out of the grid and parked in its dock. */
  collapsed?: boolean;
}

export interface SessionContext {
  shell: ShellInfo;
  completer: Completer;
  changed(): void;
  persist(): void;
  isSelected(s: Session): boolean;
}

/** Cmd/Option editing shortcuts that xterm would otherwise drop or encode as unusable CSI sequences. */
const EDIT_KEYS: Record<string, string> = {
  "cmd+Backspace": "\x15", // kill to line start
  "cmd+ArrowLeft": "\x01", // line start
  "cmd+ArrowRight": "\x05", // line end
  "alt+ArrowLeft": "\x1bb", // word back
  "alt+ArrowRight": "\x1bf", // word forward
  "alt+Backspace": "\x17", // delete word back
  "alt+Delete": "\x1bd", // delete word forward
};

/** Terminal palette built from the style.css tokens. */
const THEME: ITheme = {
  background: "#0d0f1200", // transparent: the pane's translucent fill and the backdrop show through
  foreground: "#e3e7ed",
  cursor: "#8CC8F0",
  cursorAccent: "#0d0f12",
  selectionBackground: "#8CC8F040",
  black: "#1a1e24", red: "#F08A83", green: "#8FD8B4", yellow: "#F3C86F",
  blue: "#8CC8F0", magenta: "#C3A6E8", cyan: "#86CFD6", white: "#e3e7ed",
  brightBlack: "#5f6875", brightRed: "#F6A8A2", brightGreen: "#AEE5CA", brightYellow: "#F7D896",
  brightBlue: "#B3DBF6", brightMagenta: "#D6C2F0", brightCyan: "#A9DEE3", brightWhite: "#f5f7fa",
};

const SEARCH: ISearchOptions = {
  decorations: {
    matchBackground: "#343b46", matchOverviewRuler: "#8cc8f0",
    activeMatchBackground: "#7a6230", activeMatchColorOverviewRuler: "#f3c86f",
  },
};

/** Terminal rows that are Claude Code's own chrome (input box, hints, mode line), not conversation. */
const CLAUDE_CHROME = /^(\? for shortcuts|esc to|ctrl\+|shift\+tab|⏵|>|❯|\d+\.\s|bypass permissions|accept edits|auto-accept|plan mode)/i;

/** Text of a terminal row without the box drawing and markers around it. */
const cleanRow = (row: string) => row.replace(/^[\s│┃╭╰╮╯─━⎿⏺●✻✳✽·*]+/, "").replace(/[\s│┃╮╯─━]+$/, "");

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function shortPath(path: string, home: string) {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** Cost and context share for a Claude session, e.g. "$0.42 · ctx 38%"; empty until reported. */
export function statsLabel(stats?: SessionStats) {
  const parts: string[] = [];
  if (stats?.cost_usd != null) parts.push(`$${stats.cost_usd.toFixed(2)}`);
  if (stats?.context_percent != null) parts.push(`ctx ${Math.round(stats.context_percent)}%`);
  return parts.join(" · ");
}

export function uptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** Hex colour as the "r;g;b" part of a 24-bit SGR colour. */
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");

/** Hex colour as a 24-bit SGR foreground escape. */
const fg = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;

/** Truecolor fg/bg SGR parameters: prefix, then r, g, b. */
const TRUECOLOR = /([34]8;2;)(\d{1,3});(\d{1,3});(\d{1,3})(?=[;m])/g;

/** Hue (degrees), saturation and lightness (0–1) of an RGB colour. */
function toHsl(r: number, g: number, b: number): [number, number, number] {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}

/** HSL back to "r;g;b". */
function fromHsl(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `${f(0)};${f(8)};${f(4)}`;
}

/** Lightness of Claude Code's brand orange, rgb(215,119,87); its shimmer and fades are measured against it. */
const CLAUDE_L = toHsl(215, 119, 87)[2];

/**
 * Maps a colour in Claude's orange family (mascot, prompt, spinner and its shimmer) onto the project accent,
 * keeping how much lighter or darker it is than the brand orange. Other colours return null.
 */
function accentFor(r: number, g: number, b: number, accent: [number, number, number]) {
  const [h, s, l] = toHsl(r, g, b);
  if (h < 5 || h > 30 || s < 0.4) return null;
  return fromHsl(accent[0], accent[1], Math.min(0.95, Math.max(0.05, accent[2] + l - CLAUDE_L)));
}
/** An escape sequence cut off at the end of a chunk, possibly still holding a colour. */
const PARTIAL_CSI = /\x1b(\[[\d;:]*)?$/;

/**
 * Houston's mark as a pixel grid for the terminal banner, two pixels per cell: ink ring, planet shaded in
 * the project accent, and the coral satellite at 45° with a halo cutting the ring, as on an idle light.
 */
function markArt(color: string) {
  const [h, s, l] = toHsl(...(rgb(color).split(";").map(Number) as [number, number, number]));
  const shade = (dl: number) => fromHsl(h, s, Math.min(0.9, Math.max(0.1, l + dl)));
  // A half-block pixel is about 1.24 times taller than wide at 13px with line height 1.15, so x is stretched.
  const ASPECT = 1.24, W = 21, H = 16, cx = 10, cy = 7.5, R = 6.6;
  const ring = rgb(color);
  const sx = R * Math.SQRT1_2, sy = cy - R * Math.SQRT1_2;
  const pixel = (x: number, y: number) => {
    const dx = (x - cx) / ASPECT;
    const d = Math.hypot(dx, y - cy), ds = Math.hypot(dx - sx, y - sy);
    if (ds < 1.3) return rgb("#eba582");
    if (ds < 2.4) return null;
    if (d < 3.3) return shade(dx + y < cy - 1 ? 0.12 : dx + y > cy + 1 ? -0.18 : 0);
    if (Math.abs(d - R) < 0.7) return ring;
    return null;
  };
  const rows: string[] = [];
  for (let y = 0; y < H; y += 2) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const t = pixel(x, y), b = pixel(x, y + 1);
      if (!t && !b) row += " ";
      else if (t === b) row += `\x1b[38;2;${t}m█`;
      else if (!t) row += `\x1b[38;2;${b}m▄`;
      else if (!b) row += `\x1b[38;2;${t}m▀`;
      else row += `\x1b[38;2;${t};48;2;${b}m▀\x1b[49m`;
    }
    rows.push(row);
  }
  return rows;
}

/** Banner printed into a new terminal before its process starts: the mark plus a launch readout. */
function banner(rec: SessionRec, project: ProjectRec, home: string) {
  const dim = fg("#5f6875"), title = fg("#8cc8f0"), text = fg("#e3e7ed"), reset = "\x1b[0m";
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fit = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
  const art = markArt(project.color);
  const info = [
    "",
    `${title}H O U S T O N   ${dim}MISSION CONTROL`,
    `${dim}${"─".repeat(26)}`,
    `${dim}FLIGHT  ${text}${fit(rec.name)}`,
    `${dim}CRAFT   ${text}${rec.kind === "claude" ? "CC · claude code" : "SH · shell"}`,
    `${dim}PAD     ${text}${fit(shortPath(project.path, home))}`,
    `${dim}T-0     ${text}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${dim}· all stations go`,
  ];
  return "\r\n" + art.map((a, i) => `${a}   ${info[i] ?? ""}${reset}`).join("\r\n") + "\r\n\r\n";
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
  /** Run once at the first shell prompt, e.g. an ssh alias opened from the alias palette. */
  startCommand?: string;
  /** Set when work finished while nobody was watching; cleared once viewed. */
  needsAttention = false;
  /** What a waiting Claude session last said or asked, read off the screen when it stopped. */
  waitingFor = "";
  /** First message for a new Claude conversation, sent as its opening prompt. */
  prompt?: string;
  /** Usage Claude Code reports for this conversation. */
  stats?: SessionStats;

  private fit = new FitAddon();
  private search = new SearchAddon();
  private searchEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private input?: CommandInput;
  private termEl: HTMLElement;
  private stripEl: HTMLElement;
  private ptyId: string | null = null;
  private spawnCount = 0;
  private opened = false;
  private lastOutput = 0;
  private lastInput = 0;
  private workingSince: number | null = null;
  /** Tail of the previous Claude output chunk, held back until its escape sequence completes. */
  private carry = "";

  constructor(public rec: SessionRec, public project: ProjectRec, private ctx: SessionContext) {
    this.cwd = project.path;
    this.el = document.createElement("div");
    this.el.className = `pane kind-${rec.kind}`;
    this.el.dataset.id = rec.id;
    this.el.style.setProperty("--proj", project.color);
    this.el.innerHTML = `<div class="pane-header">${light(rec.kind, STATUS_LABEL.dormant)}<span class="pane-name"></span><span class="pane-title"></span><button class="pane-min" data-action="collapse" title="Collapse to dock">${icon("collapse")}</button><button class="pane-max" data-action="maximize" title="Focus this session (⌘G)">${icon("focus")}</button></div><div class="pane-search hidden" role="search"><input placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find in terminal" /><span class="ps-count"></span><button data-find="prev" title="Previous (⇧⏎)">↑</button><button data-find="next" title="Next (⏎)">↓</button><button data-find="close" title="Close (esc)">${icon("close")}</button></div><div class="pane-term"></div><div class="pane-footer"><div class="strip"></div></div>`;
    this.termEl = this.el.querySelector(".pane-term")!;
    this.stripEl = this.el.querySelector(".strip")!;
    this.searchEl = this.el.querySelector(".pane-search")!;
    this.searchInput = this.searchEl.querySelector("input")!;

    this.term = new Terminal({
      fontFamily: '"IBM Plex Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      // Integrated shells type into the command input at the prompt; xterm only shows a cursor while a command runs.
      cursorInactiveStyle: this.integrated ? "none" : "outline",
      macOptionIsMeta: true,
      allowProposedApi: true,
      scrollback: 10000,
      allowTransparency: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.loadAddon(this.search);
    this.bindSearch();
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
      // macOS line/word editing keys, sent as the readline sequences every shell and Claude Code's prompt understand.
      const edit = !e.ctrlKey && !e.shiftKey && EDIT_KEYS[`${e.metaKey ? "cmd" : e.altKey ? "alt" : ""}+${e.key}`];
      if (edit) {
        if (e.type === "keydown") this.typed(edit);
        return false;
      }
      if (e.metaKey) return false; // app shortcuts and menu clipboard
      if (e.type !== "keydown" || e.key !== "Enter") return true;
      if (this.status === "exited") {
        this.launch();
        return false;
      }
      // Shift+Enter inserts a newline in Claude Code's prompt; a bare LF (ctrl+J) works in every terminal setup.
      if (e.shiftKey && this.rec.kind === "claude") {
        e.preventDefault();
        this.typed("\n");
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
    if (document.activeElement === this.searchInput) return;
    if (this.inputActive) this.input!.focus();
    else this.term.focus();
  }

  async launch() {
    if (this.ptyId) await api.kill(this.ptyId);
    if (this.spawnCount === 0) this.term.write(banner(this.rec, this.project, this.ctx.shell.home));
    const ptyId = `${this.rec.id}:${++this.spawnCount}`;
    this.ptyId = ptyId;
    this.status = "booting";
    this.exitCode = null;
    this.atPrompt = false;
    this.runningCommand = "";
    this.carry = "";
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
            this.term.write(this.rec.kind === "claude" ? this.recolor(ev.data) : ev.data);
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

  /** Paints Claude Code's orange tones in the project accent; holds back a split escape sequence until the next chunk. */
  private recolor(data: string) {
    data = this.carry + data;
    const cut = data.search(PARTIAL_CSI);
    this.carry = cut < 0 ? "" : data.slice(cut);
    const accent = toHsl(...(rgb(this.project.color).split(";").map(Number) as [number, number, number]));
    return (cut < 0 ? data : data.slice(0, cut)).replace(TRUECOLOR, (m, pre, r, g, b) => {
      const mapped = accentFor(+r, +g, +b, accent);
      return mapped ? pre + mapped : m;
    });
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
      : `exec claude --settings ${settings} --session-id ${id}${this.rec.autoName ? "" : ` -n ${shellQuote(this.rec.name)}`}${this.prompt ? ` -- ${shellQuote(this.prompt)}` : ""}`;
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
      if (this.startCommand) {
        this.submit(this.startCommand);
        this.startCommand = undefined;
      }
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
    if (finished && this.rec.kind === "claude") this.waitingFor = this.lastWords();
    if (this.status !== "attention") this.waitingFor = "";
    this.render();
    return finished;
  }

  /** Header and footer strip for the current state. */
  render() {
    this.el.dataset.status = this.status;
    const st = this.el.querySelector<SVGElement>(".pane-header .st")!;
    st.setAttribute("aria-label", STATUS_LABEL[this.status]);
    st.querySelector("title")!.textContent = STATUS_LABEL[this.status];
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
      const label = STATUS_LABEL[this.status];
      const id = this.rec.claudeId ? `SID ${this.rec.claudeId.slice(0, 8)}` : this.rec.kind.toUpperCase();
      const stats = statsLabel(this.stats);
      html = `<span class="s-${this.status}">${label}</span><span class="s-dim">${escapeHtml(shortPath(this.cwd, this.ctx.shell.home))}</span><span class="s-dim">${id}</span>${stats ? `<span class="s-stats" title="${escapeHtml(this.stats?.model ?? "")}">${stats}</span>` : ""}<span class="s-dim right">${this.launchedAt ? uptime(Date.now() - this.launchedAt) : ""}</span>`;
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

  /**
   * Claude's question or latest message, read bottom-up from the screen: a line ending in "?" wins
   * (prefixed with the tool call it is about), otherwise the first line of the last ⏺ message.
   */
  private lastWords() {
    const buf = this.term.buffer.active;
    const bottom = buf.baseY + this.term.rows - 1;
    let question = "";
    for (let y = bottom; y >= Math.max(0, bottom - 80); y--) {
      const raw = buf.getLine(y)?.translateToString(true) ?? "";
      const text = cleanRow(raw);
      if (!text || CLAUDE_CHROME.test(raw.replace(/^[\s│┃]+/, ""))) continue;
      if (raw.trimStart().startsWith("⏺")) {
        if (!question) return text.slice(0, 160);
        return (/^[\w .-]+\(/.test(text) ? `${text} — ${question}` : question).slice(0, 160);
      }
      if (!question && text.endsWith("?")) question = text;
    }
    return question.slice(0, 160);
  }

  openSearch() {
    this.searchEl.classList.remove("hidden");
    this.searchInput.focus();
    this.searchInput.select();
  }

  private closeSearch() {
    this.searchEl.classList.add("hidden");
    this.search.clearDecorations();
    this.term.clearSelection();
    this.focus();
  }

  private find(backwards: boolean, incremental = false) {
    const term = this.searchInput.value;
    if (!term) {
      this.search.clearDecorations();
      this.searchEl.querySelector(".ps-count")!.textContent = "";
      return;
    }
    if (backwards) this.search.findPrevious(term, SEARCH);
    else this.search.findNext(term, { ...SEARCH, incremental });
  }

  private bindSearch() {
    const count = this.searchEl.querySelector(".ps-count")!;
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = !resultCount ? "no results" : resultIndex < 0 ? `${resultCount}+` : `${resultIndex + 1}/${resultCount}`;
    });
    this.searchInput.addEventListener("input", () => this.find(false, true));
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.find(e.shiftKey);
      else if (e.key === "Escape") this.closeSearch();
      else return;
      e.preventDefault();
    });
    this.searchEl.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("[data-find]")?.dataset.find;
      if (action === "close") this.closeSearch();
      else if (action) this.find(action === "prev");
    });
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
