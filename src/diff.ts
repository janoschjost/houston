import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { icon } from "./icons";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lines rendered per file; the rest of a very large diff is cut off. */
const MAX_LINES = 4000;

interface FileDiff {
  path: string;
  status: "added" | "deleted" | "renamed" | "modified";
  added: number;
  removed: number;
  binary: boolean;
  /** Hunk lines, from the first "@@". */
  lines: string[];
}

/** Splits `git diff` output into files. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const start = lines.findIndex((l) => l.startsWith("@@"));
    const header = start < 0 ? lines : lines.slice(0, start);
    const field = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const strip = (p?: string) => (p && p !== "/dev/null" ? p.replace(/^[ab]\//, "") : undefined);
    const path = field("rename to ") ?? strip(field("+++ ")) ?? strip(field("--- ")) ?? lines[0].replace(/^a\/(.*) b\/.*$/, "$1");
    const hunks = lines.slice(header.length).filter((l, i, all) => l || i < all.length - 1);
    files.push({
      path,
      status: field("new file") !== undefined ? "added" : field("deleted file") !== undefined ? "deleted" : field("rename to ") ? "renamed" : "modified",
      added: hunks.filter((l) => l.startsWith("+")).length,
      removed: hunks.filter((l) => l.startsWith("-")).length,
      binary: header.some((l) => l.startsWith("Binary files")),
      lines: hunks,
    });
  }
  return files;
}

const STATUS_MARK = { added: "A", deleted: "D", renamed: "R", modified: "M" };

/** Overlay showing a project's uncommitted changes: file list on the left, the selected file's diff on the right. */
export class DiffPanel {
  readonly el: HTMLElement;
  private files: FileDiff[] = [];
  private index = 0;
  private cwd = "";
  private listEl: HTMLElement;
  private bodyEl: HTMLElement;
  private titleEl: HTMLElement;
  /** The file being edited in place, with its text as loaded; null while reading diffs. */
  private editing: { path: string; original: string; area: HTMLTextAreaElement } | null = null;

