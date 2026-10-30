import { icon, light } from "./icons";
import type { Kind } from "./session";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Command {
  label: string;
  /** Secondary text, also matched by the filter. */
  detail?: string;
  /** Shortcut shown on the right. */
  hint?: string;
  /** Accent for the label, e.g. a project colour. */
  color?: string;
  /** Section the command is listed under while the filter is empty. */
  group?: string;
  /** Marks a session: its status light is drawn before the label. */
  session?: { kind: Kind; status: string };
  /** Text shown under the list while this command is highlighted, e.g. a session's latest terminal lines. */
  preview?: () => string;
  run(): unknown;
}

/** How well `query` matches `text`: prefix beats substring beats in-order letters; -1 for no match. */
function score(text: string, query: string) {
  const t = text.toLowerCase();
  if (t.startsWith(query)) return 3;
  if (t.includes(query)) return 2;
  let i = 0;
  for (const ch of t) if (ch === query[i]) i++;
  return i === query.length ? 1 : -1;
}

/** ⌘P overlay: fuzzy-jump to a session, project or action. */
export class CommandPalette {
  readonly el: HTMLElement;
  private commands: Command[] = [];
  private shown: Command[] = [];
  private index = 0;
  private filterEl: HTMLInputElement;
  private listEl: HTMLElement;
  private previewEl: HTMLElement;

  /** `closed` runs whenever the palette closes, e.g. to give the terminal its focus back. */
  constructor(private closed: () => void) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop hidden";
    this.el.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette">
      <div class="pal-head"><input class="pal-filter" placeholder="Jump to session, project or action…" spellcheck="false" autocomplete="off" aria-label="Filter commands" /></div>
      <div class="pal-list" role="listbox"></div>
      <pre class="pal-preview hidden"></pre>
      <div class="pal-foot"><span><kbd>⏎</kbd> run</span><span><kbd>↑↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>
    </div>`;
    this.filterEl = this.el.querySelector(".pal-filter")!;
    this.listEl = this.el.querySelector(".pal-list")!;
    this.previewEl = this.el.querySelector(".pal-preview")!;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.filterEl.addEventListener("input", () => {
      this.index = 0;
      this.render();
    });
    this.listEl.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
      if (this.shown[i]) this.run(this.shown[i]);
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  open(commands: Command[]) {
    this.commands = commands;
    this.el.classList.remove("hidden");
    this.filterEl.value = "";
    this.index = 0;
    this.render();
    this.filterEl.focus();
  }

  close() {
    this.el.classList.add("hidden");
    this.closed();
  }

  private render() {
    const q = this.filterEl.value.trim().toLowerCase();
    this.shown = q
      ? this.commands
          .map((c) => ({ c, s: Math.max(score(c.label, q), score(`${c.label} ${c.detail ?? ""}`, q) - 0.5) }))
          .filter((m) => m.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((m) => m.c)
      : this.commands;
    this.index = Math.min(this.index, Math.max(0, this.shown.length - 1));
    let group: string | undefined;
    this.listEl.innerHTML = this.shown.length
      ? this.shown
          .map((c, i) => {
            // Sections only while browsing; a filtered list is ranked, so headings would be noise.
            const head = !q && c.group && c.group !== group ? `<div class="pal-group">${escapeHtml(c.group)}</div>` : "";
            group = c.group;
            const swatch = c.color ? `<i class="pal-swatch" style="--proj: ${c.color}"></i>` : "";
            const status = c.session ? `<span class="pal-light" data-status="${c.session.status}">${light(c.session.kind)}</span>` : "";
            return `${head}<div class="pal-row cmd-row${i === this.index ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === this.index}">
              <span class="pal-name"${c.color ? ` style="color: ${c.color}"` : ""}>${status}${c.session ? "" : swatch}<span class="pal-label">${escapeHtml(c.label)}</span></span>
              <span class="pal-cmd">${escapeHtml(c.detail ?? "")}</span>
              ${c.hint ? `<kbd>${c.hint}</kbd>` : ""}
            </div>`;
          })
          .join("")
      : `<div class="pal-empty">Nothing matches</div>`;
    const preview = this.shown[this.index]?.preview?.() ?? "";
    this.previewEl.textContent = preview;
    this.previewEl.classList.toggle("hidden", !preview);
    this.listEl.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  private run(c: Command) {
    this.close();
    c.run();
  }

  private onKey(e: KeyboardEvent) {
    // Keys stay inside the palette so app shortcuts and terminals don't react underneath.
    e.stopPropagation();
    const move = (d: number) => {
      e.preventDefault();
      if (!this.shown.length) return;
      this.index = (this.index + d + this.shown.length) % this.shown.length;
      this.render();
    };
    if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "p")) {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" && this.shown[this.index]) {
      e.preventDefault();
      this.run(this.shown[this.index]);
    }
  }
}

/** Small dialog for a new Claude agent's opening prompt. Resolves to the prompt ("" for none), or null if cancelled. */
export class BriefDialog {
  readonly el: HTMLElement;
  private textEl: HTMLTextAreaElement;
  private resolve?: (prompt: string | null) => void;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop hidden";
    this.el.innerHTML = `<div class="palette brief" role="dialog" aria-label="New Claude agent">
      <div class="brief-head">${icon("agent")} New agent in <span class="brief-proj"></span></div>
      <textarea rows="4" placeholder="Mission brief: what should this agent do? Leave empty to start a blank session." spellcheck="false" aria-label="Opening prompt"></textarea>
      <div class="pal-foot"><span><kbd>⏎</kbd> launch</span><span><kbd>⇧⏎</kbd> newline</span><span><kbd>esc</kbd> cancel</span></div>
    </div>`;
    this.textEl = this.el.querySelector("textarea")!;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.finish(null));
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.finish(null);
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.finish(this.textEl.value.trim());
      }
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  ask(projectName: string, color: string): Promise<string | null> {
    this.resolve?.(null);
    const proj = this.el.querySelector<HTMLElement>(".brief-proj")!;
    proj.textContent = projectName;
    proj.style.color = color;
    this.textEl.value = "";
    this.el.classList.remove("hidden");
    this.textEl.focus();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private finish(prompt: string | null) {
    this.el.classList.add("hidden");
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(prompt);
  }
}

export interface MenuItem {
  label: string;
  hint?: string;
  run(): unknown;
}

/** Right-click menu; `null` entries are separators. Closes on any outside click, Escape or blur. */
export class ContextMenu {
  readonly el: HTMLElement;
  private items: (MenuItem | null)[] = [];

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ctx-menu hidden";
    this.el.setAttribute("role", "menu");
    this.el.addEventListener("click", (e) => {
      const item = this.items[Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i)];
      if (!item) return;
      this.close();
      item.run();
    });
    window.addEventListener("mousedown", (e) => !this.el.contains(e.target as Node) && this.close(), true);
    window.addEventListener("keydown", (e) => e.key === "Escape" && this.isOpen && this.close(), true);
    window.addEventListener("blur", () => this.close());
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  show(x: number, y: number, items: (MenuItem | null)[]) {
    this.items = items;
    this.el.innerHTML = items
      .map((it, i) => (it ? `<button data-i="${i}" role="menuitem"><span>${escapeHtml(it.label)}</span>${it.hint ? `<kbd>${it.hint}</kbd>` : ""}</button>` : `<hr>`))
      .join("");
    this.el.classList.remove("hidden");
    const { width, height } = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
    this.el.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
  }

  close() {
    this.el.classList.add("hidden");
  }
}