  /** `closed` runs whenever the panel closes, e.g. to give the terminal its focus back. */
  constructor(private closed: () => void) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop diff-backdrop hidden";
    this.el.innerHTML = `<div class="diff" role="dialog" aria-label="Changes">
      <div class="diff-head"><span class="diff-title"></span><button data-refresh title="Refresh">${icon("refresh")}</button><button data-close title="Close (esc)">${icon("close")}</button></div>
      <div class="diff-main"><div class="diff-files" role="listbox"></div><div class="diff-body"></div></div>
    </div>`;
    this.listEl = this.el.querySelector(".diff-files")!;
    this.bodyEl = this.el.querySelector(".diff-body")!;
    this.titleEl = this.el.querySelector(".diff-title")!;
    this.el.tabIndex = -1;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.el.querySelector("[data-refresh]")!.addEventListener("click", () => this.load());
    this.listEl.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
      if (!Number.isNaN(i)) this.go(i);
    });
    this.bodyEl.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("[data-edit]")?.dataset.edit;
      if (action === "start") this.startEdit();
      else if (action === "save") this.save();
      else if (action === "cancel") this.cancelEdit();
    });
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (this.editing) {
        if (e.key === "Escape") this.cancelEdit();
        else if (e.key === "s" && e.metaKey) this.save();
        else if (e.key === "Tab" && !e.shiftKey) document.execCommand("insertText", false, "  ");
        else return;
        e.preventDefault();
        return;
      }
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (e.key === "Escape") this.close();
      else if (step && this.files.length) this.go((this.index + step + this.files.length) % this.files.length);
      else return;
      e.preventDefault();
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  async open(name: string, cwd: string, color: string) {
    this.cwd = cwd;
    this.titleEl.innerHTML = `<span style="color: ${color}">${escapeHtml(name)}</span> <span class="c-dim">· uncommitted changes</span>`;
    this.el.classList.remove("hidden");
    this.el.focus();
    this.index = 0;
    await this.load();
  }

  async close() {
    if (!(await this.discardable())) return;
    this.editing = null;
    this.el.classList.add("hidden");
    this.closed();
  }

  private get dirty() {
    return !!this.editing && this.editing.area.value !== this.editing.original;
  }

  /** True when no unsaved edit would be lost, or the user agrees to lose it. */
  private async discardable() {
    return !this.dirty || ask(`Discard unsaved edits to ${this.editing!.path}?`, { title: "Houston", kind: "warning", okLabel: "Discard" });
  }

  private async go(index: number) {
    if (index === this.index && !this.editing) return;
    if (!(await this.discardable())) return;
    this.editing = null;
    this.show(index);
  }

  /** Swaps the diff for an editable copy of the whole file, scrolled to its first change. */
  private async startEdit() {
    const f = this.files[this.index];
    if (!f || f.binary || f.status === "deleted") return;
    try {
      const text = await api.readProjectFile(this.cwd, f.path);
      const area = document.createElement("textarea");
      area.className = "diff-edit";
      area.spellcheck = false;
      area.value = text;
      this.editing = { path: f.path, original: text, area };
      this.bodyEl.innerHTML = `<div class="diff-bar"><span class="c-dim">Editing ${escapeHtml(f.path)}</span><button data-edit="cancel">Cancel <kbd>esc</kbd></button><button data-edit="save" class="primary">Save <kbd>⌘S</kbd></button></div>`;
      this.bodyEl.appendChild(area);
      const first = Number(f.lines.find((l) => l.startsWith("@@"))?.match(/\+(\d+)/)?.[1] ?? 1);
      const offset = text.split("\n").slice(0, Math.max(0, first - 1)).join("\n").length;
      area.focus();
      area.setSelectionRange(offset, offset);
      area.scrollTop = Math.max(0, first - 4) * parseFloat(getComputedStyle(area).lineHeight || "17");
    } catch (e) {
      this.bodyEl.insertAdjacentHTML("afterbegin", `<div class="pal-empty">${escapeHtml(String(e))}</div>`);
    }
  }

  private async save() {
    if (!this.editing) return;
    const { path, area } = this.editing;
    try {
      await api.writeProjectFile(this.cwd, path, area.value);
    } catch (e) {
      this.bodyEl.querySelector(".diff-bar .c-dim")!.textContent = `Save failed: ${e}`;
      return;
    }
    this.editing = null;
    await this.load();
  }

  private cancelEdit() {
    if (!this.editing) return;
    this.discardable().then((ok) => {
      if (!ok) return;
      this.editing = null;
      this.show(this.index);
      this.el.focus();
    });
  }

  private async load() {
    const path = this.files[this.index]?.path;
    this.listEl.innerHTML = `<div class="pal-empty">Reading diff…</div>`;
    this.bodyEl.innerHTML = "";
    try {
      this.files = parseDiff(await api.gitDiff(this.cwd));
    } catch (e) {
      this.files = [];
      this.listEl.innerHTML = `<div class="pal-empty">${escapeHtml(String(e))}</div>`;
      return;
    }
    if (!this.files.length) {
      this.listEl.innerHTML = `<div class="pal-empty">Working tree clean</div>`;
      return;
    }
    this.show(Math.max(0, this.files.findIndex((f) => f.path === path)));
  }

  private show(index: number) {
    this.index = index;
    this.listEl.innerHTML = this.files
      .map((f, i) => {
        const slash = f.path.lastIndexOf("/") + 1;
        return `<div class="diff-file${i === index ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === index}" title="${escapeHtml(f.path)}">
          <span class="df-mark df-${f.status}">${STATUS_MARK[f.status]}</span>
          <span class="df-path"><span class="c-dim">${escapeHtml(f.path.slice(0, slash))}</span>${escapeHtml(f.path.slice(slash))}</span>
          <span class="df-add">${f.added ? `+${f.added}` : ""}</span><span class="df-del">${f.removed ? `−${f.removed}` : ""}</span>
        </div>`;
      })
      .join("");
    this.listEl.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
    const f = this.files[index];
    const cls = (l: string) => (l.startsWith("@@") ? "dl-hunk" : l.startsWith("+") ? "dl-add" : l.startsWith("-") ? "dl-del" : l.startsWith("\\") ? "dl-note" : "");
    const body = f.binary
      ? `<div class="pal-empty">Binary file</div>`
      : f.lines
          .slice(0, MAX_LINES)
          .map((l) => `<div class="${cls(l)}">${escapeHtml(l) || " "}</div>`)
          .join("") + (f.lines.length > MAX_LINES ? `<div class="dl-note">… ${f.lines.length - MAX_LINES} more lines</div>` : "");
    const editable = !f.binary && f.status !== "deleted";
    this.bodyEl.innerHTML = `${editable ? `<div class="diff-bar"><span class="c-dim">${escapeHtml(f.path)}</span><button data-edit="start">Edit file</button></div>` : ""}<pre>${body}</pre>`;
    this.bodyEl.scrollTop = 0;
  }
}
